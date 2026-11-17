// The forge's state: one viewer, their repositories, and each repository's objects, refs, issues and pulls.
// Everything lives in memory for the life of the process (a trial is one process, start to finish).

import { packEntry } from './git/pack.ts';
import { EMPTY_TREE_OID, encodeCommit, encodeTree, hashObject, isTreeMode, parseCommit, parseTag, parseTree } from './git/objects.ts';
import type { Commit, GitObject, Ident, ObjType, TreeEntry } from './git/objects.ts';

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** The serialized REST object and the host it was rendered for (the read workload's fast path). */
  cache: string | null;
  cacheHost: string;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** The tips at creation, and the head frozen at merge or close. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  draft: boolean;
  labels: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  createdAt: number;
  updatedAt: number;
  pushedAt: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  /** Pack entries already deflated, by object id: a clone never compresses an object twice. */
  packed: Map<string, Buffer>;
  commits: Map<string, Commit>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  /** Bumped on every ref change; keys the fetch response cache. */
  version: number;
  fetchCache: Map<string, Buffer>;
}

export class ApiError extends Error {
  status: number;
  errors: unknown[] | undefined;

  constructor(status: number, message: string, errors?: unknown[]) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const DEFAULT_LOGIN = 'adaiversen';

/** Node ids are opaque: a type prefix and the base64url of a typed key. */
export function nodeId(prefix: string, key: string): string {
  return `${prefix}_kwDO${Buffer.from(key, 'utf8').toString('base64url')}`;
}

export function decodeNodeId(id: string): { prefix: string; key: string } | null {
  const match = /^([A-Z]+)_kwDO([A-Za-z0-9_-]+)$/.exec(id);
  if (match === null) return null;
  return { prefix: match[1]!, key: Buffer.from(match[2]!, 'base64url').toString('utf8') };
}

export class Store {
  login: string | null = null;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private readonly epoch: number;
  private tick = 0;
  private nextId = 1;

  constructor(token: string, trialNow: string | undefined) {
    this.token = token;
    const parsed = trialNow === undefined ? Number.NaN : Date.parse(trialNow);
    this.epoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_767_225_600;
  }

  /** The viewer's login: the first owner the suite names, or the scenario's viewer before any. */
  get viewer(): string {
    return this.login ?? DEFAULT_LOGIN;
  }

  get viewerName(): string {
    return this.viewer;
  }

  get viewerEmail(): string {
    return `${this.viewer}@users.noreply.github.com`;
  }

  /** Whether `owner` names the token's own account; the first owner ever named becomes it. */
  owns(owner: string): boolean {
    if (this.login === null) this.login = owner;
    return owner.toLowerCase() === this.login.toLowerCase();
  }

  /** A logical clock: every event is one second after the last, from the trial's opening time. */
  now(): number {
    this.tick += 1;
    return this.epoch + this.tick;
  }

  id(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  identity(time: number): Ident {
    return { name: this.viewerName, email: this.viewerEmail, time, tz: '+0000' };
  }

  repo(owner: string, name: string): Repo | null {
    if (!this.owns(owner)) return null;
    return this.repos.get(name.toLowerCase()) ?? null;
  }

  createRepo(name: string, description: string | null, isPrivate: boolean): Repo {
    const now = this.now();
    const id = this.id() + 100_000;
    const repo: Repo = {
      id,
      nodeId: nodeId('R', `repo:${id}`),
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      hasIssues: true,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      refs: new Map(),
      objects: new Map(),
      packed: new Map(),
      commits: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      fetchCache: new Map(),
    };
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }
}

// ---------------------------------------------------------------- objects and refs

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function packedEntry(repo: Repo, oid: string): Buffer {
  let entry = repo.packed.get(oid);
  if (entry === undefined) {
    const object = repo.objects.get(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    entry = packEntry(object);
    repo.packed.set(oid, entry);
  }
  return entry;
}

export function readCommit(repo: Repo, oid: string): Commit | null {
  let commit = repo.commits.get(oid);
  if (commit !== undefined) return commit;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  commit = parseCommit(object.data);
  repo.commits.set(oid, commit);
  return commit;
}

export function readTree(repo: Repo, oid: string): TreeEntry[] {
  if (oid === EMPTY_TREE_OID) return [];
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') throw new ApiError(404, 'Not Found');
  return parseTree(object.data);
}

/** Follow annotated tags to the object they name. */
export function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

export function setRef(repo: Repo, ref: string, oid: string | null): void {
  if (oid === null) repo.refs.delete(ref);
  else repo.refs.set(ref, oid);
  repo.version += 1;
  repo.fetchCache.clear();
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** A branch, tag, full ref or commit id, resolved to a commit id. */
export function resolveCommitish(repo: Repo, ref: string): string | null {
  const candidates = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const name of candidates) {
    const oid = repo.refs.get(name);
    if (oid !== undefined) return peel(repo, oid);
  }
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return peel(repo, ref.toLowerCase());
  return null;
}

/** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let at = 0; at < queue.length; at += 1) {
    const commit = readCommit(repo, queue[at]!);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Every commit reachable from `tip`, breadth first. */
export function ancestry(repo: Repo, tip: string, limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>([tip]);
  const order = [tip];
  for (let at = 0; at < order.length && order.length < limit; at += 1) {
    const commit = readCommit(repo, order[at]!);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        order.push(parent);
      }
    }
  }
  return order;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set(ancestry(repo, a));
  for (const oid of ancestry(repo, b)) if (fromA.has(oid)) return oid;
  return null;
}

// ---------------------------------------------------------------- trees by path

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every blob under a tree, by full path. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', into = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  for (const entry of readTree(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(repo, entry.oid, path, into);
    else into.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return into;
}

/** Build the nested trees for a path -> blob map and return the root tree id. */
export function treeFromFlat(repo: Repo, files: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = dir.dirs.get(name);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        dir.dirs.set(name, child);
      }
      dir = child;
    }
    dir.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
  }
  const write = (dir: Dir): string => {
    const entries = [...dir.files];
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return putObject(repo, 'tree', encodeTree(entries));
  };
  return write(root);
}

/** The entry at `path` under a tree, or null. An empty path is the root tree itself. */
export function lookupPath(repo: Repo, treeOid: string, path: string): TreeEntry | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current: TreeEntry = { mode: '40000', name: '', oid: treeOid };
  for (const segment of segments) {
    if (!isTreeMode(current.mode)) return null;
    const next = readTree(repo, current.oid).find((entry) => entry.name === segment);
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/** A tree with `path` set to `entry` (or removed when null); empty directories disappear. */
export function writePath(repo: Repo, treeOid: string | null, segments: readonly string[], entry: FlatEntry | null): string {
  const entries = treeOid === null ? [] : readTree(repo, treeOid);
  const [name, ...rest] = segments;
  const index = entries.findIndex((candidate) => candidate.name === name);
  const existing = index >= 0 ? entries[index]! : null;
  let replacement: TreeEntry | null;
  if (rest.length === 0) {
    replacement = entry === null ? null : { mode: entry.mode, name: name!, oid: entry.oid };
  } else {
    const childTree = existing !== null && isTreeMode(existing.mode) ? existing.oid : null;
    const child = writePath(repo, childTree, rest, entry);
    replacement = child === EMPTY_TREE_OID ? null : { mode: '40000', name: name!, oid: child };
  }
  if (index >= 0) entries.splice(index, 1);
  if (replacement !== null) entries.push(replacement);
  if (entries.length === 0) return EMPTY_TREE_OID;
  return putObject(repo, 'tree', encodeTree(entries));
}

export function createCommit(repo: Repo, store: Store, tree: string, parents: string[], message: string): string {
  if (tree === EMPTY_TREE_OID) putObject(repo, 'tree', Buffer.alloc(0));
  const ident = store.identity(store.now());
  return putObject(repo, 'commit', encodeCommit({ tree, parents, author: ident, committer: ident, message }));
}

/** The commit at a branch tip plus its tree, or nulls for an unborn branch. */
export function tipOf(repo: Repo, branch: string): { commit: string | null; tree: string | null } {
  const commit = branchTip(repo, branch);
  if (commit === null) return { commit: null, tree: null };
  return { commit, tree: readCommit(repo, commit)?.tree ?? null };
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oid: string;
  additions: number;
  deletions: number;
}

function lines(repo: Repo, oid: string | undefined): string[] {
  if (oid === undefined) return [];
  const data = repo.objects.get(oid)?.data;
  if (data === undefined || data.length === 0) return [];
  const text = data.toString('utf8');
  const split = text.split('\n');
  if (text.endsWith('\n')) split.pop();
  return split;
}

/** Line counts after trimming the common head and tail: cheap, and exact for one contiguous change. */
function lineDelta(before: string[], after: string[]): { additions: number; deletions: number } {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { additions: after.length - head - tail, deletions: before.length - head - tail };
}

export function diffTrees(repo: Repo, fromTree: string | null, toTree: string | null): FileChange[] {
  const before = fromTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, fromTree);
  const after = toTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, toTree);
  const changes: FileChange[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
    const delta = lineDelta(lines(repo, a?.oid), lines(repo, b?.oid));
    changes.push({
      path,
      status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      oid: (b ?? a)!.oid,
      additions: delta.additions,
      deletions: delta.deletions,
    });
  }
  return changes;
}

/** A path-level three-way merge of trees; null when both sides changed one path differently. */
export function mergeTrees(repo: Repo, baseTree: string | null, oursTree: string, theirsTree: string): string | null {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);
  const merged = new Map<string, FlatEntry>();
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    x === y || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let pick: FlatEntry | undefined;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else return null;
    if (pick !== undefined) merged.set(path, pick);
  }
  return treeFromFlat(repo, merged);
}

export function validRefName(ref: string): boolean {
  return ref.startsWith('refs/') && !/[\s~^:?*[\\\x00-\x1f]|\.\.|\/\/|\.lock$|\/$|@\{/.test(ref);
}
