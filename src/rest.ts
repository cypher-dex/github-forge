// REST v3 under /api/v3: repositories, contents, git data, labels, issues, comments and pull requests.

import { encodeCommit, isOid, isTreeMode, parseTree } from './git/objects.ts';
import { errorReply, json } from './http.ts';
import type { Reply } from './http.ts';
import { ApiError, diffTrees, flattenTree, lookupPath, putObject, readCommit, readTree, treeFromFlat } from './store.ts';
import type { FlatEntry, Repo } from './store.ts';
import type { Forge } from './service.ts';
import {
  branchJson,
  commentJson,
  commitJson,
  contentJson,
  gitCommitJson,
  issueJson,
  issueBytes,
  labelJson,
  pullJson,
  refJson,
  repoJson,
  userJson,
} from './shapes.ts';
import type { Origin } from './shapes.ts';

type Body = Record<string, unknown>;

export interface RestRequest {
  method: string;
  /** The path after /api/v3, split on '/', empty segments dropped, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  origin: Origin;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function parseBody(raw: Buffer): Body {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError(400, 'Body should be a JSON object');
  return value as Body;
}

function positiveInt(text: string | undefined): number {
  if (text === undefined || !/^\d{1,15}$/.test(text)) throw new ApiError(404, 'Not Found');
  return Number(text);
}

function notFound(): never {
  throw new ApiError(404, 'Not Found');
}

/** One page of `items` with GitHub's Link header (per_page default 30, max 100). */
function page<T>(req: RestRequest, path: string, items: readonly T[], render: (item: T) => unknown): Reply {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const pageNumber = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
  const links: string[] = [];
  const linkTo = (target: number, rel: string): void => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    links.push(`<${req.origin.api}${path}?${params.toString()}>; rel="${rel}"`);
  };
  if (pageNumber < last) {
    linkTo(pageNumber + 1, 'next');
    linkTo(last, 'last');
  }
  if (pageNumber > 1) {
    linkTo(1, 'first');
    linkTo(pageNumber - 1, 'prev');
  }
  return json(200, slice.map(render), links.length > 0 ? { Link: links.join(', ') } : {});
}

function sortByDirection<T>(items: T[], key: (item: T) => number, direction: string | null, fallback: 'asc' | 'desc'): T[] {
  const sign = (direction ?? fallback) === 'asc' ? 1 : -1;
  return items.sort((a, b) => sign * (key(a) - key(b)));
}

export function handleRest(forge: Forge, req: RestRequest): Reply {
  try {
    return route(forge, req);
  } catch (err) {
    if (err instanceof ApiError) return errorReply(err.status, err.message, err.errors);
    throw err;
  }
}

function route(forge: Forge, req: RestRequest): Reply {
  const { method, segments } = req;
  const store = forge.store;
  const [first, second, third] = segments;
  if (first === 'repos' && second !== undefined && third !== undefined) return repoRoute(forge, req, forge.requireRepo(second, third), segments.slice(3));
  if (first === undefined && method === 'GET') return rootReply(req.origin);
  if (first === 'meta' && segments.length === 1 && method === 'GET') {
    return json(200, { verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], git: [], web: [], api: [] });
  }
  if (first === 'rate_limit' && method === 'GET') {
    const core = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
    return json(200, { resources: { core, graphql: core, search: core }, rate: core });
  }
  if (first === 'user' && segments.length === 1 && method === 'GET') {
    return json(200, { ...userJson(req.origin, store.viewer), name: store.viewerName, email: store.viewerEmail, public_repos: store.repos.size });
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'POST') return json(201, repoJson(store, req.origin, forge.createRepo(parseBody(req.rawBody))));
    if (method === 'GET') return listRepos(forge, req, '/user/repos');
  }
  if (first === 'users' && second !== undefined) {
    if (!store.owns(second)) notFound();
    if (segments.length === 2 && method === 'GET') return json(200, userJson(req.origin, store.viewer));
    if (third === 'repos' && segments.length === 3 && method === 'GET') return listRepos(forge, req, `/users/${second}/repos`);
  }
  notFound();
}

function rootReply(origin: Origin): Reply {
  const api = origin.api;
  return json(200, {
    current_user_url: `${api}/user`,
    repository_url: `${api}/repos/{owner}/{repo}`,
    user_repositories_url: `${api}/user/repos{?type,page,per_page,sort}`,
    issues_url: `${api}/issues`,
    meta_url: `${api}/meta`,
    rate_limit_url: `${api}/rate_limit`,
    graphql_url: `${origin.web}/api/graphql`,
  });
}

function listRepos(forge: Forge, req: RestRequest, path: string): Reply {
  const sort = req.query.get('sort') ?? 'full_name';
  const repos = [...forge.store.repos.values()];
  if (sort === 'full_name') {
    repos.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    if (req.query.get('direction') === 'desc') repos.reverse();
  } else {
    const key = sort === 'updated' ? (repo: Repo): number => repo.updatedAt : sort === 'pushed' ? (repo: Repo): number => repo.pushedAt : (repo: Repo): number => repo.createdAt;
    sortByDirection(repos, key, req.query.get('direction'), 'desc');
  }
  const visibility = req.query.get('visibility');
  const shown = visibility === 'private' || visibility === 'public' ? repos.filter((repo) => repo.private === (visibility === 'private')) : repos;
  return page(req, path, shown, (repo) => repoJson(forge.store, req.origin, repo));
}

// ---------------------------------------------------------------- /repos/{owner}/{repo}/...

function repoRoute(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): Reply {
  const { method } = req;
  const store = forge.store;
  const origin = req.origin;
  const [head, a, b, c] = rest;
  const base = `/repos/${store.viewer}/${repo.name}`;
  if (head === undefined) {
    if (method === 'GET') return json(200, repoJson(store, origin, repo));
    if (method === 'PATCH') return json(200, repoJson(store, origin, forge.updateRepo(repo, parseBody(req.rawBody))));
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204, headers: {}, body: '' };
    }
    notFound();
  }
  if (head === 'issues') {
    if (a === undefined) {
      if (method === 'GET') return listIssues(forge, req, repo, base);
      if (method === 'POST') return json(201, issueJson(origin, store, repo, forge.createIssue(repo, parseBody(req.rawBody))));
      notFound();
    }
    if (a === 'comments' && b !== undefined && rest.length === 3) return commentRoute(forge, req, repo, positiveInt(b));
    const number = positiveInt(a);
    if (b === undefined) {
      if (method === 'GET') {
        const issue = repo.issues.get(number);
        if (issue !== undefined) return { status: 200, headers: { 'Content-Type': JSON_TYPE }, body: issueBytes(origin, store, repo, issue) };
        if (repo.pulls.has(number)) return json(200, pullAsIssue(forge, req, repo, number));
        notFound();
      }
      if (method === 'PATCH') {
        const body = parseBody(req.rawBody);
        if (repo.pulls.has(number)) {
          forge.updatePull(repo, forge.requirePull(repo, number), body);
          return json(200, pullAsIssue(forge, req, repo, number));
        }
        return json(200, issueJson(origin, store, repo, forge.updateIssue(repo, forge.requireIssue(repo, number), body)));
      }
      notFound();
    }
    if (b === 'comments' && c === undefined) {
      const target = repo.issues.get(number) ?? repo.pulls.get(number) ?? notFound();
      if (method === 'GET') return page(req, `${base}/issues/${number}/comments`, target.comments, (comment) => commentJson(origin, store, repo, number, comment));
      if (method === 'POST') return json(201, commentJson(origin, store, repo, number, forge.addComment(repo, number, parseBody(req.rawBody).body)));
      notFound();
    }
    if (b === 'labels' && c === undefined) {
      const issue = forge.requireIssue(repo, number);
      if (method === 'POST' || method === 'PUT') {
        const body = parseBody(req.rawBody);
        const names = Array.isArray(body.labels) ? body.labels : [];
        const merged = method === 'PUT' ? names : [...issue.labels, ...names];
        forge.updateIssue(repo, issue, { labels: merged });
      }
      if (method === 'GET' || method === 'POST' || method === 'PUT') {
        return json(200, issue.labels.map((name) => labelJson(origin, store, repo, repo.labels.get(name.toLowerCase())!)));
      }
    }
    notFound();
  }
  if (head === 'pulls') return pullRoute(forge, req, repo, rest.slice(1), base);
  if (head === 'contents') return contentsRoute(forge, req, repo, rest.slice(1).join('/'));
  if (head === 'readme' && method === 'GET') {
    const ref = req.query.get('ref');
    const commit = forge.commitFor(repo, ref);
    const tree = readCommit(repo, commit)!.tree;
    const entry = readTree(repo, tree).find((candidate) => /^readme(\.|$)/i.test(candidate.name) && !isTreeMode(candidate.mode)) ?? notFound();
    const data = repo.objects.get(entry.oid)!.data;
    return json(200, contentJson(origin, store, repo, entry.name, { type: 'file', sha: entry.oid, size: data.length }, ref ?? repo.defaultBranch, data));
  }
  if (head === 'labels') {
    if (a === undefined) {
      if (method === 'GET') return page(req, `${base}/labels`, [...repo.labels.values()], (label) => labelJson(origin, store, repo, label));
      if (method === 'POST') return json(201, labelJson(origin, store, repo, forge.createLabel(repo, parseBody(req.rawBody))));
      notFound();
    }
    const label = repo.labels.get(rest.slice(1).join('/').toLowerCase()) ?? notFound();
    if (method === 'GET') return json(200, labelJson(origin, store, repo, label));
    if (method === 'DELETE') {
      repo.labels.delete(label.name.toLowerCase());
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.filter((name) => name !== label.name);
        issue.cache = null;
      }
      return { status: 204, headers: {}, body: '' };
    }
    if (method === 'PATCH') {
      const body = parseBody(req.rawBody);
      if (typeof body.color === 'string') label.color = body.color.replace('#', '');
      if ('description' in body) label.description = typeof body.description === 'string' ? body.description : null;
      for (const issue of repo.issues.values()) issue.cache = null;
      return json(200, labelJson(origin, store, repo, label));
    }
    notFound();
  }
  if (head === 'branches') {
    if (a === undefined && method === 'GET') {
      const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).sort(([x], [y]) => (x < y ? -1 : 1));
      return page(req, `${base}/branches`, branches, ([ref, oid]) => branchJson(origin, store, repo, ref.slice(11), oid));
    }
    if (method === 'GET') {
      const name = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${name}`) ?? notFound();
      return json(200, { ...branchJson(origin, store, repo, name, oid), commit: commitJson(origin, store, repo, oid), _links: { self: `${origin.api}${base}/branches/${name}` } });
    }
    notFound();
  }
  if (head === 'tags' && a === undefined && method === 'GET') {
    const tags = [...repo.refs].filter(([ref]) => ref.startsWith('refs/tags/')).sort(([x], [y]) => (x < y ? -1 : 1));
    return page(req, `${base}/tags`, tags, ([ref, oid]) => ({ name: ref.slice(10), commit: { sha: oid, url: `${origin.api}${base}/commits/${oid}` } }));
  }
  if (head === 'commits' && method === 'GET') {
    if (a === undefined) {
      const ref = req.query.get('sha');
      if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
      const start = forge.commitFor(repo, ref);
      const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
      const pageNumber = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
      const path = req.query.get('path');
      const oids = forge.log(repo, start, path === null || path === '' ? null : path.replace(/^\/+/, ''), perPage * pageNumber + 1);
      return page(req, `${base}/commits`, oids, (oid) => commitJson(origin, store, repo, oid));
    }
    const oid = forge.commitFor(repo, rest.slice(1).join('/'));
    const commit = readCommit(repo, oid)!;
    const parentTree = commit.parents.length > 0 ? (readCommit(repo, commit.parents[0]!)?.tree ?? null) : null;
    const changes = diffTrees(repo, parentTree, commit.tree);
    const additions = changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
    const files = changes.map((change) => ({ sha: change.oid, filename: change.path, status: change.status, additions: change.additions, deletions: change.deletions, changes: change.additions + change.deletions }));
    return json(200, { ...commitJson(origin, store, repo, oid), stats: { additions, deletions, total: additions + deletions }, files });
  }
  if (head === 'git') return gitDataRoute(forge, req, repo, rest.slice(1));
  notFound();
}

function pullAsIssue(forge: Forge, req: RestRequest, repo: Repo, number: number): Record<string, unknown> {
  const pull = forge.requirePull(repo, number);
  const store = forge.store;
  const summary = pullJson(req.origin, forge, repo, pull, false);
  const repoUrl = `${req.origin.api}/repos/${store.viewer}/${repo.name}`;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${repoUrl}/issues/${number}`,
    repository_url: repoUrl,
    html_url: `${req.origin.web}/${store.viewer}/${repo.name}/pull/${number}`,
    number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(req.origin, store.viewer),
    labels: [],
    assignees: [],
    comments: pull.comments.length,
    created_at: summary.created_at,
    pull_request: { url: `${repoUrl}/pulls/${number}`, merged_at: summary.merged_at },
  };
}

function listIssues(forge: Forge, req: RestRequest, repo: Repo, base: string): Reply {
  const state = req.query.get('state') ?? 'open';
  const labels = (req.query.get('labels') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
  let issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
  if (labels.length > 0) issues = issues.filter((issue) => labels.every((name) => issue.labels.some((label) => label.toLowerCase() === name)));
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction');
  const sign = (direction ?? 'desc') === 'asc' ? 1 : -1;
  const key = sort === 'updated' ? (issue: (typeof issues)[number]): number => issue.updatedAt : sort === 'comments' ? (issue: (typeof issues)[number]): number => issue.comments.length : (issue: (typeof issues)[number]): number => issue.createdAt;
  issues.sort((x, y) => sign * (key(x) - key(y) || x.number - y.number));
  return page(req, `${base}/issues`, issues, (issue) => issueJson(req.origin, forge.store, repo, issue));
}

function commentRoute(forge: Forge, req: RestRequest, repo: Repo, id: number): Reply {
  for (const holder of [...repo.issues.values(), ...repo.pulls.values()]) {
    const index = holder.comments.findIndex((comment) => comment.id === id);
    if (index < 0) continue;
    const comment = holder.comments[index]!;
    if (req.method === 'GET') return json(200, commentJson(req.origin, forge.store, repo, holder.number, comment));
    if (req.method === 'PATCH') {
      const body = parseBody(req.rawBody);
      if (typeof body.body === 'string') comment.body = body.body;
      comment.updatedAt = forge.store.now();
      return json(200, commentJson(req.origin, forge.store, repo, holder.number, comment));
    }
    if (req.method === 'DELETE') {
      holder.comments.splice(index, 1);
      if ('cache' in holder) holder.cache = null;
      return { status: 204, headers: {}, body: '' };
    }
  }
  notFound();
}

// ---------------------------------------------------------------- pulls

function pullRoute(forge: Forge, req: RestRequest, repo: Repo, rest: string[], base: string): Reply {
  const { method, origin } = req;
  const [a, b] = rest;
  if (a === undefined) {
    if (method === 'POST') return json(201, pullJson(origin, forge, repo, forge.createPull(repo, parseBody(req.rawBody)), true));
    if (method !== 'GET') notFound();
    const state = req.query.get('state') ?? 'open';
    const headFilter = req.query.get('head')?.replace(/^[^:]+:/, '') ?? null;
    const baseFilter = req.query.get('base');
    const pulls = [...repo.pulls.values()].filter((pull) => (state === 'all' || pull.state === state) && (headFilter === null || pull.head === headFilter) && (baseFilter === null || pull.base === baseFilter));
    const sort = req.query.get('sort') ?? 'created';
    const sign = (req.query.get('direction') ?? 'desc') === 'asc' ? 1 : -1;
    pulls.sort((x, y) => sign * ((sort === 'updated' ? x.updatedAt - y.updatedAt : x.createdAt - y.createdAt) || x.number - y.number));
    return page(req, `${base}/pulls`, pulls, (pull) => pullJson(origin, forge, repo, pull, false));
  }
  const pull = forge.requirePull(repo, positiveInt(a));
  if (b === undefined) {
    if (method === 'GET') return json(200, pullJson(origin, forge, repo, pull, true));
    if (method === 'PATCH') return json(200, pullJson(origin, forge, repo, forge.updatePull(repo, pull, parseBody(req.rawBody)), true));
    notFound();
  }
  if (b === 'files' && method === 'GET') {
    const files = forge.pullFiles(repo, pull);
    return page(req, `${base}/pulls/${pull.number}/files`, files, (change) => ({
      sha: change.oid,
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: `${origin.web}/${forge.store.viewer}/${repo.name}/blob/${forge.pullTips(repo, pull).head}/${change.path}`,
      raw_url: `${origin.web}/${forge.store.viewer}/${repo.name}/raw/${forge.pullTips(repo, pull).head}/${change.path}`,
      contents_url: `${origin.api}${base}/contents/${change.path}?ref=${forge.pullTips(repo, pull).head}`,
    }));
  }
  if (b === 'commits' && method === 'GET') {
    return page(req, `${base}/pulls/${pull.number}/commits`, forge.pullCommits(repo, pull), (oid) => commitJson(origin, forge.store, repo, oid));
  }
  if (b === 'merge') {
    if (method === 'GET') return pull.merged ? { status: 204, headers: {}, body: '' } : errorReply(404, 'Not Found');
    if (method === 'PUT') {
      const result = forge.mergePull(repo, pull, parseBody(req.rawBody));
      return json(200, { sha: result.sha, merged: true, message: result.message });
    }
  }
  if (b === 'comments' && method === 'GET') return json(200, []);
  if (b === 'reviews' && method === 'GET') return json(200, []);
  notFound();
}

// ---------------------------------------------------------------- contents

function entryType(mode: string): 'file' | 'dir' | 'submodule' | 'symlink' {
  if (isTreeMode(mode)) return 'dir';
  if (mode === '160000') return 'submodule';
  if (mode === '120000') return 'symlink';
  return 'file';
}

function contentsRoute(forge: Forge, req: RestRequest, repo: Repo, path: string): Reply {
  const { method, origin } = req;
  const store = forge.store;
  if (method === 'PUT') {
    const body = parseBody(req.rawBody);
    const result = forge.putContent(repo, path, body);
    const clean = path.replace(/^\/+|\/+$/g, '');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    return json(result.created ? 201 : 200, {
      content: { ...contentJson(origin, store, repo, clean, { type: 'file', sha: result.blob, size: result.size }, branch), encoding: 'base64' },
      commit: gitCommitJson(origin, store, repo, result.commit),
    });
  }
  if (method === 'DELETE') {
    const commit = forge.deleteContent(repo, path, parseBody(req.rawBody));
    return json(200, { content: null, commit: gitCommitJson(origin, store, repo, commit) });
  }
  if (method !== 'GET') notFound();
  const ref = req.query.get('ref');
  if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
  const commit = forge.commitFor(repo, ref === '' ? null : ref);
  const tree = readCommit(repo, commit)!.tree;
  const clean = path.replace(/^\/+|\/+$/g, '');
  const entry = lookupPath(repo, tree, clean) ?? notFound();
  const refName = ref ?? repo.defaultBranch;
  if (isTreeMode(entry.mode)) {
    const list = readTree(repo, entry.oid).map((child) => {
      const childPath = clean === '' ? child.name : `${clean}/${child.name}`;
      const size = isTreeMode(child.mode) ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0);
      return contentJson(origin, store, repo, childPath, { type: entryType(child.mode), sha: child.oid, size }, refName);
    });
    return json(200, list);
  }
  const data = repo.objects.get(entry.oid)?.data ?? notFound();
  return json(200, contentJson(origin, store, repo, clean, { type: entryType(entry.mode), sha: entry.oid, size: data.length }, refName, data));
}

// ---------------------------------------------------------------- git data

function gitDataRoute(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): Reply {
  const { method, origin } = req;
  const store = forge.store;
  const [kind, ...tail] = rest;
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    const suffix = tail.join('/');
    const full = suffix === '' ? '' : `refs/${suffix}`;
    if (kind === 'refs' && suffix === '' && method === 'POST') {
      const body = parseBody(req.rawBody);
      const ref = forge.createRef(repo, body.ref, body.sha);
      return json(201, refJson(origin, store, repo, ref, repo.refs.get(ref)!));
    }
    if (method === 'GET') {
      const exact = repo.refs.get(full);
      if (exact !== undefined && kind !== 'matching-refs') return json(200, refJson(origin, store, repo, full, exact));
      if (kind === 'ref') notFound();
      const matches = [...repo.refs].filter(([name]) => name.startsWith(full)).sort(([x], [y]) => (x < y ? -1 : 1));
      if (matches.length === 0 && kind === 'refs') notFound();
      return json(200, matches.map(([name, oid]) => refJson(origin, store, repo, name, oid)));
    }
    if (method === 'PATCH') {
      const body = parseBody(req.rawBody);
      forge.updateRef(repo, full, body.sha, body.force === true);
      return json(200, refJson(origin, store, repo, full, repo.refs.get(full)!));
    }
    if (method === 'DELETE') {
      forge.deleteRef(repo, full);
      return { status: 204, headers: {}, body: '' };
    }
    notFound();
  }
  const base = `${origin.api}/repos/${store.viewer}/${repo.name}/git`;
  if (kind === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      if (readCommit(repo, tail[0]!) === null) notFound();
      return json(200, gitCommitJson(origin, store, repo, tail[0]!));
    }
    if (method === 'POST' && tail.length === 0) {
      const body = parseBody(req.rawBody);
      const tree = typeof body.tree === 'string' ? body.tree : '';
      if (repo.objects.get(tree)?.type !== 'tree' && tree !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') throw new ApiError(422, 'Tree SHA does not exist');
      const parents = Array.isArray(body.parents) ? body.parents.filter((parent): parent is string => typeof parent === 'string') : [];
      for (const parent of parents) if (readCommit(repo, parent) === null) throw new ApiError(422, 'Parent SHA does not exist or is not a commit object');
      const ident = store.identity(store.now());
      const oid = putObject(repo, 'commit', encodeCommit({ tree, parents, author: ident, committer: ident, message: typeof body.message === 'string' ? body.message : '' }));
      return json(201, gitCommitJson(origin, store, repo, oid));
    }
  }
  if (kind === 'blobs') {
    if (method === 'GET' && tail.length === 1) {
      const object = repo.objects.get(tail[0]!);
      if (object === undefined || object.type !== 'blob') notFound();
      return json(200, { sha: tail[0], node_id: '', size: object.data.length, url: `${base}/blobs/${tail[0]}`, content: object.data.toString('base64'), encoding: 'base64' });
    }
    if (method === 'POST' && tail.length === 0) {
      const body = parseBody(req.rawBody);
      if (typeof body.content !== 'string') throw new ApiError(422, 'content is required');
      const data = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const oid = putObject(repo, 'blob', data);
      return json(201, { sha: oid, url: `${base}/blobs/${oid}` });
    }
  }
  if (kind === 'trees') {
    if (method === 'GET' && tail.length === 1) {
      const commit = readCommit(repo, tail[0]!);
      const treeOid = commit === null ? (resolveTree(forge, repo, tail[0]!) ?? notFound()) : commit.tree;
      const recursive = req.query.has('recursive');
      const entries: Array<Record<string, unknown>> = [];
      const walk = (oid: string, prefix: string): void => {
        for (const entry of readTree(repo, oid)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          const dir = isTreeMode(entry.mode);
          entries.push({ path, mode: dir ? '040000' : entry.mode, type: dir ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid, size: dir ? undefined : repo.objects.get(entry.oid)?.data.length, url: `${base}/${dir ? 'trees' : 'blobs'}/${entry.oid}` });
          if (dir && recursive) walk(entry.oid, path);
        }
      };
      walk(treeOid, '');
      return json(200, { sha: treeOid, url: `${base}/trees/${treeOid}`, tree: entries, truncated: false });
    }
    if (method === 'POST' && tail.length === 0) return json(201, createTree(repo, parseBody(req.rawBody), base));
  }
  if (kind === 'tags' && method === 'GET' && tail.length === 1) {
    const object = repo.objects.get(tail[0]!);
    if (object === undefined || object.type !== 'tag') notFound();
    return json(200, { sha: tail[0], data: object.data.toString('utf8') });
  }
  notFound();
}

function resolveTree(forge: Forge, repo: Repo, ref: string): string | null {
  if (repo.objects.get(ref)?.type === 'tree') return ref;
  const commit = isOid(ref) ? null : forge.commitFor(repo, ref);
  return commit === null ? null : readCommit(repo, commit)!.tree;
}

function createTree(repo: Repo, body: Body, base: string): Record<string, unknown> {
  if (!Array.isArray(body.tree)) throw new ApiError(422, 'tree is required');
  const files = new Map<string, { mode: string; oid: string | null }>();
  if (typeof body.base_tree === 'string' && body.base_tree !== '') {
    for (const [path, entry] of flattenTree(repo, body.base_tree)) files.set(path, entry);
  }
  for (const item of body.tree as unknown[]) {
    if (typeof item !== 'object' || item === null) throw new ApiError(422, 'tree entries must be objects');
    const path = 'path' in item && typeof item.path === 'string' ? item.path : '';
    const mode = 'mode' in item && typeof item.mode === 'string' ? item.mode : '100644';
    let oid = 'sha' in item && typeof item.sha === 'string' ? item.sha : null;
    if ('content' in item && typeof item.content === 'string') oid = putObject(repo, 'blob', Buffer.from(item.content, 'utf8'));
    files.set(path, { mode, oid });
  }
  const kept = new Map<string, FlatEntry>();
  for (const [path, entry] of files) if (entry.oid !== null) kept.set(path, { mode: entry.mode, oid: entry.oid });
  const oid = treeFromFlat(repo, kept);
  const tree = parseTree(repo.objects.get(oid)!.data).map((entry) => ({ path: entry.name, mode: entry.mode, type: isTreeMode(entry.mode) ? 'tree' : 'blob', sha: entry.oid, url: `${base}/${isTreeMode(entry.mode) ? 'trees' : 'blobs'}/${entry.oid}` }));
  return { sha: oid, url: `${base}/trees/${oid}`, tree, truncated: false };
}
