// What every surface shares: the reply shape, body reading, the bearer check and JSON answers.

import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ApiError } from './store.ts';

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const DOCS = 'https://docs.github.com/rest';

export function json(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'Content-Type': JSON_TYPE, ...headers }, body: value === undefined ? '' : JSON.stringify(value) };
}

/** A GitHub-shaped error body: a string message, the docs link, and validation errors when there are any. */
export function errorReply(status: number, message: string, errors?: unknown[]): Reply {
  const body: Record<string, unknown> = { message, documentation_url: DOCS, status: String(status) };
  if (errors !== undefined) body.errors = errors;
  return json(status, body);
}

export function fromError(err: unknown): Reply {
  if (err instanceof ApiError) return errorReply(err.status, err.message, err.errors);
  return errorReply(500, err instanceof Error ? err.message : 'Internal Server Error');
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip' && body.length > 0) return gunzipSync(body);
  return body;
}

export type Auth = 'ok' | 'missing' | 'bad';

/** The bearer check every API surface makes: `Bearer`/`token` schemes, or basic auth carrying the token. */
export function authOf(header: string | undefined, token: string): Auth {
  if (header === undefined || header === '') return 'missing';
  const space = header.indexOf(' ');
  if (space < 0) return 'bad';
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === 'bearer' || scheme === 'token') return value === token ? 'ok' : 'bad';
  if (scheme === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const secret = colon < 0 ? decoded : decoded.slice(colon + 1);
    return secret === token || decoded.slice(0, Math.max(0, colon)) === token ? 'ok' : 'bad';
  }
  return 'bad';
}

export function unauthorized(auth: Auth): Reply {
  return errorReply(401, auth === 'missing' ? 'Requires authentication' : 'Bad credentials');
}
