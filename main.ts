// forge: a standalone GitHub-compatible git forge in one Node process.
// Lifecycle: listen on an ephemeral port, register it with the env, poll /done, exit 0.
// Surfaces: /healthz, git smart HTTP (/{owner}/{repo}.git), REST v3 (/api/v3),
// GraphQL v4 (/api/graphql), MCP (/mcp). Stdlib only; no git binary; no model calls.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { executeOperation } from './lib/gql.ts';
import { handleMcp } from './lib/mcp.ts';
import {
  advertisementReceivePack,
  advertisementUploadPack,
  handleReceivePack,
  handleUploadPackV2,
} from './lib/smart.ts';
import { nextRequestId, parseJsonBody } from './lib/util.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

const store = new Store();

function log(line: string): void {
  process.stderr.write(`[forge] ${line}\n`);
}

/** The bearer token a request presents, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length);
}

function authorized(req: IncomingMessage): boolean {
  return bearerToken(req) === SHOP_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

  // GET /healthz: no auth, the env's boot probe.
  if (path === '/healthz') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const tail = gitMatch[3] ?? '';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && tail === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const wantsV2 = req.headers['git-protocol'] === 'version=2';
        sendBuffer(res, 200, advertisementUploadPack(repo, wantsV2), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertisementReceivePack(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'service is required' });
      return;
    }
    if (method === 'POST' && tail === '/git-upload-pack') {
      const body = await readBody(req);
      sendBuffer(res, 200, handleUploadPackV2(repo, body), 'application/x-git-upload-pack-result');
      return;
    }
    if (method === 'POST' && tail === '/git-receive-pack') {
      const body = await readBody(req);
      sendBuffer(res, 200, handleReceivePack(store, repo, body), 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        body = parsed.value;
      }
    }
    const reply = handleRest(store, method, restPath, url.searchParams, body, origin);
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const value = parsed.value;
    if (Array.isArray(value)) {
      // Operation batching: one result per operation, in order.
      const results = value.map((op) => {
        if (typeof op !== 'object' || op === null || typeof (op as Record<string, unknown>).query !== 'string') {
          return { data: null, errors: [{ message: 'Invalid operation' }] };
        }
        const o = op as Record<string, unknown>;
        return executeOperation(store, o.query as string, (o.variables ?? {}) as Record<string, unknown>);
      });
      sendJson(res, 200, results);
      return;
    }
    if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).query !== 'string') {
      sendJson(res, 400, { data: null, errors: [{ message: 'A query is required' }] });
      return;
    }
    const v = value as Record<string, unknown>;
    sendJson(res, 200, executeOperation(store, v.query as string, (v.variables ?? {}) as Record<string, unknown>));
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A legacy session's goodbye; the modern era holds no session.
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(store, raw.toString('utf8'));
    if (reply.body === null) {
      res.writeHead(reply.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  // Anything else: a JSON 404, never HTML.
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- lifecycle

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('could not bind an ephemeral port');
  const port = address.port;
  log(`listening on 127.0.0.1:${port}`);

  if (ENV_URL === '') {
    log('MAKEFUN_ENV_URL is unset: serving without registering (local mode)');
    return;
  }

  // Register: first register wins; retry briefly in case the env is still starting.
  let registered = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const answer = await postJson(`${ENV_URL.replace(/\/+$/, '')}/register`, { port });
      if (answer.status >= 200 && answer.status < 300) {
        registered = true;
        log(`registered port ${port} (attempt ${attempt})`);
        break;
      }
      log(`register attempt ${attempt} answered HTTP ${answer.status}: ${answer.text.slice(0, 200)}`);
    } catch (err) {
      log(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(1000);
  }
  if (!registered) {
    log('could not register with the env; exiting 1');
    process.exitCode = 1;
    server.close();
    return;
  }

  // Long-poll /done until the trial ends, then exit 0.
  for (;;) {
    try {
      const answer = await getJson(`${ENV_URL.replace(/\/+$/, '')}/done`, 10000);
      const done = (answer.json as Record<string, unknown> | null)?.done === true;
      if (done) {
        log('the env reports done; exiting 0');
        break;
      }
    } catch (err) {
      log(`polling /done failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(1000);
  }
  server.close();
}

process.on('SIGTERM', () => {
  log('SIGTERM; exiting 0');
  process.exit(0);
});

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
