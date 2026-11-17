// Git's object model: ids, loose encodings, and the tree / commit / tag text formats.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return value.length === 40 && OID_RE.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'latin1').update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree object');
    entries.push({
      mode: data.toString('latin1', at, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

/** Git orders tree entries bytewise, comparing a directory as if its name ended in '/'. */
function sortKey(entry: TreeEntry): Buffer {
  return Buffer.from(isTreeMode(entry.mode) ? `${entry.name}/` : entry.name, 'utf8');
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const keyed = entries.map((entry) => ({ entry, key: sortKey(entry) }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [];
  for (const { entry } of keyed) {
    const mode = isTreeMode(entry.mode) ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- identities

export interface Ident {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  tz: string;
}

export function formatIdent(ident: Ident): string {
  return `${ident.name} <${ident.email}> ${ident.time} ${ident.tz}`;
}

export function parseIdent(text: string): Ident {
  const match = /^(.*?) ?<([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0, tz: '+0000' };
  return { name: match[1] ?? '', email: match[2] ?? '', time: Number(match[3]), tz: match[4] ?? '+0000' };
}

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- commits

export interface Commit {
  tree: string;
  parents: string[];
  author: Ident;
  committer: Ident;
  message: string;
}

/** Split an object's header block from its message; continuation lines (a leading space) join the previous header. */
function headersOf(data: Buffer): { headers: Array<[string, string]>; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const headers: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length > 0) {
      const last = headers[headers.length - 1]!;
      last[1] += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  return { headers, message };
}

export function parseCommit(data: Buffer): Commit {
  const { headers, message } = headersOf(data);
  const commit: Commit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', time: 0, tz: '+0000' },
    committer: { name: '', email: '', time: 0, tz: '+0000' },
    message,
  };
  for (const [key, value] of headers) {
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parseIdent(value);
    else if (key === 'committer') commit.committer = parseIdent(value);
  }
  return commit;
}

export function encodeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdent(commit.author)}`, `committer ${formatIdent(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

// ---------------------------------------------------------------- tags

export interface Tag {
  object: string;
  type: string;
  tag: string;
  tagger: Ident | null;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const { headers, message } = headersOf(data);
  const tag: Tag = { object: '', type: '', tag: '', tagger: null, message };
  for (const [key, value] of headers) {
    if (key === 'object') tag.object = value;
    else if (key === 'type') tag.type = value;
    else if (key === 'tag') tag.tag = value;
    else if (key === 'tagger') tag.tagger = parseIdent(value);
  }
  return tag;
}
