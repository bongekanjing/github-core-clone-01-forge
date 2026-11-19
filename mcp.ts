// The Model Context Protocol endpoint at /mcp: the agent-native arm. It speaks the modern revision
// (server/discover, no handshake, revision in _meta) and answers plain JSON — the client accepts
// application/json as readily as an event stream, and a plain body keeps every answer's id easy to
// match. The tools are the six github-mcp-server names the suite drives, and each one's effect is a
// change in the same store the REST surface reads, so parity is structural rather than copied.

import type { Forge, Repo } from './store.ts';
import { resolveCommit } from './store.ts';
import { JSON_TYPE, issueJson, pullJson, repoJson } from './rest.ts';

/** The revision this server declares: the modern one, whose discovery RPC it answers. */
export const PROTOCOL_REVISION = '2026-07-28';

/** The revisions it will also answer in a handshake, newest first. */
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** The server's own identity, as tools/list and discover report it. */
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** The JSON-RPC error codes the suite checks against. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** One tool's definition: the name, its description, and its input schema. */
interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (context: ToolContext) => Promise<unknown>;
}

/** What one tool call has to work with. */
interface ToolContext {
  readonly forge: Forge;
  readonly login: string;
  readonly args: Record<string, unknown>;
  readonly base: string;
}

/** A string argument, accepting the suite's synonyms for a field. */
function arg(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** A boolean argument. */
function argBool(args: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** The repository a tool's arguments name, or a tool error. */
function repoOf(context: ToolContext): Repo {
  const args = context.args;
  const full = arg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  let owner = arg(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login');
  let name = arg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name');
  if (full.includes('/')) {
    const [fullOwner, fullName] = full.split('/');
    owner = owner === '' ? (fullOwner as string) : owner;
    name = name === '' ? (fullName as string) : name;
  }
  if (owner === '' || name === '') throw new ToolError('owner and repo are required');
  const repo = context.forge.find(owner, name);
  if (repo === null) throw new ToolError(`no repository ${owner}/${name}`);
  return repo;
}

/** A tool's own failure: reported to the caller as isError, never as a crash. */
export class ToolError extends Error {}

/** The tools this server offers, in a stable order so tools/list is byte-identical every time. */
function tools(): ToolSpec[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated login.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'A short description.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
        },
        required: ['name'],
      },
      run: async (context) => {
        const name = arg(context.args, 'name', 'repo', 'repository', 'repository_name');
        if (name === '') throw new ToolError('name is required');
        const repo = context.forge.create(name, {
          description: arg(context.args, 'description', 'about', 'summary'),
          private: argBool(context.args, 'private', 'is_private') ?? false,
        });
        if (repo === null) throw new ToolError(`a repository named ${name} already exists`);
        return repoJson(repo, context.base);
      },
    },
    {
      name: 'get_repo',
      description: 'Read one repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
        },
        required: ['owner', 'repo'],
      },
      run: async (context) => repoJson(repoOf(context), context.base),
    },
    {
      name: 'create_issue',
      description: 'Open an issue on a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
        },
        required: ['owner', 'repo', 'title'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const title = arg(context.args, 'title', 'subject');
        if (title === '') throw new ToolError('title is required');
        const issue = createIssueRecord(repo, context.login, title, arg(context.args, 'body', 'description', 'content'));
        return issueJson(repo, issue, context.base);
      },
    },
    {
      name: 'list_issues',
      description: 'List the issues of a repository, open by default.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          state: { type: 'string', description: 'open, closed or all.' },
        },
        required: ['owner', 'repo'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const state = arg(context.args, 'state', 'status') || 'open';
        let list = [...repo.issues.values()].sort((left, right) => left.number - right.number);
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        return list.map((issue) => issueJson(repo, issue, context.base));
      },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch onto a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The pull request title.' },
          head: { type: 'string', description: 'The branch holding the changes.' },
          base: { type: 'string', description: 'The branch to merge into.' },
          body: { type: 'string', description: 'The pull request body.' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const title = arg(context.args, 'title', 'subject');
        const head = arg(context.args, 'head', 'head_ref', 'head_branch', 'source_branch', 'from');
        const baseBranch = arg(context.args, 'base', 'base_ref', 'base_branch', 'target_branch', 'into') || repo.defaultBranch;
        if (title === '' || head === '') throw new ToolError('title and head are required');
        if (resolveCommit(repo, head) === null) throw new ToolError(`head ${head} is not a branch here`);
        const pull = createPullRecord(repo, context.login, title, arg(context.args, 'body', 'description'), head, baseBranch);
        return pullJson(repo, pull, context.base);
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request onto its base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          pull_number: { type: 'number', description: 'The pull request number.' },
          merge_method: { type: 'string', description: 'merge, squash or rebase.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const raw = context.args.pull_number ?? context.args.pull_request_number ?? context.args.number ?? context.args.pr_number;
        const number = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
        if (!Number.isInteger(number)) throw new ToolError('pull_number is required');
        const pull = repo.pulls.get(number);
        if (pull === undefined) throw new ToolError(`no pull request ${number}`);
        const merged = mergeRecord(repo, pull.number);
        if (merged === null) throw new ToolError(`pull request ${number} cannot be merged`);
        return { sha: merged, merged: true, message: 'Pull Request successfully merged' };
      },
    },
    {
      name: 'get_issue',
      description: 'Read one issue by its number.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          issue_number: { type: 'number', description: 'The issue number.' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const raw = context.args.issue_number ?? context.args.number;
        const number = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new ToolError(`no issue ${number}`);
        return issueJson(repo, issue, context.base);
      },
    },
    {
      name: 'create_branch',
      description: 'Create a branch at an existing commit.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          branch: { type: 'string', description: 'The new branch name.' },
          sha: { type: 'string', description: 'The commit the branch starts at.' },
        },
        required: ['owner', 'repo', 'branch'],
      },
      run: async (context) => {
        const repo = repoOf(context);
        const branch = arg(context.args, 'branch', 'name');
        if (branch === '') throw new ToolError('branch is required');
        const sha = arg(context.args, 'sha', 'ref') || (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '');
        if (sha === '') throw new ToolError('sha is required: the repository has no commit yet');
        repo.refs.set(`refs/heads/${branch}`, sha);
        return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
      },
    },
  ];
}

/** Open an issue in the store, the one place both REST and MCP create one. */
export function createIssueRecord(repo: Repo, login: string, title: string, body: string, labels: string[] = []) {
  const at = repo.clock.now();
  const issue = {
    id: repo.nextIssue * 1000 + repo.id,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open' as const,
    labels: labels.map((name) => repo.labels.get(name)).filter((label): label is NonNullable<typeof label> => label !== undefined),
    user: login,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    comments: 0,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Open a pull request in the store. */
export function createPullRecord(repo: Repo, login: string, title: string, body: string, head: string, base: string) {
  const at = repo.clock.now();
  const pull = {
    id: repo.nextPull * 1000 + repo.id,
    number: repo.nextPull++,
    title,
    body,
    state: 'open' as const,
    merged: false,
    head,
    base,
    user: login,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    headShaAtOpen: resolveCommit(repo, head),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Merge a pull request in the store, answering the merge commit's id. */
export function mergeRecord(repo: Repo, number: number): string | null {
  const pull = repo.pulls.get(number);
  if (pull === undefined || pull.merged) return null;
  const headSha = resolveCommit(repo, pull.head);
  const baseSha = resolveCommit(repo, pull.base);
  if (headSha === null || baseSha === null) return null;
  // The merge's tree is the head's tree when the base is an ancestor of the head; otherwise the
  // changed paths land on the base, which is the squash the REST route writes too.
  const merge = mergeTrees(repo, headSha, baseSha, `${pull.title} (#${pull.number})`);
  if (merge === null) return null;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = repo.clock.now();
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = merge;
  return merge;
}

/** Imported lazily to keep this module's tool table free of the tree machinery at load time. */
function mergeTrees(repo: Repo, headSha: string, baseSha: string, message: string): string | null {
  return mergeBranches(repo, headSha, baseSha, message);
}

import { mergeBranches } from './mergegraph.ts';

/** The tools/list result: the announced tools, in the order this server declares them. */
export function toolsListResult(): Record<string, unknown> {
  return {
    tools: tools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  };
}

/** One JSON-RPC message in, one JSON-RPC message out (or null for a notification). */
export async function handleRpc(body: unknown, forge: Forge, login: string, base: string): Promise<Record<string, unknown> | null> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    // A batch is the one array form a server may see; answer each member.
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } };
  }
  const message = body as Record<string, unknown>;
  const id = message.id ?? null;
  const isNotification = !('id' in message);
  const method = typeof message.method === 'string' ? message.method : '';
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};

  if (method === '') {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid Request: no method' } };
  }

  const fail = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });

  if (isNotification) {
    // notifications/initialized and friends need no answer.
    return null;
  }

  switch (method) {
    case 'server/discover':
      return ok({
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        supportedVersions: [PROTOCOL_REVISION, ...LEGACY_REVISIONS],
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_REVISION;
      const chosen = [PROTOCOL_REVISION, ...LEGACY_REVISIONS].includes(asked) ? asked : PROTOCOL_REVISION;
      return ok({ protocolVersion: chosen, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'tools/list':
      return ok(toolsListResult());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const spec = tools().find((tool) => tool.name === name);
      if (spec === undefined) return fail(METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = await spec.run({ forge, login, args, base });
        return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false, structuredContent: { result } });
      } catch (error) {
        if (error instanceof ToolError) {
          return ok({ content: [{ type: 'text', text: error.message }], isError: true });
        }
        return ok({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    case 'ping':
      return ok({});
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return fail(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** A JSON-RPC parse failure, for a body that is not JSON. */
export function parseError(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } };
}

/** The content type of an MCP answer (plain JSON: the client parses it without a stream). */
export const MCP_TYPE = JSON_TYPE;

export { INTERNAL_ERROR, INVALID_PARAMS };
