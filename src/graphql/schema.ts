// The GraphQL v4 schema the forge serves: the documents gh and github-mcp-server send, over the same store.

import { isoOf } from '../git/objects.ts';
import { ApiError, decodeNodeId, readCommit } from '../store.ts';
import type { Comment, FileChange, Issue, Label, Pull, Repo } from '../store.ts';
import type { Forge } from '../service.ts';
import { Executor, FieldError } from './execute.ts';
import type { Args, FieldDef, Schema } from './execute.ts';

export interface GqlContext {
  forge: Forge;
  web: string;
}

interface RepoNode { __typename: 'Repository'; repo: Repo }
interface IssueNode { __typename: 'Issue'; repo: Repo; issue: Issue }
interface PullNode { __typename: 'PullRequest'; repo: Repo; pull: Pull }
interface UserNode { __typename: 'User'; login: string }
interface CommentNode { __typename: 'IssueComment'; repo: Repo; number: number; comment: Comment }
interface LabelNode { __typename: 'Label'; repo: Repo; label: Label }
interface RefNode { __typename: 'Ref'; repo: Repo; ref: string; oid: string }
interface CommitNode { __typename: 'Commit'; repo: Repo; oid: string }
interface FileNode { change: FileChange }
type AnyNode = RepoNode | IssueNode | PullNode | UserNode | CommentNode | LabelNode | RefNode | CommitNode;

// ---------------------------------------------------------------- argument and node helpers

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const cursorOf = (index: number): string => Buffer.from(`cursor:v2:${index}`, 'utf8').toString('base64');

function indexOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const match = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  if (match === null) throw new FieldError(`\`${cursor}\` does not appear to be a valid cursor.`, 'INVALID_CURSOR_ARGUMENTS');
  return Number(match[1]);
}

/** A Relay connection over `items`, honouring first/after/last/before. */
function connection<T>(items: readonly T[], args: Args): Record<string, unknown> {
  let start = 0;
  let end = items.length;
  const after = indexOfCursor(args.after);
  const before = indexOfCursor(args.before);
  if (after !== null) start = Math.max(start, after + 1);
  if (before !== null) end = Math.min(end, before);
  const first = int(args.first);
  const last = int(args.last);
  if (first !== null && first < 0) throw new FieldError('`first` must be a non-negative integer');
  if (first !== null) end = Math.min(end, start + first);
  if (last !== null) start = Math.max(start, end - last);
  const nodes = items.slice(start, end);
  return {
    totalCount: items.length,
    nodes,
    edges: nodes.map((node, offset) => ({ cursor: cursorOf(start + offset), node })),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorOf(start) : null,
      endCursor: nodes.length > 0 ? cursorOf(end - 1) : null,
    },
  };
}

const iso = (seconds: number | null): string | null => (seconds === null ? null : isoOf(seconds));

function repoNode(repo: Repo): RepoNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): IssueNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): PullNode {
  return { __typename: 'PullRequest', repo, pull };
}

function viewerNode(ctx: GqlContext): UserNode {
  return { __typename: 'User', login: ctx.forge.store.viewer };
}

/** Resolve a global id to its node, or null when nothing has it. */
function findNode(ctx: GqlContext, id: unknown): AnyNode | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  const store = ctx.forge.store;
  const parts = decoded.key.split(':');
  const repo = parts[1] === undefined ? null : store.repoById(Number(parts[1]));
  switch (decoded.prefix) {
    case 'R':
      return repo === null ? null : repoNode(repo);
    case 'I': {
      const issue = repo?.issues.get(Number(parts[2]));
      return repo === null || issue === undefined ? null : issueNode(repo, issue);
    }
    case 'PR': {
      const pull = repo?.pulls.get(Number(parts[2]));
      return repo === null || pull === undefined ? null : pullNode(repo, pull);
    }
    case 'IC': {
      if (repo === null) return null;
      const number = Number(parts[2]);
      const holder = repo.issues.get(number) ?? repo.pulls.get(number);
      const comment = holder?.comments.find((candidate) => candidate.id === Number(parts[3]));
      return comment === undefined ? null : { __typename: 'IssueComment', repo, number, comment };
    }
    case 'U':
      return parts[1] === store.viewer ? viewerNode(ctx) : null;
    default:
      return null;
  }
}

function requireNode<T extends AnyNode['__typename']>(ctx: GqlContext, id: unknown, type: T): Extract<AnyNode, { __typename: T }> {
  const node = findNode(ctx, id);
  if (node === null || node.__typename !== type) throw new FieldError(`Could not resolve to a node with the global id of '${String(id)}'.`, 'NOT_FOUND');
  return node as Extract<AnyNode, { __typename: T }>;
}

/** Run a forge operation, turning its API errors into GraphQL field errors. */
function attempt<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    if (err instanceof ApiError) throw new FieldError(err.message, err.status === 404 ? 'NOT_FOUND' : 'UNPROCESSABLE');
    throw err;
  }
}

function labelIdsToNames(repo: Repo, ids: unknown): string[] {
  const names: string[] = [];
  for (const id of strings(ids)) {
    for (const label of repo.labels.values()) if (label.nodeId === id) names.push(label.name);
  }
  return names;
}

function sortIssues<T extends { number: number; createdAt: number; updatedAt: number; comments: Comment[] }>(items: T[], orderBy: unknown): T[] {
  const order = record(orderBy);
  const field = order.field === 'UPDATED_AT' ? 'updatedAt' : order.field === 'COMMENTS' ? 'comments' : 'createdAt';
  const sign = order.direction === 'DESC' ? -1 : 1;
  const key = (item: T): number => (field === 'comments' ? item.comments.length : item[field]);
  return items.sort((a, b) => sign * (key(a) - key(b) || a.number - b.number));
}

function pullState(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueList(repo: Repo, args: Args): IssueNode[] {
  const filter = record(args.filterBy);
  const states = strings(args.states).length > 0 ? strings(args.states) : strings(filter.states);
  const labels = strings(args.labels).length > 0 ? strings(args.labels) : strings(filter.labels);
  let issues = [...repo.issues.values()];
  if (states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  if (labels.length > 0) issues = issues.filter((issue) => labels.some((label) => issue.labels.includes(label)));
  return sortIssues(issues, args.orderBy).map((issue) => issueNode(repo, issue));
}

function pullList(repo: Repo, args: Args): PullNode[] {
  const states = strings(args.states);
  const head = text(args.headRefName);
  const base = text(args.baseRefName);
  const pulls = [...repo.pulls.values()].filter(
    (pull) => (states.length === 0 || states.includes(pullState(pull))) && (head === null || pull.head === head) && (base === null || pull.base === base),
  );
  return sortIssues(pulls, args.orderBy).map((pull) => pullNode(repo, pull));
}

function refNode(repo: Repo, ref: string): RefNode | null {
  const oid = repo.refs.get(ref);
  return oid === undefined ? null : { __typename: 'Ref', repo, ref, oid };
}

/** gh's issue search: `repo:o/r is:issue is:open label:x words`. */
function search(ctx: GqlContext, args: Args): Record<string, unknown> {
  const query = text(args.query) ?? '';
  const type = text(args.type) ?? 'ISSUE';
  const terms = query.split(/\s+/).filter((term) => term !== '');
  let repos = [...ctx.forge.store.repos.values()];
  let kind: 'issue' | 'pr' | null = null;
  let state: string | null = null;
  const labels: string[] = [];
  const words: string[] = [];
  for (const term of terms) {
    const [key, ...rest] = term.split(':');
    const value = rest.join(':').replace(/^"|"$/g, '');
    if (rest.length === 0) words.push(term.toLowerCase());
    else if (key === 'repo') repos = repos.filter((repo) => `${ctx.forge.store.viewer}/${repo.name}`.toLowerCase() === value.toLowerCase());
    else if ((key === 'is' || key === 'type') && (value === 'issue' || value === 'pr')) kind = value;
    else if (key === 'is' || key === 'state') state = value;
    else if (key === 'label') labels.push(value);
  }
  const matches = (title: string, body: string | null): boolean => words.every((word) => title.toLowerCase().includes(word) || (body ?? '').toLowerCase().includes(word));
  const nodes: Array<IssueNode | PullNode | RepoNode> = [];
  if (type === 'REPOSITORY') {
    for (const repo of repos) if (matches(repo.name, repo.description)) nodes.push(repoNode(repo));
  } else {
    for (const repo of repos) {
      if (kind !== 'pr') {
        for (const issue of repo.issues.values()) {
          if ((state === null || issue.state === state) && labels.every((label) => issue.labels.includes(label)) && matches(issue.title, issue.body)) nodes.push(issueNode(repo, issue));
        }
      }
      if (kind !== 'issue') {
        for (const pull of repo.pulls.values()) {
          const pullStateText = pull.merged ? 'merged' : pull.state;
          if ((state === null || pull.state === state || pullStateText === state) && matches(pull.title, pull.body)) nodes.push(pullNode(repo, pull));
        }
      }
    }
  }
  const page = connection(nodes, args);
  return { ...page, issueCount: type === 'REPOSITORY' ? 0 : nodes.length, repositoryCount: type === 'REPOSITORY' ? nodes.length : 0 };
}

// ---------------------------------------------------------------- the schema table

const connectionArgs = { first: 'Int', last: 'Int', after: 'String', before: 'String' };

function connectionTypes(name: string, node: string): Schema<GqlContext> {
  return {
    [`${name}Connection`]: {
      kind: 'OBJECT',
      fields: {
        totalCount: { type: 'Int!' },
        nodes: { type: `[${node}]` },
        edges: { type: `[${name}Edge]` },
        pageInfo: { type: 'PageInfo!' },
      },
    },
    [`${name}Edge`]: { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: node } } },
  };
}

const enumType = (...values: string[]): Schema<GqlContext>[string] => ({ kind: 'ENUM', values });
const inputType = (inputFields: Record<string, string>): Schema<GqlContext>[string] => ({ kind: 'INPUT_OBJECT', inputFields });

const userFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (user: UserNode) => `U_kwDO${Buffer.from(`user:${user.login}`).toString('base64url')}` },
  databaseId: { type: 'Int', resolve: () => 1 },
  login: { type: 'String!' },
  name: { type: 'String', resolve: (user: UserNode) => user.login },
  email: { type: 'String!', resolve: (user: UserNode) => `${user.login}@users.noreply.github.com` },
  url: { type: 'URI!', resolve: (user: UserNode, _args, ctx) => `${ctx.web}/${user.login}` },
  avatarUrl: { type: 'URI!', args: { size: 'Int' }, resolve: (user: UserNode, _args, ctx) => `${ctx.web}/avatars/${user.login}` },
  createdAt: { type: 'DateTime!', resolve: () => '2025-01-01T00:00:00Z' },
  repositories: {
    type: 'RepositoryConnection!',
    args: { ...connectionArgs, ownerAffiliations: '[RepositoryAffiliation]', privacy: 'RepositoryPrivacy', orderBy: 'RepositoryOrder' },
    resolve: (_user: UserNode, args, ctx) => connection([...ctx.forge.store.repos.values()].sort((a, b) => a.createdAt - b.createdAt).map(repoNode), args),
  },
  repository: {
    type: 'Repository',
    args: { name: 'String!' },
    resolve: (user: UserNode, args, ctx) => {
      const repo = ctx.forge.store.repo(user.login, text(args.name) ?? '');
      return repo === null ? null : repoNode(repo);
    },
  },
};

const commentFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (node: CommentNode) => node.comment.nodeId },
  databaseId: { type: 'Int', resolve: (node: CommentNode) => node.comment.id },
  body: { type: 'String!', resolve: (node: CommentNode) => node.comment.body },
  bodyText: { type: 'String!', resolve: (node: CommentNode) => node.comment.body },
  createdAt: { type: 'DateTime!', resolve: (node: CommentNode) => iso(node.comment.createdAt) },
  updatedAt: { type: 'DateTime!', resolve: (node: CommentNode) => iso(node.comment.updatedAt) },
  author: { type: 'Actor', resolve: (_node: CommentNode, _args, ctx) => viewerNode(ctx) },
  url: { type: 'URI!', resolve: (node: CommentNode, _args, ctx) => `${ctx.web}/${ctx.forge.store.viewer}/${node.repo.name}/issues/${node.number}#issuecomment-${node.comment.id}` },
  viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
};

function commentsField(): FieldDef<GqlContext> {
  return {
    type: 'IssueCommentConnection!',
    args: { ...connectionArgs, orderBy: 'IssueCommentOrder' },
    resolve: (node: IssueNode | PullNode, args) => {
      const holder = node.__typename === 'Issue' ? node.issue : node.pull;
      return connection(holder.comments.map((comment): CommentNode => ({ __typename: 'IssueComment', repo: node.repo, number: holder.number, comment })), args);
    },
  };
}

function labelsField(): FieldDef<GqlContext> {
  return {
    type: 'LabelConnection',
    args: { ...connectionArgs, orderBy: 'LabelOrder' },
    resolve: (node: IssueNode | PullNode, args) => {
      const names = node.__typename === 'Issue' ? node.issue.labels : node.pull.labels;
      const labels: LabelNode[] = [];
      for (const name of names) {
        const label = node.repo.labels.get(name.toLowerCase());
        if (label !== undefined) labels.push({ __typename: 'Label', repo: node.repo, label });
      }
      return connection(labels, args);
    },
  };
}

const issueFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (node: IssueNode) => node.issue.nodeId },
  databaseId: { type: 'Int', resolve: (node: IssueNode) => node.issue.id },
  number: { type: 'Int!', resolve: (node: IssueNode) => node.issue.number },
  title: { type: 'String!', resolve: (node: IssueNode) => node.issue.title },
  body: { type: 'String!', resolve: (node: IssueNode) => node.issue.body ?? '' },
  bodyText: { type: 'String!', resolve: (node: IssueNode) => node.issue.body ?? '' },
  state: { type: 'IssueState!', resolve: (node: IssueNode) => node.issue.state.toUpperCase() },
  stateReason: { type: 'IssueStateReason', resolve: (node: IssueNode) => node.issue.stateReason?.toUpperCase() ?? null },
  closed: { type: 'Boolean!', resolve: (node: IssueNode) => node.issue.state === 'closed' },
  locked: { type: 'Boolean!', resolve: () => false },
  url: { type: 'URI!', resolve: (node: IssueNode, _args, ctx) => `${ctx.web}/${ctx.forge.store.viewer}/${node.repo.name}/issues/${node.issue.number}` },
  createdAt: { type: 'DateTime!', resolve: (node: IssueNode) => iso(node.issue.createdAt) },
  updatedAt: { type: 'DateTime!', resolve: (node: IssueNode) => iso(node.issue.updatedAt) },
  closedAt: { type: 'DateTime', resolve: (node: IssueNode) => iso(node.issue.closedAt) },
  author: { type: 'Actor', resolve: (_node: IssueNode, _args, ctx) => viewerNode(ctx) },
  repository: { type: 'Repository!', resolve: (node: IssueNode) => repoNode(node.repo) },
  labels: labelsField(),
  comments: commentsField(),
  assignees: {
    type: 'UserConnection!',
    args: connectionArgs,
    resolve: (node: IssueNode, args) => connection(node.issue.assignees.map((login): UserNode => ({ __typename: 'User', login })), args),
  },
  viewerCanUpdate: { type: 'Boolean!', resolve: () => true },
};

const pullFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (node: PullNode) => node.pull.nodeId },
  databaseId: { type: 'Int', resolve: (node: PullNode) => node.pull.id },
  number: { type: 'Int!', resolve: (node: PullNode) => node.pull.number },
  title: { type: 'String!', resolve: (node: PullNode) => node.pull.title },
  body: { type: 'String!', resolve: (node: PullNode) => node.pull.body ?? '' },
  bodyText: { type: 'String!', resolve: (node: PullNode) => node.pull.body ?? '' },
  state: { type: 'PullRequestState!', resolve: (node: PullNode) => pullState(node.pull) },
  merged: { type: 'Boolean!', resolve: (node: PullNode) => node.pull.merged },
  mergedAt: { type: 'DateTime', resolve: (node: PullNode) => iso(node.pull.mergedAt) },
  closed: { type: 'Boolean!', resolve: (node: PullNode) => node.pull.state === 'closed' },
  closedAt: { type: 'DateTime', resolve: (node: PullNode) => iso(node.pull.closedAt) },
  isDraft: { type: 'Boolean!', resolve: (node: PullNode) => node.pull.draft },
  locked: { type: 'Boolean!', resolve: () => false },
  headRefName: { type: 'String!', resolve: (node: PullNode) => node.pull.head },
  baseRefName: { type: 'String!', resolve: (node: PullNode) => node.pull.base },
  headRefOid: { type: 'GitObjectID!', resolve: (node: PullNode, _args, ctx) => ctx.forge.pullTips(node.repo, node.pull).head },
  baseRefOid: { type: 'GitObjectID!', resolve: (node: PullNode, _args, ctx) => ctx.forge.pullTips(node.repo, node.pull).base },
  headRef: { type: 'Ref', resolve: (node: PullNode) => refNode(node.repo, `refs/heads/${node.pull.head}`) },
  baseRef: { type: 'Ref', resolve: (node: PullNode) => refNode(node.repo, `refs/heads/${node.pull.base}`) },
  headRepository: { type: 'Repository', resolve: (node: PullNode) => repoNode(node.repo) },
  baseRepository: { type: 'Repository', resolve: (node: PullNode) => repoNode(node.repo) },
  repository: { type: 'Repository!', resolve: (node: PullNode) => repoNode(node.repo) },
  isCrossRepository: { type: 'Boolean!', resolve: () => false },
  mergeable: {
    type: 'MergeableState!',
    resolve: (node: PullNode, _args, ctx) => {
      const mergeable = ctx.forge.mergeable(node.repo, node.pull);
      return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
  },
  mergeCommit: { type: 'Commit', resolve: (node: PullNode) => (node.pull.mergeCommitSha === null ? null : { __typename: 'Commit', repo: node.repo, oid: node.pull.mergeCommitSha }) },
  url: { type: 'URI!', resolve: (node: PullNode, _args, ctx) => `${ctx.web}/${ctx.forge.store.viewer}/${node.repo.name}/pull/${node.pull.number}` },
  createdAt: { type: 'DateTime!', resolve: (node: PullNode) => iso(node.pull.createdAt) },
  updatedAt: { type: 'DateTime!', resolve: (node: PullNode) => iso(node.pull.updatedAt) },
  author: { type: 'Actor', resolve: (_node: PullNode, _args, ctx) => viewerNode(ctx) },
  additions: { type: 'Int!', resolve: (node: PullNode, _args, ctx) => ctx.forge.pullFiles(node.repo, node.pull).reduce((sum, file) => sum + file.additions, 0) },
  deletions: { type: 'Int!', resolve: (node: PullNode, _args, ctx) => ctx.forge.pullFiles(node.repo, node.pull).reduce((sum, file) => sum + file.deletions, 0) },
  changedFiles: { type: 'Int!', resolve: (node: PullNode, _args, ctx) => ctx.forge.pullFiles(node.repo, node.pull).length },
  files: {
    type: 'PullRequestChangedFileConnection',
    args: connectionArgs,
    resolve: (node: PullNode, args, ctx) => connection(ctx.forge.pullFiles(node.repo, node.pull).map((change): FileNode => ({ change })), args),
  },
  commits: {
    type: 'PullRequestCommitConnection!',
    args: connectionArgs,
    resolve: (node: PullNode, args, ctx) => connection(ctx.forge.pullCommits(node.repo, node.pull).map((oid) => ({ commit: { __typename: 'Commit', repo: node.repo, oid } })), args),
  },
  labels: labelsField(),
  comments: commentsField(),
  viewerCanUpdate: { type: 'Boolean!', resolve: () => true },
};

const repoFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (node: RepoNode) => node.repo.nodeId },
  databaseId: { type: 'Int', resolve: (node: RepoNode) => node.repo.id },
  name: { type: 'String!', resolve: (node: RepoNode) => node.repo.name },
  nameWithOwner: { type: 'String!', resolve: (node: RepoNode, _args, ctx) => `${ctx.forge.store.viewer}/${node.repo.name}` },
  owner: { type: 'RepositoryOwner!', resolve: (_node: RepoNode, _args, ctx) => viewerNode(ctx) },
  description: { type: 'String', resolve: (node: RepoNode) => node.repo.description },
  url: { type: 'URI!', resolve: (node: RepoNode, _args, ctx) => `${ctx.web}/${ctx.forge.store.viewer}/${node.repo.name}` },
  sshUrl: { type: 'GitSSHRemote!', resolve: (node: RepoNode, _args, ctx) => `git@${ctx.web.slice(7)}:${ctx.forge.store.viewer}/${node.repo.name}.git` },
  homepageUrl: { type: 'URI', resolve: () => null },
  isPrivate: { type: 'Boolean!', resolve: (node: RepoNode) => node.repo.private },
  visibility: { type: 'RepositoryVisibility!', resolve: (node: RepoNode) => (node.repo.private ? 'PRIVATE' : 'PUBLIC') },
  isFork: { type: 'Boolean!', resolve: () => false },
  isArchived: { type: 'Boolean!', resolve: () => false },
  isTemplate: { type: 'Boolean!', resolve: () => false },
  isEmpty: { type: 'Boolean!', resolve: (node: RepoNode) => node.repo.refs.size === 0 },
  createdAt: { type: 'DateTime!', resolve: (node: RepoNode) => iso(node.repo.createdAt) },
  updatedAt: { type: 'DateTime!', resolve: (node: RepoNode) => iso(node.repo.updatedAt) },
  pushedAt: { type: 'DateTime', resolve: (node: RepoNode) => iso(node.repo.pushedAt) },
  defaultBranchRef: { type: 'Ref', resolve: (node: RepoNode) => refNode(node.repo, `refs/heads/${node.repo.defaultBranch}`) },
  viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
  viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
  viewerHasStarred: { type: 'Boolean!', resolve: () => false },
  hasIssuesEnabled: { type: 'Boolean!', resolve: (node: RepoNode) => node.repo.hasIssues },
  hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
  hasProjectsEnabled: { type: 'Boolean!', resolve: () => false },
  hasDiscussionsEnabled: { type: 'Boolean!', resolve: () => false },
  mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
  squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
  rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
  deleteBranchOnMerge: { type: 'Boolean!', resolve: () => false },
  stargazerCount: { type: 'Int!', resolve: () => 0 },
  forkCount: { type: 'Int!', resolve: () => 0 },
  primaryLanguage: { type: 'Language', resolve: () => null },
  parent: { type: 'Repository', resolve: () => null },
  issue: {
    type: 'Issue',
    args: { number: 'Int!' },
    resolve: (node: RepoNode, args) => {
      const issue = node.repo.issues.get(int(args.number) ?? -1);
      if (issue === undefined) throw new FieldError(`Could not resolve to an Issue with the number of ${String(args.number)}.`, 'NOT_FOUND');
      return issueNode(node.repo, issue);
    },
  },
  issues: {
    type: 'IssueConnection!',
    args: { ...connectionArgs, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' },
    resolve: (node: RepoNode, args) => connection(issueList(node.repo, args), args),
  },
  pullRequest: {
    type: 'PullRequest',
    args: { number: 'Int!' },
    resolve: (node: RepoNode, args) => {
      const pull = node.repo.pulls.get(int(args.number) ?? -1);
      if (pull === undefined) throw new FieldError(`Could not resolve to a PullRequest with the number of ${String(args.number)}.`, 'NOT_FOUND');
      return pullNode(node.repo, pull);
    },
  },
  pullRequests: {
    type: 'PullRequestConnection!',
    args: { ...connectionArgs, states: '[PullRequestState!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String', labels: '[String!]' },
    resolve: (node: RepoNode, args) => connection(pullList(node.repo, args), args),
  },
  issueOrPullRequest: {
    type: 'IssueOrPullRequest',
    args: { number: 'Int!' },
    resolve: (node: RepoNode, args) => {
      const number = int(args.number) ?? -1;
      const issue = node.repo.issues.get(number);
      if (issue !== undefined) return issueNode(node.repo, issue);
      const pull = node.repo.pulls.get(number);
      return pull === undefined ? null : pullNode(node.repo, pull);
    },
  },
  labels: {
    type: 'LabelConnection',
    args: { ...connectionArgs, query: 'String', orderBy: 'LabelOrder' },
    resolve: (node: RepoNode, args) => {
      const query = (text(args.query) ?? '').toLowerCase();
      const labels = [...node.repo.labels.values()].filter((label) => label.name.toLowerCase().includes(query));
      return connection(labels.map((label): LabelNode => ({ __typename: 'Label', repo: node.repo, label })), args);
    },
  },
  label: {
    type: 'Label',
    args: { name: 'String!' },
    resolve: (node: RepoNode, args) => {
      const label = node.repo.labels.get((text(args.name) ?? '').toLowerCase());
      return label === undefined ? null : { __typename: 'Label', repo: node.repo, label };
    },
  },
  ref: {
    type: 'Ref',
    args: { qualifiedName: 'String!' },
    resolve: (node: RepoNode, args) => {
      const name = text(args.qualifiedName) ?? '';
      return refNode(node.repo, name.startsWith('refs/') ? name : `refs/heads/${name}`);
    },
  },
  refs: {
    type: 'RefConnection',
    args: { ...connectionArgs, refPrefix: 'String!', query: 'String', orderBy: 'RefOrder' },
    resolve: (node: RepoNode, args) => {
      const prefix = text(args.refPrefix) ?? 'refs/heads/';
      const query = text(args.query) ?? '';
      const refs = [...node.repo.refs.keys()].filter((ref) => ref.startsWith(prefix) && ref.includes(query)).sort();
      return connection(refs.map((ref) => refNode(node.repo, ref)!), args);
    },
  },
};

const commitFields: Record<string, FieldDef<GqlContext>> = {
  id: { type: 'ID!', resolve: (node: CommitNode) => `C_kwDO${Buffer.from(`commit:${node.repo.id}:${node.oid}`).toString('base64url')}` },
  oid: { type: 'GitObjectID!' },
  abbreviatedOid: { type: 'String!', resolve: (node: CommitNode) => node.oid.slice(0, 7) },
  message: { type: 'String!', resolve: (node: CommitNode) => readCommit(node.repo, node.oid)?.message ?? '' },
  messageHeadline: { type: 'String!', resolve: (node: CommitNode) => (readCommit(node.repo, node.oid)?.message ?? '').split('\n')[0] },
  messageBody: { type: 'String!', resolve: (node: CommitNode) => (readCommit(node.repo, node.oid)?.message ?? '').split('\n').slice(2).join('\n') },
  committedDate: { type: 'DateTime!', resolve: (node: CommitNode) => iso(readCommit(node.repo, node.oid)?.committer.time ?? 0) },
  authoredDate: { type: 'DateTime!', resolve: (node: CommitNode) => iso(readCommit(node.repo, node.oid)?.author.time ?? 0) },
  url: { type: 'URI!', resolve: (node: CommitNode, _args, ctx) => `${ctx.web}/${ctx.forge.store.viewer}/${node.repo.name}/commit/${node.oid}` },
};

function payload(fields: Record<string, string>): Schema<GqlContext>[string] {
  const out: Record<string, FieldDef<GqlContext>> = { clientMutationId: { type: 'String' } };
  for (const [name, type] of Object.entries(fields)) out[name] = { type };
  return { kind: 'OBJECT', fields: out };
}

function mutationInput(args: Args): Record<string, unknown> {
  return record(args.input);
}

const mutationFields: Record<string, FieldDef<GqlContext>> = {
  createIssue: {
    type: 'CreateIssuePayload',
    args: { input: 'CreateIssueInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const { repo } = requireNode(ctx, input.repositoryId, 'Repository');
      const issue = attempt(() => ctx.forge.createIssue(repo, { title: input.title, body: input.body, labels: labelIdsToNames(repo, input.labelIds) }));
      return { clientMutationId: input.clientMutationId ?? null, issue: issueNode(repo, issue) };
    },
  },
  updateIssue: {
    type: 'UpdateIssuePayload',
    args: { input: 'UpdateIssueInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.id, 'Issue');
      const patch: Record<string, unknown> = {};
      if (typeof input.title === 'string') patch.title = input.title;
      if (typeof input.body === 'string') patch.body = input.body;
      if (typeof input.state === 'string') patch.state = input.state.toLowerCase();
      if (Array.isArray(input.labelIds)) patch.labels = labelIdsToNames(node.repo, input.labelIds);
      attempt(() => ctx.forge.updateIssue(node.repo, node.issue, patch));
      return { clientMutationId: input.clientMutationId ?? null, issue: node };
    },
  },
  closeIssue: {
    type: 'CloseIssuePayload',
    args: { input: 'CloseIssueInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.issueId, 'Issue');
      const reason = text(input.stateReason)?.toLowerCase() ?? 'completed';
      attempt(() => ctx.forge.updateIssue(node.repo, node.issue, { state: 'closed', state_reason: reason }));
      return { clientMutationId: input.clientMutationId ?? null, issue: node };
    },
  },
  reopenIssue: {
    type: 'ReopenIssuePayload',
    args: { input: 'ReopenIssueInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.issueId, 'Issue');
      attempt(() => ctx.forge.updateIssue(node.repo, node.issue, { state: 'open' }));
      return { clientMutationId: input.clientMutationId ?? null, issue: node };
    },
  },
  addComment: {
    type: 'AddCommentPayload',
    args: { input: 'AddCommentInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = findNode(ctx, input.subjectId);
      if (node === null || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
        throw new FieldError(`Could not resolve to a node with the global id of '${String(input.subjectId)}'.`, 'NOT_FOUND');
      }
      const number = node.__typename === 'Issue' ? node.issue.number : node.pull.number;
      const comment = attempt(() => ctx.forge.addComment(node.repo, number, input.body));
      const commentNode: CommentNode = { __typename: 'IssueComment', repo: node.repo, number, comment };
      const holder = node.__typename === 'Issue' ? node.issue : node.pull;
      const edge = { cursor: cursorOf(holder.comments.length - 1), node: commentNode };
      return { clientMutationId: input.clientMutationId ?? null, commentEdge: edge, subject: node, timelineEdge: edge };
    },
  },
  createPullRequest: {
    type: 'CreatePullRequestPayload',
    args: { input: 'CreatePullRequestInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const { repo } = requireNode(ctx, input.repositoryId, 'Repository');
      const pull = attempt(() => ctx.forge.createPull(repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName, draft: input.draft }));
      return { clientMutationId: input.clientMutationId ?? null, pullRequest: pullNode(repo, pull) };
    },
  },
  mergePullRequest: {
    type: 'MergePullRequestPayload',
    args: { input: 'MergePullRequestInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.pullRequestId, 'PullRequest');
      attempt(() => ctx.forge.mergePull(node.repo, node.pull, {
        merge_method: (text(input.mergeMethod) ?? 'MERGE').toLowerCase(),
        commit_title: input.commitHeadline,
        commit_message: input.commitBody,
        sha: input.expectedHeadOid,
      }));
      return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
    },
  },
  closePullRequest: {
    type: 'ClosePullRequestPayload',
    args: { input: 'ClosePullRequestInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.pullRequestId, 'PullRequest');
      attempt(() => ctx.forge.updatePull(node.repo, node.pull, { state: 'closed' }));
      return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
    },
  },
  updatePullRequest: {
    type: 'UpdatePullRequestPayload',
    args: { input: 'UpdatePullRequestInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const node = requireNode(ctx, input.pullRequestId, 'PullRequest');
      const patch: Record<string, unknown> = {};
      if (typeof input.title === 'string') patch.title = input.title;
      if (typeof input.body === 'string') patch.body = input.body;
      if (typeof input.baseRefName === 'string') patch.base = input.baseRefName;
      if (typeof input.state === 'string') patch.state = input.state.toLowerCase();
      attempt(() => ctx.forge.updatePull(node.repo, node.pull, patch));
      return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
    },
  },
  createRepository: {
    type: 'CreateRepositoryPayload',
    args: { input: 'CreateRepositoryInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const repo = attempt(() => ctx.forge.createRepo({ name: input.name, description: input.description, private: input.visibility === 'PRIVATE' }));
      return { clientMutationId: input.clientMutationId ?? null, repository: repoNode(repo) };
    },
  },
  createRef: {
    type: 'CreateRefPayload',
    args: { input: 'CreateRefInput!' },
    resolve: (_root: null, args, ctx) => {
      const input = mutationInput(args);
      const { repo } = requireNode(ctx, input.repositoryId, 'Repository');
      const ref = attempt(() => ctx.forge.createRef(repo, input.name, input.oid));
      return { clientMutationId: input.clientMutationId ?? null, ref: refNode(repo, ref) };
    },
  },
};

const NODE_TYPES = ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Ref', 'Commit'];

export const SCHEMA: Schema<GqlContext> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!', resolve: (_root: null, _args, ctx) => viewerNode(ctx) },
      user: { type: 'User', args: { login: 'String!' }, resolve: (_root: null, args, ctx) => (ctx.forge.store.owns(text(args.login) ?? '') ? viewerNode(ctx) : null) },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, resolve: (_root: null, args, ctx) => (ctx.forge.store.owns(text(args.login) ?? '') ? viewerNode(ctx) : null) },
      repository: {
        type: 'Repository',
        args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
        resolve: (_root: null, args, ctx) => {
          const repo = ctx.forge.store.repo(text(args.owner) ?? '', text(args.name) ?? '');
          return repo === null ? null : repoNode(repo);
        },
      },
      node: { type: 'Node', args: { id: 'ID!' }, resolve: (_root: null, args, ctx) => findNode(ctx, args.id) },
      nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, resolve: (_root: null, args, ctx) => strings(args.ids).map((id) => findNode(ctx, id)) },
      search: {
        type: 'SearchResultItemConnection!',
        args: { ...connectionArgs, query: 'String!', type: 'SearchType!' },
        resolve: (_root: null, args, ctx) => search(ctx, args),
      },
      rateLimit: { type: 'RateLimit', args: { dryRun: 'Boolean' }, resolve: () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2030-01-01T00:00:00Z', nodeCount: 0 }) },
    },
  },
  Mutation: { kind: 'OBJECT', fields: mutationFields },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } }, possibleTypes: NODE_TYPES },
  RepositoryOwner: { kind: 'INTERFACE', fields: { id: userFields.id!, login: userFields.login!, url: userFields.url!, avatarUrl: userFields.avatarUrl!, repository: userFields.repository!, repositories: userFields.repositories! }, possibleTypes: ['User'] },
  Actor: { kind: 'INTERFACE', fields: { login: userFields.login!, url: userFields.url!, avatarUrl: userFields.avatarUrl! }, possibleTypes: ['User'] },
  IssueOrPullRequest: { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest'] },
  SearchResultItem: { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest', 'Repository'] },
  User: { kind: 'OBJECT', fields: userFields, interfaces: ['Node', 'Actor', 'RepositoryOwner'] },
  Repository: { kind: 'OBJECT', fields: repoFields, interfaces: ['Node'] },
  Issue: { kind: 'OBJECT', fields: issueFields, interfaces: ['Node'] },
  PullRequest: { kind: 'OBJECT', fields: pullFields, interfaces: ['Node'] },
  IssueComment: { kind: 'OBJECT', fields: commentFields, interfaces: ['Node'] },
  Label: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (node: LabelNode) => node.label.nodeId },
      name: { type: 'String!', resolve: (node: LabelNode) => node.label.name },
      color: { type: 'String!', resolve: (node: LabelNode) => node.label.color },
      description: { type: 'String', resolve: (node: LabelNode) => node.label.description },
      isDefault: { type: 'Boolean!', resolve: () => false },
    },
  },
  Ref: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (node: RefNode) => `REF_kwDO${Buffer.from(`ref:${node.repo.id}:${node.ref}`).toString('base64url')}` },
      name: { type: 'String!', resolve: (node: RefNode) => node.ref.replace(/^refs\/(heads|tags)\//, '') },
      prefix: { type: 'String!', resolve: (node: RefNode) => node.ref.slice(0, node.ref.length - node.ref.replace(/^refs\/(heads|tags)\//, '').length) },
      target: { type: 'Commit', resolve: (node: RefNode): CommitNode => ({ __typename: 'Commit', repo: node.repo, oid: node.oid }) },
      repository: { type: 'Repository!', resolve: (node: RefNode) => repoNode(node.repo) },
    },
  },
  Commit: { kind: 'OBJECT', fields: commitFields, interfaces: ['Node'] },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!', resolve: (node: FileNode) => node.change.path },
      additions: { type: 'Int!', resolve: (node: FileNode) => node.change.additions },
      deletions: { type: 'Int!', resolve: (node: FileNode) => node.change.deletions },
      changeType: { type: 'PatchStatus!', resolve: (node: FileNode) => ({ added: 'ADDED', removed: 'DELETED', modified: 'MODIFIED' })[node.change.status] },
    },
  },
  PullRequestCommit: { kind: 'OBJECT', fields: { commit: { type: 'Commit!' } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, resetAt: { type: 'DateTime!' }, nodeCount: { type: 'Int!' } },
  },
  Language: { kind: 'OBJECT', fields: { name: { type: 'String!' }, color: { type: 'String' } } },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      issueCount: { type: 'Int!' },
      repositoryCount: { type: 'Int!' },
      nodes: { type: '[SearchResultItem]' },
      edges: { type: '[SearchResultItemEdge]' },
      pageInfo: { type: 'PageInfo!' },
    },
  },
  SearchResultItemEdge: { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: 'SearchResultItem' } } },
  ...connectionTypes('Repository', 'Repository'),
  ...connectionTypes('Issue', 'Issue'),
  ...connectionTypes('PullRequest', 'PullRequest'),
  ...connectionTypes('PullRequestChangedFile', 'PullRequestChangedFile'),
  ...connectionTypes('PullRequestCommit', 'PullRequestCommit'),
  ...connectionTypes('IssueComment', 'IssueComment'),
  ...connectionTypes('Label', 'Label'),
  ...connectionTypes('User', 'User'),
  ...connectionTypes('Ref', 'Ref'),
  CreateIssuePayload: payload({ issue: 'Issue' }),
  UpdateIssuePayload: payload({ issue: 'Issue' }),
  CloseIssuePayload: payload({ issue: 'Issue' }),
  ReopenIssuePayload: payload({ issue: 'Issue' }),
  AddCommentPayload: payload({ commentEdge: 'IssueCommentEdge', subject: 'Node', timelineEdge: 'IssueCommentEdge' }),
  CreatePullRequestPayload: payload({ pullRequest: 'PullRequest' }),
  MergePullRequestPayload: payload({ pullRequest: 'PullRequest' }),
  ClosePullRequestPayload: payload({ pullRequest: 'PullRequest' }),
  UpdatePullRequestPayload: payload({ pullRequest: 'PullRequest' }),
  CreateRepositoryPayload: payload({ repository: 'Repository' }),
  CreateRefPayload: payload({ ref: 'Ref' }),
  CreateIssueInput: inputType({ repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', milestoneId: 'ID', clientMutationId: 'String' }),
  UpdateIssueInput: inputType({ id: 'ID!', title: 'String', body: 'String', state: 'IssueState', labelIds: '[ID!]', clientMutationId: 'String' }),
  CloseIssueInput: inputType({ issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' }),
  ReopenIssueInput: inputType({ issueId: 'ID!', clientMutationId: 'String' }),
  AddCommentInput: inputType({ subjectId: 'ID!', body: 'String!', clientMutationId: 'String' }),
  CreatePullRequestInput: inputType({ repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' }),
  MergePullRequestInput: inputType({ pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' }),
  ClosePullRequestInput: inputType({ pullRequestId: 'ID!', clientMutationId: 'String' }),
  UpdatePullRequestInput: inputType({ pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestUpdateState', clientMutationId: 'String' }),
  CreateRepositoryInput: inputType({ name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', clientMutationId: 'String' }),
  CreateRefInput: inputType({ repositoryId: 'ID!', name: 'String!', oid: 'GitObjectID!', clientMutationId: 'String' }),
  IssueOrder: inputType({ field: 'IssueOrderField!', direction: 'OrderDirection!' }),
  IssueFilters: inputType({ states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String', since: 'DateTime' }),
  IssueCommentOrder: inputType({ field: 'String!', direction: 'OrderDirection!' }),
  LabelOrder: inputType({ field: 'String!', direction: 'OrderDirection!' }),
  RefOrder: inputType({ field: 'String!', direction: 'OrderDirection!' }),
  RepositoryOrder: inputType({ field: 'String!', direction: 'OrderDirection!' }),
  IssueState: enumType('OPEN', 'CLOSED'),
  IssueStateReason: enumType('COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'),
  IssueClosedStateReason: enumType('COMPLETED', 'NOT_PLANNED', 'DUPLICATE'),
  PullRequestState: enumType('OPEN', 'CLOSED', 'MERGED'),
  PullRequestUpdateState: enumType('OPEN', 'CLOSED'),
  MergeableState: enumType('MERGEABLE', 'CONFLICTING', 'UNKNOWN'),
  PullRequestMergeMethod: enumType('MERGE', 'SQUASH', 'REBASE'),
  RepositoryPermission: enumType('ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'),
  RepositoryVisibility: enumType('PRIVATE', 'PUBLIC', 'INTERNAL'),
  RepositoryAffiliation: enumType('OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'),
  RepositoryPrivacy: enumType('PUBLIC', 'PRIVATE'),
  SearchType: enumType('ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'),
  IssueOrderField: enumType('CREATED_AT', 'UPDATED_AT', 'COMMENTS'),
  OrderDirection: enumType('ASC', 'DESC'),
  PatchStatus: enumType('ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'),
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  GitSSHRemote: { kind: 'SCALAR' },
};

export const EXECUTOR = new Executor<GqlContext>(SCHEMA);
