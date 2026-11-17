// The Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP, speaking the 2026-07-28 revision
// (server/discover, no session) and the handshake revisions (initialize + notifications/initialized).

import { authOf, json } from './http.ts';
import type { Reply } from './http.ts';
import { ApiError, lookupPath, readCommit, readTree } from './store.ts';
import type { Forge } from './service.ts';
import { commitJson, contentJson, issueJson, pullJson, repoJson } from './shapes.ts';
import type { Origin } from './shapes.ts';
import { isTreeMode } from './git/objects.ts';

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-forge', title: 'GitHub-compatible forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'Repositories, issues and pull requests of a GitHub-compatible forge. Every tool acts on the same store as the REST and GraphQL APIs.';

type Args = Record<string, unknown>;

interface Property {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

interface Tool {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, Property>;
  run: (forge: Forge, origin: Origin, args: Args) => unknown;
}

const owner: Property = { type: 'string', description: 'Repository owner (the account login)' };
const repo: Property = { type: 'string', description: 'Repository name' };
const issueNumber: Property = { type: 'number', description: 'Issue number' };
const pullNumber: Property = { type: 'number', description: 'Pull request number' };

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function num(args: Args, key: string): number {
  const value = args[key];
  return typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      autoInit: { type: 'boolean', description: 'Initialize with a README commit' },
    },
    run: (forge, origin, args) => repoJson(forge.store, origin, forge.createRepo({ name: args.name, description: args.description, private: args.private === true, auto_init: args.autoInit === true })),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: { owner, repo },
    run: (forge, origin, args) => repoJson(forge.store, origin, forge.requireRepo(str(args, 'owner'), str(args, 'repo'))),
  },
  {
    name: 'list_repositories',
    description: "List the authenticated user's repositories.",
    required: [],
    properties: {},
    run: (forge, origin) => [...forge.store.repos.values()].map((entry) => repoJson(forge.store, origin, entry)),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner,
      repo,
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'array', description: 'Names of existing labels to apply', items: { type: 'string' } },
    },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return issueJson(origin, forge.store, target, forge.createIssue(target, { title: args.title, body: args.body, labels: args.labels }));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    required: ['owner', 'repo', 'issue_number'],
    properties: { owner, repo, issue_number: issueNumber },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return issueJson(origin, forge.store, target, forge.requireIssue(target, num(args, 'issue_number')));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    required: ['owner', 'repo'],
    properties: {
      owner,
      repo,
      state: { type: 'string', description: 'open, closed or all (default open)', enum: ['open', 'closed', 'all'] },
      labels: { type: 'array', description: 'Only issues carrying all these labels', items: { type: 'string' } },
    },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const state = str(args, 'state').toLowerCase() || 'open';
      const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
      return [...target.issues.values()]
        .filter((issue) => (state === 'all' || issue.state === state) && labels.every((label) => issue.labels.includes(label)))
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(origin, forge.store, target, issue));
    },
  },
  {
    name: 'update_issue',
    description: "Update an issue's title, body, state or labels.",
    required: ['owner', 'repo', 'issue_number'],
    properties: {
      owner,
      repo,
      issue_number: issueNumber,
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
      state: { type: 'string', description: 'open or closed', enum: ['open', 'closed'] },
      labels: { type: 'array', description: 'Replacement label names', items: { type: 'string' } },
    },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const patch: Args = {};
      for (const key of ['title', 'body', 'state', 'labels']) if (args[key] !== undefined) patch[key] = args[key];
      return issueJson(origin, forge.store, target, forge.updateIssue(target, forge.requireIssue(target, num(args, 'issue_number')), patch));
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Comment on an issue or pull request.',
    required: ['owner', 'repo', 'issue_number', 'body'],
    properties: { owner, repo, issue_number: issueNumber, body: { type: 'string', description: 'Comment text' } },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const comment = forge.addComment(target, num(args, 'issue_number'), args.body);
      return { id: comment.id, node_id: comment.nodeId, body: comment.body };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner,
      repo,
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'Branch with the changes' },
      base: { type: 'string', description: 'Branch to merge into' },
      body: { type: 'string', description: 'Pull request description' },
      draft: { type: 'boolean', description: 'Open as a draft' },
    },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return pullJson(origin, forge, target, forge.createPull(target, { title: args.title, head: args.head, base: args.base, body: args.body, draft: args.draft }), true);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    required: ['owner', 'repo', 'pull_number'],
    properties: { owner, repo, pull_number: pullNumber },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return pullJson(origin, forge, target, forge.requirePull(target, num(args, 'pull_number')), true);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    required: ['owner', 'repo'],
    properties: { owner, repo, state: { type: 'string', description: 'open, closed or all (default open)', enum: ['open', 'closed', 'all'] } },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const state = str(args, 'state').toLowerCase() || 'open';
      return [...target.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(origin, forge, target, pull, false));
    },
  },
  {
    name: 'get_pull_request_files',
    description: 'List the files a pull request changes.',
    required: ['owner', 'repo', 'pull_number'],
    properties: { owner, repo, pull_number: pullNumber },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return forge.pullFiles(target, forge.requirePull(target, num(args, 'pull_number'))).map((change) => ({
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        sha: change.oid,
      }));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge, squash or rebase).',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: { type: 'string', description: 'merge, squash or rebase (default squash)', enum: ['merge', 'squash', 'rebase'] },
      commit_title: { type: 'string', description: 'Title of the merge commit' },
      commit_message: { type: 'string', description: 'Extra detail for the merge commit' },
    },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const pull = forge.requirePull(target, num(args, 'pull_number'));
      const result = forge.mergePull(target, pull, { merge_method: str(args, 'merge_method') || 'squash', commit_title: args.commit_title, commit_message: args.commit_message });
      return { sha: result.sha, merged: true, message: result.message, number: pull.number };
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file or list a directory at a branch, tag or commit.',
    required: ['owner', 'repo', 'path'],
    properties: { owner, repo, path: { type: 'string', description: 'Path in the repository' }, ref: { type: 'string', description: 'Branch, tag or commit (default branch when omitted)' } },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const ref = str(args, 'ref') || null;
      const tree = readCommit(target, forge.commitFor(target, ref))!.tree;
      const path = str(args, 'path').replace(/^\/+|\/+$/g, '');
      const entry = lookupPath(target, tree, path);
      if (entry === null) throw new ApiError(404, 'Not Found');
      const refName = ref ?? target.defaultBranch;
      if (isTreeMode(entry.mode)) {
        return readTree(target, entry.oid).map((child) => contentJson(origin, forge.store, target, path === '' ? child.name : `${path}/${child.name}`, { type: isTreeMode(child.mode) ? 'dir' : 'file', sha: child.oid, size: 0 }, refName));
      }
      const data = target.objects.get(entry.oid)!.data;
      return { ...contentJson(origin, forge.store, target, path, { type: 'file', sha: entry.oid, size: data.length }, refName, data), text: data.toString('utf8') };
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update one file with a commit on a branch.',
    required: ['owner', 'repo', 'path', 'content', 'message'],
    properties: {
      owner,
      repo,
      path: { type: 'string', description: 'Path in the repository' },
      content: { type: 'string', description: 'New file content (plain text)' },
      message: { type: 'string', description: 'Commit message' },
      branch: { type: 'string', description: 'Branch to commit on (default branch when omitted)' },
      sha: { type: 'string', description: 'Blob sha of the file being replaced (required for updates)' },
    },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const result = forge.putContent(target, str(args, 'path'), {
        message: args.message,
        content: Buffer.from(str(args, 'content'), 'utf8').toString('base64'),
        branch: args.branch,
        sha: args.sha,
      });
      return { content: { path: str(args, 'path'), sha: result.blob }, commit: { sha: result.commit } };
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (the default branch when omitted).',
    required: ['owner', 'repo', 'branch'],
    properties: { owner, repo, branch: { type: 'string', description: 'New branch name' }, from_branch: { type: 'string', description: 'Source branch' } },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const sha = forge.commitFor(target, str(args, 'from_branch') || null);
      const ref = forge.createRef(target, `refs/heads/${str(args, 'branch')}`, sha);
      return { ref, object: { sha, type: 'commit' } };
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    required: ['owner', 'repo'],
    properties: { owner, repo },
    run: (forge, _origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      return [...target.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }));
    },
  },
  {
    name: 'list_commits',
    description: 'List commits reachable from a branch or sha, newest first.',
    required: ['owner', 'repo'],
    properties: { owner, repo, sha: { type: 'string', description: 'Branch or commit to start from' } },
    run: (forge, origin, args) => {
      const target = forge.requireRepo(str(args, 'owner'), str(args, 'repo'));
      const start = forge.commitFor(target, str(args, 'sha') || null);
      return forge.log(target, start, null, 30).map((oid) => commitJson(origin, forge.store, target, oid));
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The tools/list payload, built once so two listings are byte-identical. */
const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.name.replace(/_/g, ' '),
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
  annotations: { readOnlyHint: /^(get|list)_/.test(tool.name) },
}));

type JsonRpcId = string | number | null;

interface RpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcError(id: JsonRpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

let sessions = 0;

function callTool(forge: Forge, origin: Origin, id: JsonRpcId, params: Args): RpcResponse {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOL_BY_NAME.get(name) ?? TOOL_BY_NAME.get(name.replace(/^.*?__/, ''));
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Args) : {};
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], isError: true } };
  }
  try {
    const value = tool.run(forge, origin, args);
    const result: Args = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) result.structuredContent = value;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const message = err instanceof ApiError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : 'tool failed';
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } };
  }
}

/** One JSON-RPC message; null for a notification (nothing to answer). */
function dispatch(forge: Forge, origin: Origin, message: unknown, session: { id: string | null }): RpcResponse | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return rpcError(null, -32600, 'Invalid Request');
  const request = message as Args;
  const hasId = 'id' in request;
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return hasId ? rpcError(id, -32600, 'Invalid Request') : null;
  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Args) : {};
  if (!hasId) return null;
  switch (request.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY[0]!;
      sessions += 1;
      session.id = `mcp-session-${sessions}`;
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: LEGACY.includes(asked) || asked === MODERN ? asked : LEGACY[0], capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      };
    }
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [MODERN, ...LEGACY],
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOL_LIST } };
    case 'tools/call':
      return callTool(forge, origin, id, params);
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

export function handleMcp(forge: Forge, origin: Origin, method: string, authorization: string | undefined, rawBody: Buffer): Reply {
  if (method === 'DELETE') return { status: 204, headers: {}, body: '' };
  if (method !== 'POST') return json(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: POST JSON-RPC messages to /mcp' } }, { Allow: 'POST, DELETE' });
  if (authOf(authorization, forge.store.token) !== 'ok') {
    return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a valid bearer token is required' } }, { 'WWW-Authenticate': 'Bearer realm="mcp"' });
  }
  let message: unknown;
  try {
    message = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'));
  }
  const session = { id: null as string | null };
  const headers: Record<string, string> = {};
  if (Array.isArray(message)) {
    if (message.length === 0) return json(400, rpcError(null, -32600, 'Invalid Request: empty batch'));
    const answers = message.map((entry) => dispatch(forge, origin, entry, session)).filter((answer): answer is RpcResponse => answer !== null);
    if (session.id !== null) headers['Mcp-Session-Id'] = session.id;
    return answers.length === 0 ? { status: 202, headers, body: '' } : json(200, answers, headers);
  }
  const answer = dispatch(forge, origin, message, session);
  if (session.id !== null) headers['Mcp-Session-Id'] = session.id;
  if (answer === null) return { status: 202, headers, body: '' };
  return json(200, answer, headers);
}
