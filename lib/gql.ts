// GraphQL v4: a small parser + executor for the documents gh and github-mcp-server send.
// No schema library: the surface is exactly the one the conformance suite exercises.
import { nodeId, parseNodeId, trialNowIso } from './util.ts';
import {
  parseCommit,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { diffFiles, liveBaseSha, mergeBase, prMergeable, squashMerge, threeWayMerge } from './merge.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'var'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      let num = '';
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) {
        num += src[j];
        j += 1;
      }
      if (num.includes('.') || num.includes('e') || num.includes('E')) tokens.push({ kind: 'float', value: parseFloat(num) });
      else tokens.push({ kind: 'int', value: parseInt(num, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selection: FieldNode[] | null;
  fragment: { type: string | null; selection: FieldNode[] } | null;
}

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: FieldNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        ops.push(this.parseOperation(t.value as 'query' | 'mutation'));
      } else if (t.kind === 'name' && t.value === 'fragment') {
        // Named fragments are not used by the suite; skip the definition.
        this.next();
        this.expectName();
        this.expectName();
        this.expectName();
        this.parseSelectionSet();
      } else if (t.kind === 'punct' && t.value === '{') {
        ops.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(t)} at the top level`);
      }
    }
    return ops;
  }

  private parseOperation(type: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    const t = this.peek();
    if (t && t.kind === 'name') {
      name = this.next().value as string;
    }
    const variables: string[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const dollar = this.next();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in a variable definition');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.acceptPunct('=')) this.parseValue();
      }
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.acceptPunct('}')) {
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): FieldNode {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      let type: string | null = null;
      const on = this.peek();
      if (on && on.kind === 'name' && on.value === 'on') {
        this.next();
        type = this.expectName();
      }
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selection: null, fragment: { type, selection } };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@...) are not used by the suite; skip them.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selection: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection, fragment: null };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: Value[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'defaultBranch'],
  User: ['id', 'login', 'name', 'email', 'url'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'];

// ---------------------------------------------------------------- executor

export interface GqlError {
  message: string;
  path?: (string | number)[];
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors: GqlError[];
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function err(ctx: Ctx, message: string, path: (string | number)[]): void {
  ctx.errors.push({ message, path });
}

function findIssueByGlobalId(store: Store, globalId: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseNodeId(globalId);
  if (!parsed || parsed[0] !== 'Issue') return null;
  const id = Number(parsed[1]);
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === id);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: Store, globalId: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseNodeId(globalId);
  if (!parsed || parsed[0] !== 'PullRequest') return null;
  const id = Number(parsed[1]);
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((p) => p.id === id);
    if (pull) return { repo, pull };
  }
  return null;
}

function findRepoByGlobalId(store: Store, globalId: string): Repo | null {
  const parsed = parseNodeId(globalId);
  if (!parsed || parsed[0] !== 'Repository') return null;
  const id = Number(parsed[1]);
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueFields(ctx: Ctx, repo: Repo, issue: Issue, selection: FieldNode[] | null, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = nodeId('Issue', issue.id);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = issueStateGql(issue.state);
        break;
      case 'createdAt':
        out[key] = issue.created_at;
        break;
      case 'updatedAt':
        out[key] = issue.updated_at;
        break;
      case 'author':
        out[key] = applySelection(ctx, { login: issue.user.login, id: nodeId('User', issue.user.id) }, 'User', field.selection, [...path, key]);
        break;
      case 'url':
        out[key] = `https://github.com/${repo.fullName}/issues/${issue.number}`;
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        break;
      case 'comments':
        out[key] = { nodes: issue.comments.map((c) => ({ id: nodeId('IssueComment', c.id), body: c.body })) };
        break;
      default:
        err(ctx, `Field "${field.name}" doesn't exist on type "Issue"`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

function pullFields(ctx: Ctx, repo: Repo, pull: Pull, selection: FieldNode[] | null, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = nodeId('PullRequest', pull.id);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullStateGql(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable': {
        out[key] = prMergeable(ctx.store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        break;
      }
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'headRefOid':
        out[key] = pull.headSha;
        break;
      case 'baseRefOid':
        out[key] = pull.baseSha;
        break;
      case 'mergedAt':
        out[key] = pull.merged_at;
        break;
      case 'mergeCommit':
        out[key] = pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null;
        break;
      case 'createdAt':
        out[key] = pull.created_at;
        break;
      case 'updatedAt':
        out[key] = pull.updated_at;
        break;
      case 'author':
        out[key] = applySelection(ctx, { login: pull.user.login, id: nodeId('User', pull.user.id) }, 'User', field.selection, [...path, key]);
        break;
      case 'url':
        out[key] = `https://github.com/${repo.fullName}/pull/${pull.number}`;
        break;
      case 'files': {
        const first = argValue(field, 'first', ctx.variables);
        const headCommit = repo.objects.get(pull.headSha);
        const baseTip = liveBaseSha(ctx.store, repo, pull);
        const baseCommit = repo.objects.get(baseTip);
        let nodes: { path: string }[] = [];
        if (headCommit && baseCommit) {
          const mb = mergeBase(repo, pull.headSha, baseTip);
          const baseTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : parseCommit(baseCommit.data).tree;
          const headTree = parseCommit(headCommit.data).tree;
          nodes = diffFiles(repo, baseTree, headTree).map((f) => ({ path: f.filename }));
        }
        const n = typeof first === 'number' ? first : nodes.length;
        out[key] = { nodes: nodes.slice(0, n), totalCount: nodes.length };
        break;
      }
      default:
        err(ctx, `Field "${field.name}" doesn't exist on type "PullRequest"`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

function repoFields(ctx: Ctx, repo: Repo, selection: FieldNode[] | null, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = nodeId('Repository', repo.id);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = repo.fullName;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'isPrivate':
        out[key] = repo.private;
        break;
      case 'createdAt':
        out[key] = repo.created_at;
        break;
      case 'updatedAt':
        out[key] = repo.updated_at;
        break;
      case 'url':
        out[key] = `https://github.com/${repo.fullName}`;
        break;
      case 'defaultBranch':
        out[key] = repo.defaultBranch;
        break;
      case 'owner':
        out[key] = applySelection(ctx, { login: repo.owner, id: nodeId('User', repo.owner === VIEWER_LOGIN ? 1000 : 1002) }, 'User', field.selection, [...path, key]);
        break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = tip ? applySelection(ctx, { name: repo.defaultBranch, target: { oid: tip } }, 'Ref', field.selection, [...path, key]) : null;
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const number = argValue(field, 'number', ctx.variables);
        const found = typeof number === 'number' ? repo.issues.find((i) => i.number === number) : undefined;
        out[key] = found ? issueFields(ctx, repo, found, field.selection, [...path, key]) : null;
        break;
      }
      case 'issues': {
        const first = argValue(field, 'first', ctx.variables);
        const states = argValue(field, 'states', ctx.variables);
        const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
        const after = argValue(field, 'after', ctx.variables);
        let list = [...repo.issues];
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => direction * (a.number - b.number));
        if (typeof after === 'string' && after !== '') {
          const cursorNum = decodeCursor(after);
          if (cursorNum !== null) {
            list = direction === -1 ? list.filter((i) => i.number < cursorNum) : list.filter((i) => i.number > cursorNum);
          }
        }
        const n = typeof first === 'number' ? first : list.length;
        const page = list.slice(0, n);
        const hasNext = list.length > n;
        out[key] = {
          nodes: page.map((i) => issueFields(ctx, repo, i, field.selection ? subField(field.selection, 'nodes') : null, [...path, key])),
          totalCount: list.length,
          pageInfo: {
            hasNextPage: hasNext,
            endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
            hasPreviousPage: false,
            startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null,
          },
        };
        break;
      }
      case 'pullRequests': {
        const first = argValue(field, 'first', ctx.variables);
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const n = typeof first === 'number' ? first : list.length;
        const page = list.slice(0, n);
        out[key] = {
          nodes: page.map((p) => pullFields(ctx, repo, p, field.selection ? subField(field.selection, 'nodes') : null, [...path, key])),
          totalCount: list.length,
          pageInfo: { hasNextPage: list.length > n, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null },
        };
        break;
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx.variables);
        const found = typeof number === 'number' ? repo.pulls.find((p) => p.number === number) : undefined;
        out[key] = found ? pullFields(ctx, repo, found, field.selection, [...path, key]) : null;
        break;
      }
      default:
        err(ctx, `Field "${field.name}" doesn't exist on type "Repository"`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

/** The sub-selection of a connection's `nodes` field, if present. */
function subField(selection: FieldNode[] | null, name: string): FieldNode[] | null {
  if (!selection) return null;
  const found = selection.find((f) => f.name === name);
  return found ? found.selection : null;
}

/** Apply a selection set to a plain object (used for User/Ref shapes). */
function applySelection(ctx: Ctx, value: Record<string, unknown>, typeName: string, selection: FieldNode[] | null, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragment) {
      if (field.fragment.type === null || field.fragment.type === typeName) {
        Object.assign(out, applySelection(ctx, value, typeName, field.fragment.selection, path));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (key in value) {
      const v = value[key];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && field.selection) {
        out[key] = applySelection(ctx, v as Record<string, unknown>, typeName, field.selection, [...path, key]);
      } else {
        out[key] = v;
      }
    } else {
      err(ctx, `Field "${field.name}" doesn't exist on type "${typeName}"`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function typeFields(ctx: Ctx, name: string, selection: FieldNode[] | null, path: (string | number)[]): Record<string, unknown> | null {
  if (!(name in TYPE_FIELDS) && name !== 'SearchType') return null;
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'name') out[key] = name;
    else if (field.name === 'kind') out[key] = name === 'SearchType' ? 'ENUM' : 'OBJECT';
    else if (field.name === 'fields') out[key] = (TYPE_FIELDS[name] ?? []).map((n) => ({ name: n }));
    else if (field.name === 'enumValues') out[key] = name === 'SearchType' ? SEARCH_TYPE_VALUES.map((n) => ({ name: n })) : [];
    else {
      err(ctx, `Field "${field.name}" doesn't exist on type "__Type"`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

/** Execute one operation document. */
export function executeOperation(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  const ctx: Ctx = { store, variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL syntax error' }] };
  }
  const op = operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation in document' }] };
  const data: Record<string, unknown> = {};
  for (const field of op.selection) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    const path: (string | number)[] = [key];
    switch (field.name) {
      case 'viewer': {
        const user = { login: VIEWER_LOGIN, id: nodeId('User', 1000), name: VIEWER_NAME, email: VIEWER_EMAIL, url: `https://github.com/${VIEWER_LOGIN}` };
        data[key] = applySelection(ctx, user, 'User', field.selection, path);
        break;
      }
      case 'repository': {
        const owner = String(argValue(field, 'owner', variables) ?? '');
        const name = String(argValue(field, 'name', variables) ?? '');
        const repo = store.getRepo(owner, name);
        data[key] = repo ? repoFields(ctx, repo, field.selection, path) : null;
        break;
      }
      case 'node': {
        const id = String(argValue(field, 'id', variables) ?? '');
        const parsed = parseNodeId(id);
        let value: Record<string, unknown> | null = null;
        if (parsed && parsed[0] === 'Repository') {
          const repo = findRepoByGlobalId(store, id);
          if (repo) value = { id: nodeId('Repository', repo.id), name: repo.name, nameWithOwner: repo.fullName, __type: 'Repository' };
        } else if (parsed && parsed[0] === 'Issue') {
          const found = findIssueByGlobalId(store, id);
          if (found) value = { id: nodeId('Issue', found.issue.id), number: found.issue.number, title: found.issue.title, __type: 'Issue' };
        } else if (parsed && parsed[0] === 'PullRequest') {
          const found = findPullByGlobalId(store, id);
          if (found) value = { id: nodeId('PullRequest', found.pull.id), number: found.pull.number, __type: 'PullRequest' };
        }
        if (value === null) {
          data[key] = null;
          break;
        }
        const out: Record<string, unknown> = {};
        for (const sub of field.selection ?? []) {
          if (sub.fragment) {
            const fragType = sub.fragment.type;
            if (fragType === null || fragType === (value.__type as string)) {
              for (const f of sub.fragment.selection) {
                const k = f.alias ?? f.name;
                if (k in value) out[k] = value[k];
                else {
                  err(ctx, `Field "${f.name}" doesn't exist on type "${fragType ?? 'Node'}"`, [...path, k]);
                  out[k] = null;
                }
              }
            }
            continue;
          }
          const k = sub.alias ?? sub.name;
          if (k in value) out[k] = value[k];
          else {
            err(ctx, `Field "${sub.name}" doesn't exist on type "Node"`, [...path, k]);
            out[k] = null;
          }
        }
        data[key] = out;
        break;
      }
      case '__type': {
        const name = String(argValue(field, 'name', variables) ?? '');
        data[key] = typeFields(ctx, name, field.selection, path);
        break;
      }
      case 'createIssue': {
        const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
        if (!repo) {
          err(ctx, 'Could not resolve to a Repository with the id provided', path);
          data[key] = null;
          break;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') {
          err(ctx, 'Field "title" is required', path);
          data[key] = null;
          break;
        }
        const issue: Issue = {
          id: store.globalIssueId++,
          number: repo.issueSeq++,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          user: { login: VIEWER_LOGIN, id: 1000 },
          created_at: trialNowIso(),
          updated_at: trialNowIso(),
          comments: [],
        };
        repo.issues.push(issue);
        data[key] = { issue: issueFields(ctx, repo, issue, subField(field.selection, 'issue'), [...path, 'issue']) };
        break;
      }
      case 'closeIssue': {
        const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : null;
        if (!found) {
          err(ctx, 'Could not resolve to an Issue with the id provided', path);
          data[key] = null;
          break;
        }
        found.issue.state = 'closed';
        found.issue.updated_at = trialNowIso();
        data[key] = { issue: issueFields(ctx, found.repo, found.issue, subField(field.selection, 'issue'), [...path, 'issue']) };
        break;
      }
      case 'createPullRequest': {
        const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
        if (!repo) {
          err(ctx, 'Could not resolve to a Repository with the id provided', path);
          data[key] = null;
          break;
        }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (!headSha || !baseSha) {
          err(ctx, 'Head or base ref does not exist', path);
          data[key] = null;
          break;
        }
        if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)) {
          err(ctx, 'A pull request already exists for this head and base', path);
          data[key] = null;
          break;
        }
        const pull: Pull = {
          id: store.globalPullId++,
          number: repo.pullSeq++,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          user: { login: VIEWER_LOGIN, id: 1000 },
          created_at: trialNowIso(),
          updated_at: trialNowIso(),
        };
        repo.pulls.push(pull);
        data[key] = { pullRequest: pullFields(ctx, repo, pull, subField(field.selection, 'pullRequest'), [...path, 'pullRequest']) };
        break;
      }
      case 'mergePullRequest': {
        const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : null;
        if (!found) {
          err(ctx, 'Could not resolve to a PullRequest with the id provided', path);
          data[key] = null;
          break;
        }
        const mergeSha = squashMerge(store, found.repo, found.pull);
        if (mergeSha === null) {
          err(ctx, 'Pull request cannot be merged: merge conflict', path);
          data[key] = null;
          break;
        }
        found.pull.merged = true;
        found.pull.state = 'closed';
        found.pull.merged_at = trialNowIso();
        found.pull.merge_commit_sha = mergeSha;
        found.pull.updated_at = trialNowIso();
        data[key] = { pullRequest: pullFields(ctx, found.repo, found.pull, subField(field.selection, 'pullRequest'), [...path, 'pullRequest']) };
        break;
      }
      case 'addComment': {
        const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(store, input.subjectId) : null;
        if (!found) {
          err(ctx, 'Could not resolve to an Issue with the id provided', path);
          data[key] = null;
          break;
        }
        const text = typeof input.body === 'string' ? input.body : '';
        const comment = {
          id: store.globalCommentId++,
          body: text,
          user: { login: VIEWER_LOGIN, id: 1000 },
          created_at: trialNowIso(),
          updated_at: trialNowIso(),
        };
        found.issue.comments.push(comment);
        const node = { id: nodeId('IssueComment', comment.id), body: comment.body };
        const nodeSel = subField(subField(field.selection, 'commentEdge'), 'node');
        data[key] = { commentEdge: { node: applySelection(ctx, node, 'IssueComment', nodeSel, [...path, 'commentEdge', 'node']) } };
        break;
      }
      default:
        err(ctx, `Field "${field.name}" doesn't exist on type "Query"`, path);
        data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}
