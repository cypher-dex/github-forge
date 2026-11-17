// Packfiles (gitformat-pack): reading what a client pushes, deltas included, and writing what a fetch sends.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject } from './objects.ts';
import type { GitObject, ObjType } from './objects.ts';

const TYPE_BY_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export class PackError extends Error {}

interface RawEntry {
  offset: number;
  code: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/** Inflate the zlib stream at `offset`; the engine's byte count says where the next entry starts. */
function inflateAt(buf: Buffer, offset: number, expected: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (result.buffer.length !== expected) throw new PackError(`object at ${offset} inflated to ${result.buffer.length} bytes, expected ${expected}`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const sourceSize = varint();
  if (sourceSize !== base.length) throw new PackError('delta base size mismatch');
  const target = Buffer.allocUnsafe(varint());
  let out = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset |= delta[at++]! << (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) copySize |= delta[at++]! << (8 * bit);
      if (copySize === 0) copySize = 0x10000;
      copyOffset >>>= 0;
      if (copyOffset + copySize > base.length || out + copySize > target.length) throw new PackError('delta copy out of range');
      base.copy(target, out, copyOffset, copyOffset + copySize);
      out += copySize;
    } else if (op > 0) {
      if (out + op > target.length || at + op > delta.length) throw new PackError('delta insert out of range');
      delta.copy(target, out, at, at + op);
      out += op;
      at += op;
    } else {
      throw new PackError('delta opcode 0');
    }
  }
  if (out !== target.length) throw new PackError('delta produced the wrong size');
  return target;
}

export interface UnpackedObject extends GitObject {
  oid: string;
}

/** Parse a whole pack; `lookup` resolves REF_DELTA bases the pack does not carry (a thin pack). */
export function readPack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): UnpackedObject[] {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PACK') throw new PackError('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex') !== trailer) throw new PackError('pack checksum mismatch');
  const raw: RawEntry[] = [];
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = at;
    let byte = buf[at++]!;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[at++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (code === OFS_DELTA) {
      byte = buf[at++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[at++]!;
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = offset - distance;
    } else if (code === REF_DELTA) {
      baseOid = buf.toString('hex', at, at + 20);
      at += 20;
    } else if (TYPE_BY_CODE[code] === undefined) {
      throw new PackError(`unknown pack object type ${code}`);
    }
    if (at > buf.length - 20) throw new PackError('pack entry runs past the trailer');
    const inflated = inflateAt(buf, at, size);
    at = inflated.next;
    raw.push({ offset, code, data: inflated.data, baseOffset, baseOid });
  }

  const byOffset = new Map<number, UnpackedObject>();
  const byOid = new Map<string, UnpackedObject>();
  const out: UnpackedObject[] = [];
  const settle = (entry: RawEntry, type: ObjType, data: Buffer): void => {
    const object: UnpackedObject = { oid: hashObject(type, data), type, data };
    byOffset.set(entry.offset, object);
    byOid.set(object.oid, object);
    out.push(object);
  };
  let pending: RawEntry[] = [];
  for (const entry of raw) {
    const type = TYPE_BY_CODE[entry.code];
    if (type !== undefined) settle(entry, type, entry.data);
    else pending.push(entry);
  }
  while (pending.length > 0) {
    const waiting: RawEntry[] = [];
    for (const entry of pending) {
      const base = entry.code === OFS_DELTA ? byOffset.get(entry.baseOffset) : (byOid.get(entry.baseOid) ?? lookup(entry.baseOid));
      if (base === undefined) waiting.push(entry);
      else settle(entry, base.type, applyDelta(base.data, entry.data));
    }
    if (waiting.length === pending.length) throw new PackError('pack has unresolved delta bases');
    pending = waiting;
  }
  return out;
}

/** One non-delta pack entry: the type/size header followed by the deflated object. */
export function packEntry(object: GitObject): Buffer {
  let size = object.data.length;
  const header: number[] = [];
  let byte = (CODE_BY_TYPE[object.type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    header.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  header.push(byte);
  return Buffer.concat([Buffer.from(header), deflateSync(object.data, { level: 1 })]);
}

/** A version-2 pack of pre-encoded entries, with its SHA-1 trailer. */
export function writePack(entries: readonly Buffer[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
