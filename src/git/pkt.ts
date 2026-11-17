// pkt-line framing (gitprotocol-common): 4 hex digits of length, then the payload.

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');

/** The most payload a side-band-64k packet carries after its band byte (65520 - 4 - 1). */
const SIDEBAND_CHUNK = 65515;

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([header, body]);
}

/** `data` split into side-band packets on `band` (1 pack data, 2 progress, 3 error). */
export function sideband(band: number, data: Buffer, out: Buffer[]): void {
  for (let at = 0; at < data.length; at += SIDEBAND_CHUNK) {
    const chunk = data.subarray(at, Math.min(data.length, at + SIDEBAND_CHUNK));
    const header = Buffer.allocUnsafe(5);
    header.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 'latin1');
    header[4] = band;
    out.push(header, chunk);
  }
}

export type Packet = Buffer | 'flush' | 'delim' | 'end';

export class PktError extends Error {}

/**
 * Read pkt-lines from `buf` starting at `start`. With `untilFlush`, stop after the first flush and report
 * the offset after it (receive-pack's command list is followed by the raw pack).
 */
export function readPkts(buf: Buffer, start = 0, untilFlush = false): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = start;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new PktError('truncated pkt-line header');
    const text = buf.toString('latin1', at, at + 4);
    if (!/^[0-9a-f]{4}$/i.test(text)) throw new PktError('invalid pkt-line length');
    const length = parseInt(text, 16);
    if (length === 0) {
      packets.push('flush');
      at += 4;
      if (untilFlush) return { packets, next: at };
      continue;
    }
    if (length === 1 || length === 2) {
      packets.push(length === 1 ? 'delim' : 'end');
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buf.length) throw new PktError('pkt-line runs past the body');
    packets.push(buf.subarray(at + 4, at + length));
    at += length;
  }
  return { packets, next: at };
}

/** A data packet as a line of text, its trailing newline removed. */
export function lineOf(packet: Buffer): string {
  const text = packet.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
