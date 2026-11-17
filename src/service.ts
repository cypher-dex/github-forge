// The forge's operations, shared by REST, GraphQL and MCP so every surface acts on the same objects.

import { EMPTY_TREE_OID, isOid, isTreeMode } from './git/objects.ts';
import {
  ApiError,
  branchTip,
  createCommit,
  diffTrees,
  isAncestor,
  lookupPath,
  mergeBase,
  mergeTrees,
  nodeId,
  putObject,
  readCommit,
  resolveCommitish,
  setRef,
  tipOf,
  validRefName,
  writePath,
} from './store.ts';
import type { Comment, FileChange, Issue, Label, Pull, Repo, Store } from './store.ts';

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(422, `Invalid request.\n\n"${field}" wasn't supplied.`, [{ resource: 'Field', field, code: 'missing_field' }]);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class Forge {
  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // ---------------------------------------------------------------- repositories

  requireRepo(owner: string, name: string): Repo {
    const repo = this.store.repo(owner, name);
    if (repo === null) throw new ApiError(404, 'Not Found');
    return repo;
  }

  createRepo(input: Record<string, unknown>): Repo {
    const name = requireString(input.name, 'name');
    if (!NAME_RE.test(name) || name === '.' || name === '..') {
      throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
    }
    if (this.store.repos.has(name.toLowerCase())) {
      throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
    }
    const isPrivate = input.private === true || input.visibility === 'private';
    const repo = this.store.createRepo(name, optionalString(input.description), isPrivate);
    if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
    if (input.has_issues === false) repo.hasIssues = false;
    if (input.auto_init === true) {
      const readme = Buffer.from(`# ${name}\n${repo.description === null ? '' : `\n${repo.description}\n`}`, 'utf8');
      const blob = putObject(repo, 'blob', readme);
      const tree = writePath(repo, null, ['README.md'], { mode: '100644', oid: blob });
      setRef(repo, `refs/heads/${repo.defaultBranch}`, createCommit(repo, this.store, tree, [], 'Initial commit'));
    }
    return repo;
  }

  updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
    if (typeof input.name === 'string' && input.name !== repo.name) {
      if (!NAME_RE.test(input.name)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', field: 'name', code: 'invalid' }]);
      if (this.store.repos.has(input.name.toLowerCase())) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
      this.store.repos.delete(repo.name.toLowerCase());
      repo.name = input.name;
      this.store.repos.set(repo.name.toLowerCase(), repo);
    }
    if ('description' in input) repo.description = optionalString(input.description);
    if (typeof input.private === 'boolean') repo.private = input.private;
    if (input.visibility === 'private' || input.visibility === 'public') repo.private = input.visibility === 'private';
    if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
    if (typeof input.default_branch === 'string') {
      if (repo.refs.size > 0 && branchTip(repo, input.default_branch) === null) {
        throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', field: 'default_branch', code: 'invalid' }]);
      }
      repo.defaultBranch = input.default_branch;
    }
    repo.updatedAt = this.store.now();
    for (const issue of repo.issues.values()) issue.cache = null;
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.store.repos.delete(repo.name.toLowerCase());
  }

  // ---------------------------------------------------------------- refs

  createRef(repo: Repo, ref: unknown, sha: unknown): string {
    const name = requireString(ref, 'ref');
    const oid = requireString(sha, 'sha').toLowerCase();
    if (!validRefName(name) || name.split('/').length < 3) throw new ApiError(422, 'Reference name is not valid');
    if (repo.refs.has(name)) throw new ApiError(422, 'Reference already exists');
    if (!isOid(oid) || !repo.objects.has(oid)) throw new ApiError(422, 'Object does not exist');
    setRef(repo, name, oid);
    return name;
  }

  updateRef(repo: Repo, ref: string, sha: unknown, force: boolean): void {
    const current = repo.refs.get(ref);
    if (current === undefined) throw new ApiError(422, 'Reference does not exist');
    const oid = requireString(sha, 'sha').toLowerCase();
    if (!repo.objects.has(oid)) throw new ApiError(422, 'Object does not exist');
    if (!force && !isAncestor(repo, current, oid)) throw new ApiError(422, 'Update is not a fast forward');
    setRef(repo, ref, oid);
  }

  deleteRef(repo: Repo, ref: string): void {
    if (!repo.refs.has(ref)) throw new ApiError(422, 'Reference does not exist');
    setRef(repo, ref, null);
  }

  // ---------------------------------------------------------------- contents

  /** The branch a contents write lands on: the named one (created from the default when missing) or the default. */
  private branchFor(repo: Repo, branch: unknown): string {
    const name = typeof branch === 'string' && branch !== '' ? branch : repo.defaultBranch;
    if (branchTip(repo, name) === null && repo.refs.size > 0) {
      const fallback = branchTip(repo, repo.defaultBranch);
      if (fallback === null) throw new ApiError(404, `Branch ${name} not found`);
      setRef(repo, `refs/heads/${name}`, fallback);
    }
    return name;
  }

  putContent(repo: Repo, path: string, input: Record<string, unknown>): { created: boolean; blob: string; size: number; commit: string } {
    const message = requireString(input.message, 'message');
    if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '' || clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) throw new ApiError(422, 'path is invalid');
    const data = Buffer.from(input.content, 'base64');
    const branch = this.branchFor(repo, input.branch);
    const tip = tipOf(repo, branch);
    const existing = tip.tree === null ? null : lookupPath(repo, tip.tree, clean);
    if (existing !== null && isTreeMode(existing.mode)) throw new ApiError(422, `path ${clean} is a directory`);
    const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
    if (existing !== null && sha === null) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (existing !== null && sha !== existing.oid) throw new ApiError(409, `${clean} does not match ${sha}`);
    if (existing === null && sha !== null && tip.commit !== null) throw new ApiError(409, `${clean} does not match ${sha}`);
    const blob = putObject(repo, 'blob', data);
    const tree = writePath(repo, tip.tree, clean.split('/'), { mode: existing?.mode ?? '100644', oid: blob });
    const commit = createCommit(repo, this.store, tree, tip.commit === null ? [] : [tip.commit], message);
    setRef(repo, `refs/heads/${branch}`, commit);
    return { created: existing === null, blob, size: data.length, commit };
  }

  deleteContent(repo: Repo, path: string, input: Record<string, unknown>): string {
    const message = requireString(input.message, 'message');
    const sha = requireString(input.sha, 'sha').toLowerCase();
    const clean = path.replace(/^\/+|\/+$/g, '');
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const tip = tipOf(repo, branch);
    const existing = tip.tree === null ? null : lookupPath(repo, tip.tree, clean);
    if (existing === null || isTreeMode(existing.mode)) throw new ApiError(404, 'Not Found');
    if (existing.oid !== sha) throw new ApiError(409, `${clean} does not match ${sha}`);
    const tree = writePath(repo, tip.tree, clean.split('/'), null);
    const commit = createCommit(repo, this.store, tree, [tip.commit!], message);
    setRef(repo, `refs/heads/${branch}`, commit);
    return commit;
  }

  /** The commit a read names: `ref` (a branch, tag or sha) or the default branch. */
  commitFor(repo: Repo, ref: string | null): string {
    const commit = resolveCommitish(repo, ref ?? repo.defaultBranch);
    if (commit === null) throw new ApiError(404, ref === null ? 'This repository is empty.' : `No commit found for the ref ${ref}`);
    return commit;
  }

  // ---------------------------------------------------------------- labels and issues

  createLabel(repo: Repo, input: Record<string, unknown>): Label {
    const name = requireString(input.name, 'name');
    if (repo.labels.has(name.toLowerCase())) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
    }
    const id = this.store.id();
    const color = typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color) ? input.color.replace('#', '').toLowerCase() : 'ededed';
    const label: Label = { id, nodeId: nodeId('LA', `label:${id}`), name, color, description: optionalString(input.description) };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  private labelNames(repo: Repo, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ApiError(422, 'Invalid request.\n\nFor \'properties/labels\', it is not an array.');
    const names: string[] = [];
    for (const entry of value) {
      const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && 'name' in entry ? entry.name : undefined;
      if (typeof name !== 'string') throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', field: 'name', code: 'invalid' }]);
      const label = repo.labels.get(name.toLowerCase());
      if (label === undefined) {
        throw new ApiError(422, `Validation Failed: label "${name}" does not exist`, [{ resource: 'Label', code: 'invalid', field: 'name', value: name }]);
      }
      if (!names.includes(label.name)) names.push(label.name);
    }
    return names;
  }

  private nextNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  createIssue(repo: Repo, input: Record<string, unknown>): Issue {
    const title = requireString(input.title, 'title');
    if (!repo.hasIssues) throw new ApiError(410, 'Issues are disabled for this repo');
    const labels = this.labelNames(repo, input.labels);
    const now = this.store.now();
    const id = this.store.id();
    const number = this.nextNumber(repo);
    const assignees = Array.isArray(input.assignees) ? input.assignees.filter((entry): entry is string => typeof entry === 'string') : [];
    const issue: Issue = {
      id,
      nodeId: nodeId('I', `issue:${repo.id}:${number}`),
      number,
      title,
      body: optionalString(input.body),
      state: 'open',
      stateReason: null,
      labels,
      assignees,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      cache: null,
      cacheHost: '',
    };
    repo.issues.set(number, issue);
    return issue;
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new ApiError(404, 'Not Found');
    return issue;
  }

  updateIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): Issue {
    if (typeof input.title === 'string') issue.title = input.title;
    if ('body' in input) issue.body = optionalString(input.body);
    if ('labels' in input) issue.labels = this.labelNames(repo, input.labels);
    if (Array.isArray(input.assignees)) issue.assignees = input.assignees.filter((entry): entry is string => typeof entry === 'string');
    const now = this.store.now();
    if (input.state === 'closed' && issue.state === 'open') {
      issue.state = 'closed';
      issue.closedAt = now;
      issue.stateReason = typeof input.state_reason === 'string' ? input.state_reason : 'completed';
    } else if (input.state === 'open' && issue.state === 'closed') {
      issue.state = 'open';
      issue.closedAt = null;
      issue.stateReason = 'reopened';
    } else if (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', field: 'state', code: 'invalid' }]);
    }
    issue.updatedAt = now;
    issue.cache = null;
    return issue;
  }

  /** A comment on an issue or a pull request (they share numbers, as on GitHub). */
  addComment(repo: Repo, number: number, body: unknown): Comment {
    const text = requireString(body, 'body');
    const target = repo.issues.get(number) ?? repo.pulls.get(number);
    if (target === undefined) throw new ApiError(404, 'Not Found');
    const now = this.store.now();
    const id = this.store.id();
    const comment: Comment = { id, nodeId: nodeId('IC', `comment:${repo.id}:${number}:${id}`), body: text, createdAt: now, updatedAt: now };
    target.comments.push(comment);
    target.updatedAt = now;
    if ('cache' in target) target.cache = null;
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, input: Record<string, unknown>): Pull {
    const title = requireString(input.title, 'title');
    const head = requireString(input.head, 'head').replace(/^[^:]+:/, '');
    const base = typeof input.base === 'string' && input.base !== '' ? input.base : repo.defaultBranch;
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
    if (baseSha === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
    if (head === base) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }]);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${this.store.viewer}:${head}.` }]);
      }
    }
    const now = this.store.now();
    const id = this.store.id();
    const number = this.nextNumber(repo);
    const pull: Pull = {
      id,
      nodeId: nodeId('PR', `pull:${repo.id}:${number}`),
      number,
      title,
      body: optionalString(input.body),
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      draft: input.draft === true,
      labels: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  requirePull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new ApiError(404, 'Not Found');
    return pull;
  }

  /** The live head and base tips of an open pull, or the frozen ones of a closed pull. */
  pullTips(repo: Repo, pull: Pull): { head: string; base: string } {
    if (pull.state === 'closed') return { head: pull.headSha, base: pull.baseSha };
    return { head: branchTip(repo, pull.head) ?? pull.headSha, base: branchTip(repo, pull.base) ?? pull.baseSha };
  }

  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const tips = this.pullTips(repo, pull);
    const baseCommit = pull.merged ? pull.baseSha : (mergeBase(repo, tips.base, tips.head) ?? tips.base);
    const fromTree = readCommit(repo, baseCommit)?.tree ?? null;
    const toTree = readCommit(repo, tips.head)?.tree ?? null;
    return diffTrees(repo, fromTree, toTree);
  }

  /** The commits a pull carries: reachable from its head and not from its base. */
  pullCommits(repo: Repo, pull: Pull): string[] {
    const tips = this.pullTips(repo, pull);
    const seen = new Set<string>();
    const stack = [tips.base];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of readCommit(repo, oid)?.parents ?? []) stack.push(parent);
    }
    const out: string[] = [];
    const walk = [tips.head];
    const visited = new Set<string>();
    while (walk.length > 0) {
      const oid = walk.pop()!;
      if (seen.has(oid) || visited.has(oid)) continue;
      visited.add(oid);
      out.push(oid);
      for (const parent of readCommit(repo, oid)?.parents ?? []) walk.push(parent);
    }
    return out.reverse();
  }

  /** The merged tree of an open pull, or null when it conflicts. */
  private mergedTree(repo: Repo, pull: Pull): { tree: string | null; base: string; head: string } {
    const tips = this.pullTips(repo, pull);
    const ancestor = mergeBase(repo, tips.base, tips.head);
    const baseTree = readCommit(repo, tips.base)?.tree ?? EMPTY_TREE_OID;
    const headTree = readCommit(repo, tips.head)?.tree ?? EMPTY_TREE_OID;
    if (ancestor === tips.base) return { tree: headTree, base: tips.base, head: tips.head };
    const ancestorTree = ancestor === null ? null : (readCommit(repo, ancestor)?.tree ?? null);
    return { tree: mergeTrees(repo, ancestorTree, baseTree, headTree), base: tips.base, head: tips.head };
  }

  mergeable(repo: Repo, pull: Pull): boolean | null {
    if (pull.state === 'closed') return null;
    return this.mergedTree(repo, pull).tree !== null;
  }

  mergePull(repo: Repo, pull: Pull, input: Record<string, unknown>): { sha: string; message: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
    const merged = this.mergedTree(repo, pull);
    if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== merged.head) {
      throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
    }
    if (merged.tree === null) throw new ApiError(405, 'Pull Request is not mergeable: merge conflict');
    const method = typeof input.merge_method === 'string' ? input.merge_method.toLowerCase() : 'merge';
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'merge_method', code: 'invalid' }]);
    }
    const title = typeof input.commit_title === 'string' && input.commit_title !== ''
      ? input.commit_title
      : method === 'merge' ? `Merge pull request #${pull.number} from ${this.store.viewer}/${pull.head}` : `${pull.title} (#${pull.number})`;
    const detail = typeof input.commit_message === 'string' && input.commit_message !== '' ? `\n\n${input.commit_message}` : '';
    const parents = method === 'merge' ? [merged.base, merged.head] : [merged.base];
    const sha = createCommit(repo, this.store, merged.tree, parents, `${title}${detail}`);
    setRef(repo, `refs/heads/${pull.base}`, sha);
    const now = this.store.now();
    pull.headSha = merged.head;
    pull.baseSha = merged.base;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = sha;
    return { sha, message: 'Pull Request successfully merged' };
  }

  updatePull(repo: Repo, pull: Pull, input: Record<string, unknown>): Pull {
    if (typeof input.title === 'string') pull.title = input.title;
    if ('body' in input) pull.body = optionalString(input.body);
    if (typeof input.base === 'string' && input.base !== pull.base) {
      if (branchTip(repo, input.base) === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
      pull.base = input.base;
    }
    const now = this.store.now();
    if (input.state === 'closed' && pull.state === 'open') {
      const tips = this.pullTips(repo, pull);
      pull.headSha = tips.head;
      pull.baseSha = tips.base;
      pull.state = 'closed';
      pull.closedAt = now;
    } else if (input.state === 'open' && pull.state === 'closed' && !pull.merged) {
      pull.state = 'open';
      pull.closedAt = null;
    }
    pull.updatedAt = now;
    return pull;
  }

  // ---------------------------------------------------------------- history

  /** Commits reachable from `start`, newest committer time first, optionally touching `path`. */
  log(repo: Repo, start: string, path: string | null, limit: number): string[] {
    const seen = new Set<string>([start]);
    const frontier = [start];
    const out: string[] = [];
    while (frontier.length > 0 && out.length < limit) {
      let best = 0;
      for (let index = 1; index < frontier.length; index += 1) {
        if ((readCommit(repo, frontier[index]!)?.committer.time ?? 0) > (readCommit(repo, frontier[best]!)?.committer.time ?? 0)) best = index;
      }
      const oid = frontier.splice(best, 1)[0]!;
      const commit = readCommit(repo, oid);
      if (commit === null) continue;
      if (path === null || this.touches(repo, oid, path)) out.push(oid);
      for (const parent of commit.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          frontier.push(parent);
        }
      }
    }
    return out;
  }

  private touches(repo: Repo, oid: string, path: string): boolean {
    const commit = readCommit(repo, oid)!;
    const mine = lookupPath(repo, commit.tree, path)?.oid ?? null;
    if (commit.parents.length === 0) return mine !== null;
    return commit.parents.some((parent) => {
      const parentTree = readCommit(repo, parent)?.tree;
      return (parentTree === undefined ? null : (lookupPath(repo, parentTree, path)?.oid ?? null)) !== mine;
    });
  }
}
