// Request routing: /healthz, REST v3, GraphQL, MCP and the git smart HTTP paths, each behind its auth rule.

import type { IncomingMessage } from 'node:http';
import { advertise, serviceRequest } from './git/smart.ts';
import { authOf, errorReply, json, unauthorized } from './http.ts';
import type { Reply } from './http.ts';
import { handleRest } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { EXECUTOR } from './graphql/schema.ts';
import type { Forge } from './service.ts';
import { originOf } from './shapes.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const NO_QUERY = new URLSearchParams();

/** GraphQL: one operation, or GitHub's batched form (a JSON array of operations answered in order). */
function graphql(forge: Forge, body: Buffer, web: string): Reply {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const ctx = { forge, web };
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    const query = 'query' in entry ? entry.query : undefined;
    const operationName = 'operationName' in entry ? entry.operationName : undefined;
    const variables = 'variables' in entry ? entry.variables : undefined;
    return EXECUTOR.run(query, operationName, variables, ctx);
  };
  return json(200, Array.isArray(payload) ? payload.map(runOne) : runOne(payload));
}

function git(forge: Forge, req: IncomingMessage, match: RegExpExecArray, query: URLSearchParams, body: Buffer): Reply {
  const store = forge.store;
  const auth = authOf(req.headers.authorization, store.token);
  if (auth !== 'ok') {
    return { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="github-forge"' }, body: 'Authentication required\n' };
  }
  const repo = store.repo(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
  if (repo === null) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Repository not found\n' };
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  const action = match[3]!;
  if (action === 'info/refs') {
    const service = query.get('service');
    if (req.method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) return errorReply(403, 'Dumb HTTP is not supported');
    return advertise(repo, service, v2);
  }
  if (req.method !== 'POST') return errorReply(405, 'Method Not Allowed');
  return serviceRequest(repo, store, action, body, v2);
}

export function route(forge: Forge, req: IncomingMessage, body: Buffer): Reply {
  const url = req.url ?? '/';
  const mark = url.indexOf('?');
  const path = mark < 0 ? url : url.slice(0, mark);
  const query = mark < 0 ? NO_QUERY : new URLSearchParams(url.slice(mark + 1));
  const method = req.method ?? 'GET';
  if (path === '/healthz') return json(200, { ok: true });
  const origin = originOf(req.headers.host);
  if (path.startsWith('/api/v3/') || path === '/api/v3') {
    const auth = authOf(req.headers.authorization, forge.store.token);
    if (auth !== 'ok') return unauthorized(auth);
    const segments: string[] = [];
    for (const segment of path.slice(8).split('/')) if (segment !== '') segments.push(segment.includes('%') ? decodeURIComponent(segment) : segment);
    return handleRest(forge, { method, segments, query, rawBody: body, origin });
  }
  if (path === '/api/graphql' || path === '/graphql') {
    if (method !== 'POST') return errorReply(404, 'Not Found');
    if (authOf(req.headers.authorization, forge.store.token) !== 'ok') {
      return json(401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql' });
    }
    return graphql(forge, body, origin.web);
  }
  if (path === '/mcp' || path === '/mcp/') return handleMcp(forge, origin, method, req.headers.authorization, body);
  const match = GIT_PATH.exec(path);
  if (match !== null) return git(forge, req, match, query, body);
  return errorReply(404, 'Not Found');
}
