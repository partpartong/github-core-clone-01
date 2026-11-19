// MCP (Model Context Protocol), modern era 2026-07-28: server/discover, initialize,
// tools/list, tools/call. Plain JSON answers (no SSE). Auth is checked by the caller.
import { trialNowIso } from './util.ts';
import { VIEWER_LOGIN, type Store } from './store.ts';
import { squashMerge } from './merge.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The six tools, in a fixed order: tools/list must be byte-identical across calls. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Run one tool against the store. Returns the tool result object. */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') return errorResult('name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return errorResult(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
        'main',
      );
      return textResult(store.repoShape(repo));
    }
    case 'get_repo': {
      const owner = str('owner');
      const repoName = str('repo');
      if (owner === '' || repoName === '') return errorResult('owner and repo are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      return textResult(store.repoShape(repo));
    }
    case 'create_issue': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      if (owner === '' || repoName === '' || title === '') return errorResult('owner, repo and title are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const now = trialNowIso();
      const issue = {
        id: store.globalIssueId++,
        number: repo.issueSeq++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        user: { login: VIEWER_LOGIN, id: 1000 },
        created_at: now,
        updated_at: now,
        comments: [],
      };
      repo.issues.push(issue);
      return textResult(store.issueShape(repo, issue));
    }
    case 'list_issues': {
      const owner = str('owner');
      const repoName = str('repo');
      if (owner === '' || repoName === '') return errorResult('owner and repo are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      const shapes = list.map((i) => store.issueShape(repo, i));
      return textResult({ issues: shapes, total_count: shapes.length });
    }
    case 'create_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return errorResult('owner, repo, title, head and base are required');
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
      if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)) {
        return errorResult('a pull request already exists for this head and base');
      }
      const now = trialNowIso();
      const pull = {
        id: store.globalPullId++,
        number: repo.pullSeq++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        merged_at: null as string | null,
        merge_commit_sha: null as string | null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        user: { login: VIEWER_LOGIN, id: 1000 },
        created_at: now,
        updated_at: now,
      };
      repo.pulls.push(pull);
      return textResult(store.pullShape(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (owner === '' || repoName === '' || !Number.isFinite(number)) {
        return errorResult('owner, repo and pull_number are required');
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return errorResult(`pull request #${number} not found`);
      if (pull.merged || pull.state !== 'open') return errorResult('pull request is already merged or closed');
      const mergeSha = squashMerge(store, repo, pull);
      if (mergeSha === null) return errorResult('pull request cannot be merged: merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = trialNowIso();
      pull.merge_commit_sha = mergeSha;
      pull.updated_at = trialNowIso();
      return textResult({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged', number: pull.number });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export interface McpReply {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body. `raw` is the request text. Returns the HTTP status and JSON body.
 * A notification (no id) is answered with 202 and an empty body.
 */
export function handleMcp(store: Store, raw: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const id = 'id' in parsed ? parsed.id : undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const isNotification = id === undefined;

  const result = (value: unknown): McpReply => {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } };
  };
  const rpcError = (code: number, message: string, data?: unknown): McpReply => {
    if (isNotification) return { status: 202, body: null };
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error } };
  };

  if (method === '') return rpcError(-32600, 'Invalid Request: no method');
  if (method === 'server/discover') {
    return result({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0]!;
    return result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(-32602, `Unknown tool: ${name}`);
    const required = (tool.inputSchema.required as string[] | undefined) ?? [];
    const missing = required.filter((key) => !(key in args) || args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return result(errorResult(`missing required argument(s): ${missing.join(', ')}`));
    }
    return result(runTool(store, name, args));
  }
  return rpcError(-32601, `Method not found: ${method}`);
}
