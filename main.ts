// github-forge: one Node process serving git smart HTTP, REST v3, GraphQL v4 and MCP from memory.
// Lifecycle: listen on an ephemeral port, register it with the env, poll the env until it says done.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { advertise, serviceRequest } from './src/git/smart.ts';
import { authOf, errorReply, json, readBody, unauthorized } from './src/http.ts';
import type { Reply } from './src/http.ts';
import { handleRest } from './src/rest.ts';
import { handleMcp } from './src/mcp.ts';
import { EXECUTOR } from './src/graphql/schema.ts';
import { Forge } from './src/service.ts';
import { originOf } from './src/shapes.ts';
import { Store } from './src/store.ts';

const store = new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '', process.env.MAKEFUN_TRIAL_NOW);
const forge = new Forge(store);
let requests = 0;

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function route(req: IncomingMessage, body: Buffer): Reply {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
  const method = req.method ?? 'GET';
  if (path === '/healthz') return json(200, { ok: true });
  const origin = originOf(req.headers.host);
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const auth = authOf(req.headers.authorization, store.token);
    if (auth !== 'ok') return unauthorized(auth);
    const segments = path.slice(7).split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
    return handleRest(forge, { method, segments, query, rawBody: body, origin });
  }
  if (path === '/api/graphql' || path === '/graphql') {
    if (method !== 'POST') return errorReply(404, 'Not Found');
    const auth = authOf(req.headers.authorization, store.token);
    if (auth !== 'ok') return json(401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql' });
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return errorReply(400, 'Problems parsing JSON');
    }
    const ctx = { forge, web: origin.web };
    const runOne = (entry: unknown): unknown => {
      const op = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      return EXECUTOR.run(op.query, op.operationName, op.variables, ctx);
    };
    return json(200, Array.isArray(payload) ? payload.map(runOne) : runOne(payload));
  }
  if (path === '/mcp' || path === '/mcp/') return handleMcp(forge, origin, method, req.headers.authorization, body);
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    const auth = authOf(req.headers.authorization, store.token);
    if (auth !== 'ok') return { status: 401, headers: { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="github-forge"' }, body: 'Authentication required\n' };
    const repo = store.repo(decodeURIComponent(git[1]!), decodeURIComponent(git[2]!));
    if (repo === null) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Repository not found\n' };
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (git[3] === 'info/refs') {
      const service = query.get('service');
      if (method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) return errorReply(403, 'Dumb HTTP is not supported');
      return advertise(repo, service, v2);
    }
    if (method !== 'POST') return errorReply(405, 'Method Not Allowed');
    return serviceRequest(repo, store, git[3]!, body, v2);
  }
  return errorReply(404, 'Not Found');
}

function send(res: ServerResponse, reply: Reply, api: boolean): void {
  requests += 1;
  const headers: Record<string, string | number> = { ...reply.headers, 'X-GitHub-Request-Id': `F0R6E:${requests.toString(16).toUpperCase()}` };
  if (api) {
    headers['X-OAuth-Scopes'] = 'repo, read:org, workflow, gist';
    headers['X-Accepted-OAuth-Scopes'] = 'repo';
    headers['X-GitHub-Media-Type'] = 'github.v3; format=json';
  }
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  headers['Content-Length'] = body.length;
  res.writeHead(reply.status, headers);
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let reply: Reply;
  try {
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    const body = hasBody ? await readBody(req) : Buffer.alloc(0);
    reply = route(req, body);
  } catch (err) {
    process.stderr.write(`forge: request failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    reply = errorReply(500, 'Internal Server Error');
  }
  send(res, reply, (req.url ?? '').startsWith('/api/'));
}

const server = createServer({ keepAlive: true, noDelay: true }, (req, res) => {
  void handle(req, res);
});
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;

process.on('uncaughtException', (err) => process.stderr.write(`forge: uncaught: ${err.stack ?? err.message}\n`));
process.on('unhandledRejection', (err) => process.stderr.write(`forge: unhandled: ${String(err)}\n`));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      if (response.ok || response.status === 409) return;
      if (response.status === 400 || response.status === 405) throw new Error(`register refused with ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(Math.min(2000, 200 * 2 ** Math.min(attempt, 4)));
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // The env may be busy or restarting; poll again.
    }
    await sleep(1000);
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    process.stdout.write(`forge: listening on ${port} (no MAKEFUN_ENV_URL)\n`);
    return;
  }
  register(envUrl, port)
    .then(() => waitForDone(envUrl))
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`forge: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
});
