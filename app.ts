// The entry's server: the four surfaces the suite drives, over one process and one store.
//
// The lifecycle (bind an ephemeral port, register it with the env, poll until done) lives in main.ts.
// This file answers requests, in the order a request has to be told apart:
//
//   /healthz                     the env's boot probe
//   /api/graphql                 GraphQL v4
//   /api/v3/...                  REST v3
//   /mcp                         Model Context Protocol over streamable HTTP
//   /{owner}/{repo}.git/...      git smart HTTP (v2 and v0)
//   anything else                GitHub's JSON 404
//
// Authentication is checked before routing, the way a real API gateway does it: /healthz takes no
// token, every other path does. A missing token is a 401 with GitHub's body and a Www-Authenticate
// header; a wrong one is a 401 too. The suite's protocol checks look at both.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge } from './store.ts';
import { JSON_TYPE, routeRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { MCP_TYPE, handleRpc, parseError } from './mcp.ts';
import { handleGit, parseGitPath } from './gitserver.ts';
import { login as resolvedLogin } from './viewer.ts';

/** The JSON content type every REST reply carries. */
const JSON_UTF8 = JSON_TYPE;

/** The largest body this server will buffer: enough for a git push of a few megabytes. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token the suite presents, from the environment. */
function expectedToken(): string {
  return (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
}

/** The Authorization header's bearer value, or '' when it is absent or another scheme. */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const text = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(text);
  return match === null ? '' : (match[1] as string);
}

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_UTF8, 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

/** Read the whole request body, up to MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** A JSON body, or undefined when the text is not JSON (an empty body is undefined too). */
function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** GitHub's 401 body, with the header a real API sends. */
function unauthorized(res: ServerResponse, message = 'Requires authentication'): void {
  sendJson(res, 401, { message, documentation_url: 'https://docs.github.com/rest' }, {
    'www-authenticate': 'Bearer realm="GitHub", error="invalid_token"',
  });
}

/** GitHub's 404 body: the answer to every path this forge does not serve. */
function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** The URL of a request, or a root-relative one when the Host header is odd. */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry.invalid');
  } catch {
    return new URL('http://entry.invalid/');
  }
}

/** The origin the caller reached this server on, for the URL fields REST bodies carry. */
function baseOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://entry.invalid';
}

/** A per-request id, in the shape GitHub's own replies carry. */
function requestId(): string {
  return `${Date.now().toString(16).toUpperCase()}:${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge(resolvedLogin());

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Every reply carries an id: the suite's protocol check reads it, and so does a real client.
    res.setHeader('x-github-request-id', requestId());
    void handle(req, res, forge).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
}

/** Route one request: auth first, then the surface its path names. */
async function handle(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const url = urlOf(req);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const base = baseOf(req);

  // The env's boot probe: no token, and always the same two answers.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Every other path takes the token. A wrong or missing one is a 401, not a 404: that is what the
  // real API does, and the suite's protocol checks read it.
  const token = expectedToken();
  if (token !== '' && bearerOf(req) !== token) {
    unauthorized(res);
    return;
  }

  // GraphQL: one endpoint, any method it accepts (the suite posts).
  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, { allow: 'POST' });
      return;
    }
    const text = (await readBody(req)).toString('utf8');
    const body = parseJson(text);
    if (body === undefined) {
      sendJson(res, 400, { errors: [{ message: 'A GraphQL request body must be JSON' }] });
      return;
    }
    const answer = handleGraphQL({ forge, login: forge.login, body, base });
    const payload = `${JSON.stringify(answer.body)}\n`;
    res.writeHead(answer.status, { 'content-type': JSON_UTF8, 'content-length': String(Buffer.byteLength(payload)) });
    res.end(payload);
    return;
  }

  // REST v3: everything under /api/v3, with the trailing slash optional.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const rest = path.replace(/^\/api\/v3\/?/, '');
    const segments = rest === '' ? [] : rest.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
    let bodyText = '';
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      bodyText = (await readBody(req)).toString('utf8');
    }
    const reply = await routeRest(
      {
        forge,
        login: forge.login,
        query: url.searchParams,
        method,
        req,
        body: async () => parseJson(bodyText),
      },
      segments,
      base,
    );
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    if (reply.raw !== undefined) {
      const text = reply.raw;
      res.writeHead(reply.status, { 'content-type': headers['content-type'] ?? 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...headers });
      res.end(text);
      return;
    }
    const text = `${JSON.stringify(reply.body ?? null)}\n`;
    res.writeHead(reply.status, { 'content-type': JSON_UTF8, 'content-length': String(Buffer.byteLength(text)), ...headers });
    res.end(text);
    return;
  }

  // MCP over streamable HTTP: JSON-RPC in, JSON-RPC out, on one POST.
  if (path === '/mcp' || path === '/mcp/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, { allow: 'POST' });
      return;
    }
    const text = (await readBody(req)).toString('utf8');
    const body = parseJson(text);
    if (body === undefined) {
      // A body that is not JSON is a JSON-RPC parse error, and it is a 400, not a 200.
      const payload = `${JSON.stringify(parseError())}\n`;
      res.writeHead(400, { 'content-type': MCP_TYPE, 'content-length': String(Buffer.byteLength(payload)) });
      res.end(payload);
      return;
    }
    const answer = await handleRpc(body, forge, forge.login, base);
    if (answer === null) {
      // A notification: no body, but a 202 so the client knows it landed.
      res.writeHead(202, { 'content-length': '0' });
      res.end();
      return;
    }
    const payload = `${JSON.stringify(answer)}\n`;
    res.writeHead(200, { 'content-type': MCP_TYPE, 'content-length': String(Buffer.byteLength(payload)) });
    res.end(payload);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/{suffix}.
  const address = parseGitPath(path);
  if (address !== null) {
    const repo = forge.find(address.owner, address.name);
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const answer = handleGit(repo, address, method, url, req.headers, body);
    res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': String(answer.body.length), 'cache-control': 'no-cache' });
    res.end(answer.body);
    return;
  }

  notFound(res);
}
