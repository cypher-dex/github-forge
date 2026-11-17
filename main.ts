// github-forge: one Node process serving git smart HTTP, REST v3, GraphQL v4 and MCP from memory.
// This file is the process: the HTTP server around src/router.ts, and the trial lifecycle (listen on an
// ephemeral port, register it with the env, poll the env until it says done, exit 0).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorReply, readBody } from './src/http.ts';
import type { Reply } from './src/http.ts';
import { route } from './src/router.ts';
import { Forge } from './src/service.ts';
import { Store } from './src/store.ts';

const forge = new Forge(new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '', process.env.MAKEFUN_TRIAL_NOW));

const EMPTY = Buffer.alloc(0);
/** What GitHub sends on every API answer; the suite reads X-OAuth-Scopes from the API root. */
const API_HEADERS: Record<string, string> = {
  'X-OAuth-Scopes': 'repo, read:org, workflow, gist',
  'X-Accepted-OAuth-Scopes': 'repo',
  'X-GitHub-Media-Type': 'github.v3; format=json',
};

let requestCount = 0;

function send(res: ServerResponse, reply: Reply, api: boolean): void {
  requestCount += 1;
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  const headers: Record<string, string | number> = api ? { ...reply.headers, ...API_HEADERS } : { ...reply.headers };
  headers['X-GitHub-Request-Id'] = `F0E6:${requestCount.toString(16).toUpperCase()}`;
  headers['Content-Length'] = body.length;
  res.writeHead(reply.status, headers);
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let reply: Reply;
  try {
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    reply = route(forge, req, hasBody ? await readBody(req) : EMPTY);
  } catch (err) {
    process.stderr.write(`forge: request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    reply = errorReply(500, 'Internal Server Error');
  }
  send(res, reply, (req.url ?? '').startsWith('/api/'));
}

const server = createServer({ keepAlive: true, noDelay: true, requestTimeout: 0 }, (req, res) => {
  void handle(req, res);
});
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

process.on('uncaughtException', (err) => process.stderr.write(`forge: uncaught: ${err.stack ?? err.message}\n`));
process.on('unhandledRejection', (err) => process.stderr.write(`forge: unhandled: ${String(err)}\n`));
process.on('SIGTERM', () => process.exit(0));

/** POST the bound port until the env takes it; a 409 means a register already won, which is fine too. */
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
      if (response.status === 400 || response.status === 405) throw new Error(`the env refused the register with HTTP ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('the env refused')) throw err;
    }
    await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
  }
}

/** Poll GET /done (the env answers at once) until it says the trial is over. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      const answer: unknown = await response.json();
      if (typeof answer === 'object' && answer !== null && 'done' in answer && answer.done === true) return;
    } catch {
      // The env may be busy or not up yet: poll again.
    }
    await sleep(1000);
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    process.stdout.write(`forge: listening on port ${port}\n`);
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
