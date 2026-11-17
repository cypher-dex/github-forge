// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2, with a v0 fallback) and receive-pack (v0).

import { isOid, isTreeMode, parseTag, parseTree, ZERO_OID } from './objects.ts';
import { readPack, writePack } from './pack.ts';
import { DELIM, FLUSH, lineOf, pkt, readPkts, sideband } from './pkt.ts';
import type { Packet } from './pkt.ts';
import { isAncestor, packedEntry, peel, readCommit, setRef, validRefName } from '../store.ts';
import type { Repo, Store } from '../store.ts';
import type { Reply } from '../http.ts';

const AGENT = 'agent=git/github-forge-1.0';
const UPLOAD_V0_CAPS = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want filter object-format=sha1 ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 ${AGENT}`;
const V2_ADVERTISEMENT = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow filter\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);
const MAX_FETCH_CACHE = 8;

function gitReply(status: number, type: string, body: Buffer | string): Reply {
  return { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' }, body };
}

/** Refs in name order, with HEAD first when the default branch exists. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function advertise(repo: Repo, service: string, v2: boolean): Reply {
  if (service === 'git-upload-pack' && v2) return gitReply(200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const upload = service === 'git-upload-pack';
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let caps = upload ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  if (upload && head !== undefined) caps = `${caps} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: string[] = [];
  if (upload && head !== undefined) lines.push(`${head} HEAD`);
  for (const [name, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${name}`);
    if (upload && name.startsWith('refs/tags/')) {
      const peeled = peel(repo, oid);
      if (peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => parts.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return gitReply(200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

// ---------------------------------------------------------------- object selection

interface FetchPlan {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number;
  blobLimit: number;
  includeTag: boolean;
}

interface FetchResult {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/** Add a tree and everything under it to `into`, skipping subtrees the client already holds. */
function addTree(repo: Repo, treeOid: string, into: Set<string>, exclude: Set<string>, blobLimit: number): void {
  if (into.has(treeOid) || exclude.has(treeOid)) return;
  const object = repo.objects.get(treeOid);
  if (object === undefined) return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    if (isTreeMode(entry.mode)) {
      addTree(repo, entry.oid, into, exclude, blobLimit);
    } else if (!into.has(entry.oid) && !exclude.has(entry.oid)) {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined && blob.data.length <= blobLimit) into.add(entry.oid);
    }
  }
}

/** What the client already holds: everything reachable from its haves, stopping at its shallow boundary. */
function haveClosure(repo: Repo, haves: readonly string[], clientShallow: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    const commit = peel(repo, have);
    if (held.has(commit) && have === commit) continue;
    held.add(have);
    if (readCommit(repo, commit) !== null) {
      held.add(commit);
      queue.push(commit);
    }
  }
  const none = new Set<string>();
  for (let at = 0; at < queue.length; at += 1) {
    const oid = queue[at]!;
    const commit = readCommit(repo, oid)!;
    addTree(repo, commit.tree, held, none, Number.POSITIVE_INFINITY);
    if (clientShallow.has(oid)) continue;
    for (const parent of commit.parents) {
      if (held.has(parent) || readCommit(repo, parent) === null) continue;
      held.add(parent);
      queue.push(parent);
    }
  }
  return held;
}

function planObjects(repo: Repo, plan: FetchPlan): FetchResult {
  const held = haveClosure(repo, plan.haves, plan.clientShallow);
  const send = new Set<string>();
  const commits: string[] = [];
  const depthOf = new Map<string, number>();
  for (const want of plan.wants) {
    let oid = want;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tag') break;
      if (!held.has(oid)) send.add(oid);
      oid = parseTag(object.data).object;
    }
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (!depthOf.has(oid)) {
        depthOf.set(oid, 1);
        commits.push(oid);
      }
    } else if (object.type === 'tree') {
      addTree(repo, oid, send, held, plan.blobLimit);
    } else if (!held.has(oid)) {
      send.add(oid);
    }
  }
  const shallow: string[] = [];
  const window = new Set<string>();
  for (let at = 0; at < commits.length; at += 1) {
    const oid = commits[at]!;
    const depth = depthOf.get(oid)!;
    const commit = readCommit(repo, oid)!;
    window.add(oid);
    if (!held.has(oid)) send.add(oid);
    addTree(repo, commit.tree, send, held, plan.blobLimit);
    if (plan.depth > 0 && depth >= plan.depth) {
      if (commit.parents.length > 0) shallow.push(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (readCommit(repo, parent) === null) continue;
      if (plan.depth === 0 && held.has(parent)) continue;
      const known = depthOf.get(parent);
      if (known === undefined) {
        depthOf.set(parent, depth + 1);
        commits.push(parent);
      } else if (known > depth + 1) {
        depthOf.set(parent, depth + 1);
      }
    }
  }
  const unshallow: string[] = [];
  if (plan.depth > 0) {
    const boundary = new Set(shallow);
    for (const oid of plan.clientShallow) if (window.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  if (plan.includeTag) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/') || held.has(oid) || send.has(oid)) continue;
      if (repo.objects.get(oid)?.type === 'tag' && send.has(peel(repo, oid))) send.add(oid);
    }
  }
  const common = plan.haves.filter((have) => repo.objects.has(have));
  return { objects: [...send], shallow, unshallow, common };
}

function packFor(repo: Repo, oids: readonly string[]): Buffer {
  return writePack(oids.map((oid) => packedEntry(repo, oid)));
}

function parseFilter(spec: string): number {
  if (spec === 'blob:none') return -1;
  const limit = /^blob:limit=(\d+)([kmg]?)$/i.exec(spec);
  if (limit === null) return Number.POSITIVE_INFINITY;
  const scale: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(limit[1]) * (scale[limit[2]!.toLowerCase()] ?? 1);
}

// ---------------------------------------------------------------- protocol v2

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peelTags = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peelTags = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  if (matches('HEAD')) {
    const target = `refs/heads/${repo.defaultBranch}`;
    const head = repo.refs.get(target);
    const symref = symrefs ? ` symref-target:${target}` : '';
    if (head !== undefined) out.push(pkt(`${head} HEAD${symref}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symref}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peelTags) {
      const peeled = peel(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const cacheKey = args.join('\n');
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan: FetchPlan = { wants: [], haves: [], clientShallow: new Set(), depth: 0, blobLimit: Number.POSITIVE_INFINITY, includeTag: false };
  const wantedRefs: string[] = [];
  let done = false;
  for (const arg of args) {
    const space = arg.indexOf(' ');
    const key = space < 0 ? arg : arg.slice(0, space);
    const value = space < 0 ? '' : arg.slice(space + 1);
    if (key === 'want' && isOid(value)) plan.wants.push(value);
    else if (key === 'have' && isOid(value)) plan.haves.push(value);
    else if (key === 'shallow' && isOid(value)) plan.clientShallow.add(value);
    else if (key === 'deepen') plan.depth = Math.max(0, Number.parseInt(value, 10) || 0);
    else if (key === 'filter') plan.blobLimit = parseFilter(value);
    else if (key === 'include-tag') plan.includeTag = true;
    else if (key === 'done') done = true;
    else if (key === 'want-ref') {
      const oid = repo.refs.get(value);
      if (oid === undefined) throw new GitError(`unknown ref ${value}`);
      plan.wants.push(oid);
      wantedRefs.push(`${oid} ${value}`);
    }
  }
  for (const want of plan.wants) if (!repo.objects.has(want)) throw new GitError(`upload-pack: not our ref ${want}`);
  const result = planObjects(repo, plan);
  const out: Buffer[] = [];
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (result.common.length === 0) out.push(pkt('NAK\n'));
    for (const oid of result.common) out.push(pkt(`ACK ${oid}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  if (plan.depth > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of result.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  if (wantedRefs.length > 0) {
    out.push(pkt('wanted-refs\n'));
    for (const line of wantedRefs) out.push(pkt(`${line}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'));
  sideband(1, packFor(repo, result.objects), out);
  out.push(FLUSH);
  const body = Buffer.concat(out);
  if (repo.fetchCache.size >= MAX_FETCH_CACHE) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, body);
  return body;
}

export class GitError extends Error {}

function textLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (typeof packet !== 'string') lines.push(lineOf(packet));
  return lines;
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = readPkts(body);
  const delim = packets.indexOf('delim');
  const head = textLines(delim < 0 ? packets : packets.slice(0, delim));
  const args = delim < 0 ? [] : textLines(packets.slice(delim + 1));
  const command = head.find((line) => line.startsWith('command='))?.slice(8);
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  if (command === undefined && packets.length > 0 && packets.every((packet) => packet === 'flush')) return Buffer.alloc(0);
  throw new GitError(`unknown command ${command ?? '(none)'}`);
}

// ---------------------------------------------------------------- protocol v0 upload-pack

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const lines = textLines(readPkts(body).packets);
  const plan: FetchPlan = { wants: [], haves: [], clientShallow: new Set(), depth: 0, blobLimit: Number.POSITIVE_INFINITY, includeTag: false };
  let sidebandOn = false;
  let done = false;
  for (const line of lines) {
    const [key, value = ''] = line.split(' ', 2);
    if (key === 'want') {
      if (plan.wants.length === 0) {
        const caps = line.slice(46).split(' ');
        sidebandOn = caps.includes('side-band-64k') || caps.includes('side-band');
        plan.includeTag = caps.includes('include-tag');
      }
      if (isOid(value)) plan.wants.push(value);
    } else if (key === 'have' && isOid(value)) plan.haves.push(value);
    else if (key === 'shallow' && isOid(value)) plan.clientShallow.add(value);
    else if (key === 'deepen') plan.depth = Math.max(0, Number.parseInt(value, 10) || 0);
    else if (key === 'filter') plan.blobLimit = parseFilter(line.slice(7));
    else if (key === 'done') done = true;
  }
  const result = planObjects(repo, plan);
  const out: Buffer[] = [];
  if (plan.depth > 0) {
    for (const oid of result.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  const last = result.common[result.common.length - 1];
  if (!done && plan.haves.length > 0) {
    for (const oid of result.common) out.push(pkt(`ACK ${oid} common\n`));
    if (last !== undefined) out.push(pkt(`ACK ${last} ready\n`));
    out.push(pkt('NAK\n'));
    return Buffer.concat(out);
  }
  out.push(pkt(last === undefined ? 'NAK\n' : `ACK ${last}\n`));
  const pack = packFor(repo, result.objects);
  if (sidebandOn) {
    sideband(1, pack, out);
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets, next } = readPkts(body, 0, true);
  const commands: Command[] = [];
  let caps: string[] = [];
  for (const packet of packets) {
    if (typeof packet === 'string') continue;
    let line = lineOf(packet);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
    }
    const [oldOid = '', newOid = '', ref = ''] = line.split(' ');
    if (!isOid(oldOid) || !isOid(newOid) || ref === '') throw new GitError('malformed push command');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return Buffer.alloc(0);
  let unpackError: string | null = null;
  const packBytes = body.subarray(next);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of objects) if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
    } catch (err) {
      unpackError = err instanceof Error ? err.message.replace(/\s+/g, ' ') : 'unpack failed';
    }
  }
  const atomic = caps.includes('atomic');
  const verdicts = commands.map((command) => (unpackError === null ? checkCommand(repo, command) : 'unpacker error'));
  const refuseAll = atomic && verdicts.some((verdict) => verdict !== null);
  const hadBranches = [...repo.refs.keys()].some((ref) => ref.startsWith('refs/heads/'));
  const report: Buffer[] = [pkt(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  commands.forEach((command, index) => {
    const verdict = refuseAll && verdicts[index] === null ? 'atomic push failed' : verdicts[index];
    if (verdict !== null && verdict !== undefined) {
      report.push(pkt(`ng ${command.ref} ${verdict}\n`));
      return;
    }
    setRef(repo, command.ref, command.newOid === ZERO_OID ? null : command.newOid);
    report.push(pkt(`ok ${command.ref}\n`));
  });
  report.push(FLUSH);
  if (!hadBranches && !repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
    const first = commands.find((command) => command.ref.startsWith('refs/heads/') && repo.refs.has(command.ref));
    if (first !== undefined) repo.defaultBranch = first.ref.slice(11);
  }
  repo.pushedAt = store.now();
  if (!caps.includes('side-band-64k') && !caps.includes('side-band')) return Buffer.concat(report);
  const out: Buffer[] = [];
  sideband(1, Buffer.concat(report), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

/** Null when a command may apply, else the reason for its `ng` line. */
function checkCommand(repo: Repo, command: Command): string | null {
  if (!validRefName(command.ref)) return 'funny refname';
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (current !== command.oldOid) return command.oldOid === ZERO_OID ? 'already exists' : 'stale info';
  if (command.newOid === ZERO_OID) return null;
  const object = repo.objects.get(command.newOid);
  if (object === undefined) return 'missing necessary objects';
  const target = peel(repo, command.newOid);
  if (command.ref.startsWith('refs/heads/') && repo.objects.get(target)?.type !== 'commit') return 'not a commit';
  if (command.oldOid === ZERO_OID) return null;
  const oldTarget = peel(repo, command.oldOid);
  if (readCommit(repo, oldTarget) === null || readCommit(repo, target) === null) return command.ref.startsWith('refs/tags/') ? 'already exists' : 'non-fast-forward';
  if (!isAncestor(repo, oldTarget, target)) return 'non-fast-forward';
  return null;
}

// ---------------------------------------------------------------- the HTTP face

export function serviceRequest(repo: Repo, store: Store, service: string, body: Buffer, v2: boolean): Reply {
  const type = `application/x-${service}-result`;
  try {
    if (service === 'git-receive-pack') return gitReply(200, type, receivePack(repo, store, body));
    return gitReply(200, type, v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'protocol error';
    return gitReply(400, 'text/plain; charset=utf-8', `${message}\n`);
  }
}
