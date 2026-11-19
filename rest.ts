// The REST v3 surface: repositories, branches, commits, contents, issues, comments, labels, pull
// requests, files and merges. Every reply is JSON, carries an X-GitHub-Request-Id, and answers a
// wrong or missing bearer token with 401 — the token names one login, and a repository belongs to
// the login the token names, so the same name under another owner is a 404, never a 403.
//
// The shapes are GitHub's own field names because that is what the suite and a real `gh` read.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  commitFiles,
  commitInfo,
  createCommit,
  commitTreeOnly,
  flattenTree,
  getObject,
  headRef,
  peelToCommit,
  putObject,
  resolveCommit,
  shortRef,
} from './store.ts';

/** The JSON content type every reply carries. */
export const JSON_TYPE = 'application/json; charset=utf-8';

/** A parsed path segment list, relative to /api/v3. */
export type Segments = readonly string[];

/** Answer one request: status, the body already serialised, and any extra headers. */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Everything a REST handler needs: the forge, the caller's login and the request's query. */
export interface RestContext {
  readonly forge: Forge;
  readonly login: string;
  readonly query: URLSearchParams;
  readonly body: () => Promise<unknown>;
  readonly method: string;
  readonly req: IncomingMessage;
}

// ----------------------------------------------------------------------------- small helpers

/** A JSON 404 body, GitHub's own wording. */
export function notFound(): Reply {
  return { status: 404, body: { message: 'Not Found' } };
}

/** A JSON error with a message. */
export function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** A SHA-1 shaped id, or '' when the text is not one. */
function asSha(text: unknown): string {
  return typeof text === 'string' && /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : '';
}

/** A string field of a JSON body, or the fallback. */
function str(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

/** A boolean field of a JSON body. */
function bool(body: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** The body as a plain record, or null when it is not one. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ----------------------------------------------------------------------------- serialisers

/** A repository as GitHub's repository object: the fields the suite reads, plus the usual rest. */
export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@makefun.invalid:${repo.owner}/${repo.name}.git`,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    open_issues: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    permissions: { admin: true, push: true, pull: true },
  };
}

/** A user as GitHub's simple-user object. */
export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1,
    node_id: 'U_1',
    avatar_url: 'https://makefun.invalid/avatar.png',
    type: 'User',
    site_admin: false,
    url: `https://makefun.invalid/api/v3/users/${login}`,
  };
}

/** A label as GitHub's label object. */
function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `LA_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

/** An issue as GitHub's issue object. */
export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
    author_association: 'OWNER',
  };
}

/** A comment as GitHub's issue-comment object. */
function commentJson(repo: Repo, comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    author_association: 'OWNER',
  };
}

/** A pull request as GitHub's pull-request object, with the head and base the suite reads. */
export function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const headSha = resolveCommit(repo, pull.head) ?? pull.headShaAtOpen ?? '';
  const baseSha = resolveCommit(repo, pull.base) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, base),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: baseSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, base),
    },
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    mergeable: !pull.merged,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merged_by: pull.merged ? userJson(repo.owner) : null,
    maintainer_can_modify: false,
  };
}

// ----------------------------------------------------------------------------- pagination

/** The page window a request asks for. */
function pageWindow(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** The `Link: <url>; rel="next"` header, when another page follows. */
function linkHeader(req: IncomingMessage, query: URLSearchParams, total: number, perPage: number, page: number): Record<string, string> {
  if (page * perPage >= total) return {};
  const host = req.headers.host ?? 'localhost';
  const scheme = 'http';
  const path = (req.url ?? '/').split('?')[0] as string;
  const next = new URL(`${scheme}://${host}${path}`);
  for (const [key, value] of query.entries()) if (key !== 'page') next.searchParams.append(key, value);
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(page + 1));
  return { link: `<${next.toString()}>; rel="next"` };
}

// ----------------------------------------------------------------------------- routing

/** Route one /api/v3 request. The caller has already authenticated it. */
export async function routeRest(context: RestContext, segments: Segments, base: string): Promise<Reply> {
  const { forge, login, method, query } = context;

  // GET /api/v3/ — the API root, with the token's scopes.
  if (segments.length === 0) {
    return {
      status: 200,
      body: {
        current_user_url: `${base}/api/v3/user`,
        current_user_authorizations_html_url: `${base}/settings/connections/applications{/client_id}`,
        authorizations_url: `${base}/api/v3/authorizations`,
        repositories_url: `${base}/api/v3/user/repos`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        user_url: `${base}/api/v3/users/{user}`,
        organization_url: `${base}/api/v3/orgs/{org}`,
        issues_url: `${base}/api/v3/issues`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    return { status: 200, body: { installed_version: '3.0.0-makefun', verifiable_password_authentication: true, ssh_key_fingerprints: {}, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [] } };
  }

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    const limit = 5000;
    return { status: 200, body: { resources: { core: { limit, remaining: limit, reset: 0, used: 0 } }, rate: { limit, remaining: limit, reset: 0, used: 0 } } };
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    return userRepos(context, base);
  }

  if (segments[0] === 'user' && segments.length === 1) {
    return { status: 200, body: { ...userJson(login), public_repos: forge.list().length, total_private_repos: forge.list().length, owned_private_repos: forge.list().length } };
  }

  if (segments[0] === 'users' && segments[1] !== undefined) {
    const wanted = segments[1];
    return { status: 200, body: { ...userJson(wanted), public_repos: 0 } };
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = forge.find(segments[1] as string, segments[2] as string);
    if (repo === null) return notFound();
    return routeRepo(context, repo, segments.slice(3), base);
  }

  if (segments[0] === 'orgs' && segments.length >= 2) {
    return { status: 200, body: { login: segments[1], id: 2, node_id: 'O_2', description: null, type: 'Organization' } };
  }

  return notFound();
}

/** GET and POST /api/v3/user/repos. */
async function userRepos(context: RestContext, base: string): Promise<Reply> {
  const { forge, query, method, req } = context;
  if (method === 'GET') {
    const all = forge.list();
    const { perPage, page } = pageWindow(query);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return {
      status: 200,
      body: slice.map((repo) => repoJson(repo, base)),
      headers: linkHeader(req, query, all.length, perPage, page),
    };
  }
  if (method === 'POST') {
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const name = str(body, 'name').trim();
    if (name === '') return errorReply(422, 'Repository creation failed: name is required');
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return errorReply(422, 'Repository creation failed: name is invalid');
    const repo = forge.create(name, {
      description: str(body, 'description'),
      private: bool(body, 'private'),
      defaultBranch: str(body, 'default_branch', 'main') || 'main',
    });
    if (repo === null) return errorReply(422, 'Repository creation failed: name already exists on this account');
    return { status: 201, body: repoJson(repo, base) };
  }
  return errorReply(405, 'Method Not Allowed');
}

/** Everything under /api/v3/repos/{owner}/{repo}. */
async function routeRepo(context: RestContext, repo: Repo, rest: Segments, base: string): Promise<Reply> {
  const { method, query, forge } = context;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo, base) };
    if (method === 'PATCH') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) return errorReply(422, 'Repository update failed: renaming is not supported');
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      repo.updatedAt = forge.clock.now();
      return { status: 200, body: repoJson(repo, base) };
    }
    if (method === 'DELETE') {
      forge.destroy(repo);
      return { status: 204 };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const [head, second, third, ...tail] = rest;

  if (head === 'branches' && second === undefined) {
    return { status: 200, body: listBranches(repo, base) };
  }

  if (head === 'branches' && second !== undefined && third === undefined) {
    const entry = listBranches(repo, base).find((branch) => branch.name === second);
    return entry === undefined ? notFound() : { status: 200, body: entry };
  }

  if (head === 'git' && second === 'refs') {
    return gitRefs(context, repo, third === undefined ? [] : [third, ...tail], base);
  }

  if (head === 'commits' && second === undefined) {
    const shaParam = query.get('sha') ?? query.get('ref');
    const commit = shaParam === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : resolveCommit(repo, shaParam);
    if (commit === null) return errorReply(404, 'No commit found for SHA: ' + (shaParam ?? 'default branch'));
    return { status: 200, body: listCommits(repo, commit, base) };
  }

  if (head === 'commits' && second !== undefined && third === undefined) {
    const commit = resolveCommit(repo, second) ?? (asSha(second) === second ? second : null);
    if (commit === null || commitInfo(repo, commit) === null) return notFound();
    return { status: 200, body: commitJson(repo, commit, base) };
  }

  if (head === 'contents') {
    const path = second === undefined ? '' : [second, third, ...tail].filter((part): part is string => part !== undefined).join('/');
    return contents(context, repo, path, base);
  }

  if (head === 'labels') {
    return labels(context, repo, second, base);
  }

  if (head === 'issues') {
    return issues(context, repo, rest.slice(1), base);
  }

  if (head === 'pulls') {
    return pulls(context, repo, rest.slice(1), base);
  }

  if (head === 'git' && second === 'commits') {
    if (method !== 'POST') return errorReply(405, 'Method Not Allowed');
    return createGitCommit(context, repo, base);
  }

  return notFound();
}

/** The repository's branches, default first then by name. */
function listBranches(repo: Repo, base: string): { name: string; commit: Record<string, unknown>; protected: boolean }[] {
  const names = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map(shortRef)
    .sort();
  return names.map((name) => {
    const sha = repo.refs.get(headRef(name)) as string;
    return {
      name,
      commit: { sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: name === repo.defaultBranch,
    };
  });
}

/** POST /git/refs and GET /git/ref/{ref}: create a branch, or read one. */
async function gitRefs(context: RestContext, repo: Repo, rest: Segments, base: string): Promise<Reply> {
  const { method } = context;

  if (rest[0] === 'ref' && rest.length === 2) {
    // GET /git/ref/refs/heads/main — the ref path may arrive with slashes.
    const name = rest.slice(1).join('/');
    const value = repo.refs.get(name) ?? repo.refs.get(headRef(name));
    if (value === undefined) return notFound();
    return { status: 200, body: refJson(name, value, repo, base) };
  }

  if (method === 'POST' && rest.length === 0) {
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const ref = str(body, 'ref');
    const sha = asSha(str(body, 'sha'));
    if (ref === '' || !ref.startsWith('refs/')) return errorReply(422, 'Reference update failed: ref is not a full ref name');
    if (sha === '' || getObject(repo, sha) === null) return errorReply(422, 'Reference update failed: sha is not an object here');
    if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, body: refJson(ref, sha, repo, base) };
  }

  if (method === 'PATCH' && rest.length === 1) {
    const name = rest[0] as string;
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const sha = asSha(str(body, 'sha'));
    const force = bool(body, 'force');
    const current = repo.refs.get(name) ?? repo.refs.get(headRef(name));
    if (current === undefined) return notFound();
    if (sha === '' || getObject(repo, sha) === null) return errorReply(422, 'Reference update failed: sha is not an object here');
    if (!force && !isAncestor(repo, current, sha)) return errorReply(422, 'Update is not a fast forward');
    repo.refs.set(name, sha);
    return { status: 200, body: refJson(name, sha, repo, base) };
  }

  return notFound();
}

/** True when `older` is `newer` or one of its ancestors. */
function isAncestor(repo: Repo, older: string, newer: string): boolean {
  const seen = new Set<string>();
  const queue = [newer];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (sha === older) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  return false;
}

/** A git ref object. */
function refJson(ref: string, sha: string, repo: Repo, base: string): Record<string, unknown> {
  const objectType = getObject(repo, sha)?.type ?? 'commit';
  return {
    ref,
    node_id: `REF_${ref}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
    object: { type: objectType, sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType}s/${sha}` },
  };
}

/** A commit object's REST view. */
function commitJson(repo: Repo, sha: string, base: string): Record<string, unknown> {
  const payload = getObject(repo, sha)?.data.toString('utf8') ?? '';
  const split = payload.indexOf('\n\n');
  const headText = split < 0 ? payload : payload.slice(0, split);
  const message = split < 0 ? '' : payload.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of headText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: identityJson(authorLine),
      committer: identityJson(committerLine),
      message,
      tree: { sha: tree, url: `${url}/git/trees/${tree}` },
      url: `${url}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${url}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    parents: parents.map((parent) => ({ sha: parent, url: `${url}/commits/${parent}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
}

/** One git identity line as GitHub's {name, email, date}. */
function identityJson(line: string): Record<string, unknown> {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: 'makefun', email: 'bot@makefun.invalid', date: '1970-01-01T00:00:00Z' };
  const epoch = Number(match[3]);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

/** The commit log from a tip back to the first root, newest first, capped. */
function listCommits(repo: Repo, tip: string, base: string): Record<string, unknown>[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: { sha: string; depth: number }[] = [{ sha: tip, depth: 0 }];
  while (queue.length > 0 && order.length < 400) {
    queue.sort((left, right) => left.depth - right.depth);
    const next = queue.shift() as { sha: string; depth: number };
    if (seen.has(next.sha)) continue;
    seen.add(next.sha);
    order.push(next.sha);
    const info = commitInfo(repo, next.sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push({ sha: parent, depth: next.depth + 1 });
  }
  return order.map((sha) => commitJson(repo, sha, base));
}

/** GET, PUT and DELETE /contents/{path}. */
async function contents(context: RestContext, repo: Repo, path: string, base: string): Promise<Reply> {
  const { method, query } = context;
  const refParam = query.get('ref');
  const branch = refParam === null ? repo.defaultBranch : refParam;
  const tip = resolveCommit(repo, branch);
  const parent = tip === null ? null : commitInfo(repo, tip)?.tree ?? null;
  const files = parent === null ? new Map<string, { mode: string; sha: string }>() : flattenTree(repo, parent);

  if (method === 'GET') {
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '' || clean === '.') {
      return { status: 200, body: directoryListing(repo, files, '', base) };
    }
    const exact = files.get(clean);
    if (exact !== undefined) return { status: 200, body: fileJson(repo, clean, exact, base) };
    // A directory: every path under it, grouped by its immediate child.
    if ([...files.keys()].some((candidate) => candidate.startsWith(`${clean}/`))) {
      return { status: 200, body: directoryListing(repo, files, clean, base) };
    }
    return notFound();
  }

  if (method === 'PUT') {
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const message = str(body, 'message', 'Update file');
    const content = str(body, 'content');
    const encoding = str(body, 'encoding', 'base64');
    let bytes: Buffer;
    try {
      bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    } catch {
      return errorReply(422, 'Content is not valid base64');
    }
    const targetBranch = str(body, 'branch', '') || repo.defaultBranch;
    const currentTip = resolveCommit(repo, targetBranch);
    const currentFiles = flattenTree(repo, commitInfo(repo, currentTip ?? '')?.tree ?? '');
    const existing = currentFiles.get(path);
    const providedSha = asSha(str(body, 'sha'));
    if (existing !== undefined && providedSha === '') {
      return errorReply(422, `Invalid request.\n\n"sha" wasn't supplied.`);
    }
    if (existing !== undefined && providedSha !== '' && providedSha !== existing.sha) {
      return errorReply(409, `${path} does not match ${providedSha}`);
    }
    if (existing === undefined && providedSha !== '') {
      return errorReply(422, `Invalid request.\n\nsha ${providedSha} does not exist for ${path}`);
    }
    const changes = new Map<string, Buffer | null>();
    changes.set(path, bytes);
    const commitSha = commitFiles(repo, headRef(targetBranch), currentTip, changes, message, {
      name: 'makefun',
      email: 'bot@makefun.invalid',
      epoch: forgeEpoch(repo),
    });
    repo.updatedAt = repo.clock.now();
    // The ref may not have existed: a first contents commit creates the default branch.
    const contentSha = putObject(repo, 'blob', bytes);
    return {
      status: existing === undefined ? 201 : 200,
      body: {
        content: { name: path.split('/').pop() ?? path, path, sha: contentSha, size: bytes.length, encoding: 'base64', type: 'file', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` },
        commit: { sha: commitSha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitSha}` },
      },
    };
  }

  if (method === 'DELETE') {
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const message = str(body, 'message', 'Delete file');
    const targetBranch = str(body, 'branch', '') || repo.defaultBranch;
    const currentTip = resolveCommit(repo, targetBranch);
    const currentFiles = flattenTree(repo, commitInfo(repo, currentTip ?? '')?.tree ?? '');
    if (!currentFiles.has(path)) return notFound();
    const changes = new Map<string, Buffer | null>();
    changes.set(path, null);
    const commitSha = commitFiles(repo, headRef(targetBranch), currentTip, changes, message, {
      name: 'makefun',
      email: 'bot@makefun.invalid',
      epoch: forgeEpoch(repo),
    });
    return { status: 200, body: { content: null, commit: { sha: commitSha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitSha}` } } };
  }

  return errorReply(405, 'Method Not Allowed');
}

/** The store's next commit epoch, monotone so two commits never share one. */
function forgeEpoch(repo: Repo): number {
  return repo.clock.epoch();
}

/** One file's REST view: base64 content and its blob id. */
function fileJson(repo: Repo, path: string, entry: { mode: string; sha: string }, base: string): Record<string, unknown> {
  const object = getObject(repo, entry.sha);
  const bytes = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: path.split('/').pop() ?? path,
    path,
    content: bytes.toString('base64'),
    sha: entry.sha,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

/** One directory's REST view: its immediate entries, files and sub-directories. */
function directoryListing(repo: Repo, files: Map<string, { mode: string; sha: string }>, prefix: string, base: string): Record<string, unknown>[] {
  const prefixWithSlash = prefix === '' ? '' : `${prefix}/`;
  const entries = new Map<string, Record<string, unknown>>();
  for (const [path, value] of files) {
    if (!path.startsWith(prefixWithSlash)) continue;
    const restPath = path.slice(prefixWithSlash.length);
    const slash = restPath.indexOf('/');
    if (slash < 0) {
      const object = getObject(repo, value.sha);
      entries.set(restPath, {
        type: 'file',
        size: object?.data.length ?? 0,
        name: restPath,
        path,
        sha: value.sha,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${value.sha}`,
        download_url: null,
      });
      continue;
    }
    const dirName = restPath.slice(0, slash);
    if (entries.has(dirName)) continue;
    entries.set(dirName, {
      type: 'dir',
      size: 0,
      name: dirName,
      path: prefixWithSlash === '' ? dirName : `${prefix}/${dirName}`,
      sha: dirTreeSha(repo, files, prefixWithSlash === '' ? dirName : `${prefix}/${dirName}`),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefixWithSlash === '' ? dirName : `${prefix}/${dirName}`}`,
      html_url: `${base}/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${prefixWithSlash === '' ? dirName : `${prefix}/${dirName}`}`,
    });
  }
  return [...entries.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)).map((entry) => entry[1]);
}

/** A sub-directory's tree id: present so a listing's sha is a 40-hex id. */
function dirTreeSha(repo: Repo, files: Map<string, { mode: string; sha: string }>, dir: string): string {
  const entries = [...files.entries()]
    .filter(([path]) => path.startsWith(`${dir}/`))
    .map(([path, value]) => `${value.mode} ${path} ${value.sha}`)
    .sort()
    .join('\n');
  return putObject(repo, 'blob', Buffer.from(entries));
}

/** POST /git/commits: write a commit object over a tree. */
async function createGitCommit(context: RestContext, repo: Repo, base: string): Promise<Reply> {
  const body = record(await context.body());
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const tree = asSha(str(body, 'tree'));
  if (tree === '' || getObject(repo, tree) === null) return errorReply(422, 'tree is not an object here');
  const message = str(body, 'message', '');
  const parents = Array.isArray(body.parents) ? body.parents.map((parent) => asSha(parent)).filter((sha) => sha !== '') : [];
  const sha = createCommit(repo, { tree, parents, message, authorEpoch: forgeEpoch(repo) });
  return { status: 201, body: commitJson(repo, sha, base) };
}

// ----------------------------------------------------------------------------- labels

/** POST /labels and GET /labels. */
async function labels(context: RestContext, repo: Repo, second: string | undefined, base: string): Promise<Reply> {
  const { method } = context;
  if (second !== undefined) {
    const label = [...repo.labels.values()].find((entry) => entry.name === second || String(entry.id) === second);
    if (label === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: labelJson(label) };
    if (method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204 };
    }
    return errorReply(405, 'Method Not Allowed');
  }
  if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
  if (method === 'POST') {
    const body = record(await context.body());
    if (body === null) return errorReply(400, 'Problems parsing JSON');
    const name = str(body, 'name').trim();
    if (name === '') return errorReply(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: already_exists');
    const label: Label = {
      id: repo.nextLabel++,
      name,
      color: str(body, 'color', 'ededed').replace(/^#/, ''),
      description: str(body, 'description'),
    };
    repo.labels.set(name, label);
    return { status: 201, body: labelJson(label) };
  }
  return errorReply(405, 'Method Not Allowed');
}

// ----------------------------------------------------------------------------- issues

/** Everything under /issues. */
async function issues(context: RestContext, repo: Repo, rest: Segments, base: string): Promise<Reply> {
  const { method, query } = context;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((left, right) => compareIssues(left, right, sort, direction));
      const { perPage, page } = pageWindow(query);
      return { status: 200, body: list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue, base)) };
    }
    if (method === 'POST') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      const title = str(body, 'title');
      if (title === '') return errorReply(422, 'Validation Failed: title is required');
      const wanted = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const attached: Label[] = [];
      for (const name of wanted) {
        const label = repo.labels.get(name);
        if (label === undefined) return errorReply(422, `Validation Failed: {"resource":"Label","field":"name","code":"missing_field"} — ${name} does not exist`);
        attached.push(label);
      }
      const at = repo.clock.now();
      const issue: Issue = {
        id: repo.nextIssue * 1000 + repo.id,
        number: repo.nextIssue++,
        title,
        body: str(body, 'body'),
        state: 'open',
        labels: attached,
        user: context.login,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        comments: 0,
      };
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(repo, issue, base) };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();

  if (rest[1] === 'comments') {
    const issue = repo.issues.get(number);
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      const list = [...repo.comments.values()].filter((comment) => comment.issue === number).sort((left, right) => left.id - right.id);
      return { status: 200, body: list.map((comment) => commentJson(repo, comment, base)) };
    }
    if (method === 'POST') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      const text = str(body, 'body');
      if (text === '') return errorReply(422, 'Validation Failed: body is required');
      const at = repo.clock.now();
      const comment = { id: repo.nextComment++, issue: number, body: text, user: context.login, createdAt: at, updatedAt: at };
      repo.comments.set(comment.id, comment);
      issue.comments += 1;
      issue.updatedAt = at;
      return { status: 201, body: commentJson(repo, comment, base) };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest.length === 1) {
    const issue = repo.issues.get(number);
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue, base) };
    if (method === 'PATCH') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? repo.clock.now() : null;
      }
      if (Array.isArray(body.labels)) {
        const attached: Label[] = [];
        for (const name of body.labels.filter((label): label is string => typeof label === 'string')) {
          const label = repo.labels.get(name);
          if (label === undefined) return errorReply(422, `Validation Failed: ${name} does not exist`);
          attached.push(label);
        }
        issue.labels = attached;
      }
      issue.updatedAt = repo.clock.now();
      return { status: 200, body: issueJson(repo, issue, base) };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  return notFound();
}

/** The order GET /issues sorts in. */
function compareIssues(left: Issue, right: Issue, sort: string, direction: string): number {
  const sign = direction === 'asc' ? 1 : -1;
  if (sort === 'updated') {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -sign : sign;
    return (left.number - right.number) * sign;
  }
  if (sort === 'comments') {
    if (left.comments !== right.comments) return left.comments < right.comments ? -sign : sign;
    return (left.number - right.number) * sign;
  }
  return (left.number - right.number) * sign;
}

// ----------------------------------------------------------------------------- pulls
/** Everything under /pulls. */
async function pulls(context: RestContext, repo: Repo, rest: Segments, base: string): Promise<Reply> {
  const { method, query } = context;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((left, right) => left.number - right.number);
      const { perPage, page } = pageWindow(query);
      return { status: 200, body: list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(repo, pull, base)) };
    }
    if (method === 'POST') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      const head = str(body, 'head').replace(/^[^:]+:/, '');
      const baseBranch = str(body, 'base', '') || repo.defaultBranch;
      if (head === '') return errorReply(422, 'Validation Failed: head is required');
      const headSha = resolveCommit(repo, head);
      if (headSha === null) return errorReply(422, `Validation Failed: head ${head} is not a branch here`);
      if (resolveCommit(repo, baseBranch) === null) return errorReply(422, `Validation Failed: base ${baseBranch} is not a branch here`);
      const at = repo.clock.now();
      const pull: Pull = {
        id: repo.nextPull * 1000 + repo.id,
        number: repo.nextPull++,
        title: str(body, 'title', '') || `${head} into ${baseBranch}`,
        body: str(body, 'body'),
        state: 'open',
        merged: false,
        head,
        base: baseBranch,
        user: context.login,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        mergedAt: null,
        mergeCommitSha: null,
        headShaAtOpen: headSha,
      };
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(repo, pull, base) };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull, base) };
    if (method === 'PATCH') {
      const body = record(await context.body());
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      if (typeof body.title === 'string' && body.title !== '') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAt = repo.clock.now();
      }
      if (body.state === 'open' && pull.state === 'closed' && !pull.merged) {
        pull.state = 'open';
        pull.closedAt = null;
      }
      pull.updatedAt = repo.clock.now();
      return { status: 200, body: pullJson(repo, pull, base) };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest[1] === 'files' && rest.length === 2) {
    return { status: 200, body: pullFiles(repo, pull) };
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return errorReply(405, 'Method Not Allowed');
    return mergePull(context, repo, pull, base);
  }

  if (rest[1] === 'commits' && rest.length === 2) {
    const headSha = resolveCommit(repo, pull.head) ?? pull.headShaAtOpen;
    return { status: 200, body: headSha === null ? [] : listCommits(repo, headSha, base) };
  }

  return notFound();
}

/** The changed files a pull request's head holds against its base. */
function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headSha = resolveCommit(repo, pull.head) ?? pull.headShaAtOpen;
  const baseSha = resolveCommit(repo, pull.base);
  const headTree = headSha === null ? null : commitInfo(repo, headSha)?.tree ?? null;
  const baseTree = baseSha === null ? null : commitInfo(repo, baseSha)?.tree ?? null;
  const headFiles = headTree === null ? new Map() : flattenTree(repo, headTree);
  const baseFiles = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const rows: Record<string, unknown>[] = [];
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const beforeLines = lineCount(repo, before?.sha);
    const afterLines = lineCount(repo, after?.sha);
    const additions = after === undefined ? 0 : Math.max(0, afterLines - (before === undefined ? 0 : beforeLines)) || afterLines;
    const deletions = before === undefined ? 0 : after === undefined ? beforeLines : beforeLines;
    rows.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status,
      additions: status === 'added' ? Math.max(additions, 1) : Math.max(additions, 1),
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return rows;
}

/** How many lines a blob holds (0 when absent). */
function lineCount(repo: Repo, sha: string | undefined): number {
  if (sha === undefined) return 0;
  const object = getObject(repo, sha);
  if (object === null) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

/** PUT /pulls/{n}/merge: squash the head onto the base, or refuse a conflict with 405. */
async function mergePull(context: RestContext, repo: Repo, pull: Pull, base: string): Promise<Reply> {
  const body = record(await context.body().catch(() => null));
  const method = body === null ? 'merge' : str(body, 'merge_method', 'merge');
  if (pull.merged) return errorReply(405, 'Pull request is not mergeable: it is already merged');
  if (pull.state === 'closed') return errorReply(405, 'Pull request is not mergeable: it is closed');

  const headSha = resolveCommit(repo, pull.head);
  const baseSha = resolveCommit(repo, pull.base);
  if (headSha === null || baseSha === null) return errorReply(405, 'Pull request is not mergeable: a branch is gone');

  // A conflict is two branches that changed the same path differently since they parted.
  const headFiles = flattenTree(repo, commitInfo(repo, headSha)?.tree ?? '');
  const baseFiles = flattenTree(repo, commitInfo(repo, baseSha)?.tree ?? '');
  const mergeBase = commonAncestor(repo, headSha, baseSha);
  const baseOfMerge = mergeBase === null ? new Map<string, { mode: string; sha: string }>() : flattenTree(repo, commitInfo(repo, mergeBase)?.tree ?? '');
  for (const [path, value] of headFiles) {
    const ours = baseFiles.get(path);
    const original = baseOfMerge.get(path);
    if (ours === undefined || original === undefined) continue;
    if (ours.sha !== original.sha && value.sha !== original.sha && ours.sha !== value.sha) {
      return errorReply(405, 'Pull Request is not mergeable: the merge conflicts');
    }
  }
  for (const [path, value] of baseFiles) {
    const theirs = headFiles.get(path);
    const original = baseOfMerge.get(path);
    if (theirs === undefined && original !== undefined && value.sha !== original.sha) {
      return errorReply(405, 'Pull Request is not mergeable: the merge conflicts');
    }
  }

  // Squash: the head's files landed on the base in one commit.
  const changes = new Map<string, Buffer | null>();
  for (const [path, value] of headFiles) {
    const current = baseFiles.get(path);
    if (current !== undefined && current.sha === value.sha) continue;
    changes.set(path, getObject(repo, value.sha)?.data ?? Buffer.alloc(0));
  }
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) changes.set(path, null);

  const message = method === 'squash'
    ? `${pull.title} (#${pull.number})\n\n${pull.body === '' ? '' : `${pull.body}\n\n`}`
    : `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  // Write the merged tree without moving any ref: the merge commit goes on top of the base tip.
  const squashTree = commitTreeOnly(repo, baseSha, changes, { name: 'makefun', email: 'bot@makefun.invalid', epoch: repo.clock.epoch() });
  const mergeSha = createCommit(repo, {
    tree: squashTree,
    parents,
    message,
    authorEpoch: repo.clock.epoch(),
  });
  repo.refs.set(headRef(pull.base), mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = repo.clock.now();
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = mergeSha;
  return {
    status: 200,
    body: {
      sha: mergeSha,
      merged: true,
      message: 'Pull Request successfully merged',
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    },
  };
}

/** The newest commit both tips share, or null. */
function commonAncestor(repo: Repo, left: string, right: string): string | null {
  const ancestors = new Set<string>();
  const queue = [left];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  const visit = [right];
  const seen = new Set<string>();
  while (visit.length > 0) {
    const sha = visit.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    const info = commitInfo(repo, sha);
    if (info === null) continue;
    for (const parent of info.parents) visit.push(parent);
  }
  return null;
}
