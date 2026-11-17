// GitHub's REST v3 object shapes, rendered for the origin a request arrived on.

import { isoOf } from './git/objects.ts';
import type { Ident } from './git/objects.ts';
import { nodeId, readCommit } from './store.ts';
import type { Comment, Issue, Label, Pull, Repo, Store } from './store.ts';
import type { Forge } from './service.ts';

/** Where a reply's URLs point: the web origin and its API root. */
export interface Origin {
  web: string;
  api: string;
}

export function originOf(host: string | undefined): Origin {
  const web = `http://${host ?? 'localhost'}`;
  return { web, api: `${web}/api/v3` };
}

export const iso = (seconds: number | null): string | null => (seconds === null ? null : isoOf(seconds));

export function userJson(origin: Origin, login: string): Record<string, unknown> {
  return {
    login,
    id: 1,
    node_id: nodeId('U', `user:${login}`),
    avatar_url: `${origin.web}/avatars/${login}`,
    gravatar_id: '',
    url: `${origin.api}/users/${login}`,
    html_url: `${origin.web}/${login}`,
    repos_url: `${origin.api}/users/${login}/repos`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(store: Store, origin: Origin, repo: Repo): Record<string, unknown> {
  const owner = store.viewer;
  const full = `${owner}/${repo.name}`;
  const url = `${origin.api}/repos/${full}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(origin, owner),
    html_url: `${origin.web}/${full}`,
    description: repo.description,
    fork: false,
    url,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    contents_url: `${url}/contents/{+path}`,
    branches_url: `${url}/branches{/branch}`,
    commits_url: `${url}/commits{/sha}`,
    git_refs_url: `${url}/git/refs{/sha}`,
    labels_url: `${url}/labels{/name}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.pushedAt),
    git_url: `git://${origin.web.slice(7)}/${full}.git`,
    ssh_url: `git@${origin.web.slice(7)}:${full}.git`,
    clone_url: `${origin.web}/${full}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: false,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
  };
}

export function labelJson(origin: Origin, store: Store, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.nodeId,
    url: `${origin.api}/repos/${store.viewer}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function labelsOf(origin: Origin, store: Store, repo: Repo, names: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) out.push(labelJson(origin, store, repo, label));
  }
  return out;
}

export function commentJson(origin: Origin, store: Store, repo: Repo, number: number, comment: Comment): Record<string, unknown> {
  const base = `${origin.api}/repos/${store.viewer}/${repo.name}`;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `${origin.web}/${store.viewer}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${number}`,
    body: comment.body,
    user: userJson(origin, store.viewer),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    author_association: 'OWNER',
  };
}

export function issueJson(origin: Origin, store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const repoUrl = `${origin.api}/repos/${store.viewer}/${repo.name}`;
  const url = `${repoUrl}/issues/${issue.number}`;
  const user = userJson(origin, store.viewer);
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url,
    repository_url: repoUrl,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${origin.web}/${store.viewer}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.stateReason,
    title: issue.title,
    body: issue.body,
    user,
    labels: labelsOf(origin, store, repo, issue.labels),
    assignee: issue.assignees.length > 0 ? userJson(origin, issue.assignees[0]!) : null,
    assignees: issue.assignees.map((login) => userJson(origin, login)),
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: iso(issue.closedAt),
    closed_by: issue.state === 'closed' ? user : null,
    author_association: 'OWNER',
    reactions: { url: `${url}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
  };
}

/** The serialized issue, memoized per origin until the issue next changes. */
export function issueText(origin: Origin, store: Store, repo: Repo, issue: Issue): string {
  if (issue.cache === null || issue.cacheHost !== origin.web) {
    issue.cache = JSON.stringify(issueJson(origin, store, repo, issue));
    issue.cacheHost = origin.web;
  }
  return issue.cache;
}

function branchRef(origin: Origin, store: Store, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${store.viewer}:${ref}`,
    ref,
    sha,
    user: userJson(origin, store.viewer),
    repo: repoJson(store, origin, repo),
  };
}

export function pullJson(origin: Origin, forge: Forge, repo: Repo, pull: Pull, detail: boolean): Record<string, unknown> {
  const store = forge.store;
  const repoUrl = `${origin.api}/repos/${store.viewer}/${repo.name}`;
  const url = `${repoUrl}/pulls/${pull.number}`;
  const html = `${origin.web}/${store.viewer}/${repo.name}/pull/${pull.number}`;
  const tips = forge.pullTips(repo, pull);
  const out: Record<string, unknown> = {
    url,
    id: pull.id,
    node_id: pull.nodeId,
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${repoUrl}/issues/${pull.number}`,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    comments_url: `${repoUrl}/issues/${pull.number}/comments`,
    statuses_url: `${repoUrl}/statuses/${tips.head}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(origin, store.viewer),
    body: pull.body,
    labels: labelsOf(origin, store, repo, pull.labels),
    milestone: null,
    active_lock_reason: null,
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: iso(pull.closedAt),
    merged_at: iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: branchRef(origin, store, repo, pull.head, tips.head),
    base: branchRef(origin, store, repo, pull.base, tips.base),
    author_association: 'OWNER',
    auto_merge: null,
    draft: pull.draft,
    merged: pull.merged,
  };
  if (detail) {
    const files = forge.pullFiles(repo, pull);
    const mergeable = forge.mergeable(repo, pull);
    out.mergeable = mergeable;
    out.rebaseable = mergeable;
    out.mergeable_state = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
    out.merged_by = pull.merged ? userJson(origin, store.viewer) : null;
    out.comments = pull.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
    out.commits = forge.pullCommits(repo, pull).length;
    out.additions = files.reduce((sum, file) => sum + file.additions, 0);
    out.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    out.changed_files = files.length;
  }
  return out;
}

export function commitJson(origin: Origin, store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const commit = readCommit(repo, oid)!;
  const repoUrl = `${origin.api}/repos/${store.viewer}/${repo.name}`;
  const person = (ident: Ident): Record<string, unknown> => ({ name: ident.name, email: ident.email, date: isoOf(ident.time) });
  return {
    sha: oid,
    node_id: nodeId('C', `commit:${repo.id}:${oid}`),
    url: `${repoUrl}/commits/${oid}`,
    html_url: `${origin.web}/${store.viewer}/${repo.name}/commit/${oid}`,
    comments_url: `${repoUrl}/commits/${oid}/comments`,
    commit: {
      url: `${repoUrl}/git/commits/${oid}`,
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${repoUrl}/git/trees/${commit.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: commit.author.email === store.viewerEmail ? userJson(origin, store.viewer) : null,
    committer: commit.committer.email === store.viewerEmail ? userJson(origin, store.viewer) : null,
    parents: commit.parents.map((sha) => ({ sha, url: `${repoUrl}/commits/${sha}`, html_url: `${origin.web}/${store.viewer}/${repo.name}/commit/${sha}` })),
  };
}

export function gitCommitJson(origin: Origin, store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const commit = readCommit(repo, oid)!;
  const repoUrl = `${origin.api}/repos/${store.viewer}/${repo.name}`;
  return {
    sha: oid,
    node_id: nodeId('C', `commit:${repo.id}:${oid}`),
    url: `${repoUrl}/git/commits/${oid}`,
    html_url: `${origin.web}/${store.viewer}/${repo.name}/commit/${oid}`,
    author: { name: commit.author.name, email: commit.author.email, date: isoOf(commit.author.time) },
    committer: { name: commit.committer.name, email: commit.committer.email, date: isoOf(commit.committer.time) },
    message: commit.message,
    tree: { sha: commit.tree, url: `${repoUrl}/git/trees/${commit.tree}` },
    parents: commit.parents.map((sha) => ({ sha, url: `${repoUrl}/git/commits/${sha}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

export function refJson(origin: Origin, store: Store, repo: Repo, ref: string, oid: string): Record<string, unknown> {
  const url = `${origin.api}/repos/${store.viewer}/${repo.name}/git/${ref}`;
  const type = repo.objects.get(oid)?.type ?? 'commit';
  return {
    ref,
    node_id: nodeId('REF', `ref:${repo.id}:${ref}`),
    url,
    object: { sha: oid, type, url: `${origin.api}/repos/${store.viewer}/${repo.name}/git/${type}s/${oid}` },
  };
}

export function branchJson(origin: Origin, store: Store, repo: Repo, name: string, oid: string): Record<string, unknown> {
  return {
    name,
    commit: { sha: oid, url: `${origin.api}/repos/${store.viewer}/${repo.name}/commits/${oid}` },
    protected: false,
  };
}

/** A contents API entry (the file form adds content and encoding). */
export function contentJson(
  origin: Origin,
  store: Store,
  repo: Repo,
  path: string,
  entry: { type: 'file' | 'dir' | 'submodule' | 'symlink'; sha: string; size: number },
  ref: string,
  content?: Buffer,
): Record<string, unknown> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const url = `${origin.api}/repos/${store.viewer}/${repo.name}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const html = `${origin.web}/${store.viewer}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${ref}/${path}`;
  const out: Record<string, unknown> = {
    type: entry.type,
    size: entry.size,
    name,
    path,
    sha: entry.sha,
    url,
    git_url: `${origin.api}/repos/${store.viewer}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.sha}`,
    html_url: html,
    download_url: entry.type === 'file' ? `${origin.web}/${store.viewer}/${repo.name}/raw/${ref}/${path}` : null,
    _links: { self: url, git: `${origin.api}/repos/${store.viewer}/${repo.name}/git/blobs/${entry.sha}`, html },
  };
  if (content !== undefined) {
    out.content = content.toString('base64');
    out.encoding = 'base64';
  }
  return out;
}
