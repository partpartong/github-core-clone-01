// The forge's store: repositories, git objects, refs, issues, pull requests.
// All in memory, all deterministic: sequential ids, fixed timestamps, no clocks.
import { hashObject, nodeId, trialNowIso } from './util.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

/** The token's owner: the scenario's viewer, fixed by the kit's published seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

export function viewerUser(): { login: string; id: number } {
  return { login: VIEWER_LOGIN, id: VIEWER_ID };
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 1;
  globalIssueId = 1;
  globalPullId = 1;
  globalCommentId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.repoSeq++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch,
      created_at: now,
      updated_at: now,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      issueSeq: 1,
      pullSeq: 1,
      commentSeq: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Store an object, returning its oid. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The ref name for a branch. */
  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  /** Resolve a ref or a short branch name to an oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const asBranch = repo.refs.get(this.branchRef(ref));
    if (asBranch) return asBranch;
    return undefined;
  }

  /** The commit object for a ref, parsed. */
  getCommit(repo: Repo, oid: string): { tree: string; parents: string[]; message: string; raw: Buffer } | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** A repo's public shape for REST/GraphQL. */
  repoShape(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: nodeId('Repository', repo.id),
      name: repo.name,
      full_name: repo.fullName,
      fullName: repo.fullName,
      owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      html_url: `https://github.com/${repo.fullName}`,
      url: `/api/v3/repos/${repo.fullName}`,
      clone_url: `https://github.com/${repo.fullName}.git`,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    };
  }

  issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: nodeId('Issue', issue.id),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const found = repo.labels.find((l) => l.name === name);
        return { name, color: found ? found.color : 'ededed', description: found ? found.description : '' };
      }),
      user: issue.user,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
      comments: issue.comments.length,
      comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    };
  }

  pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: nodeId('PullRequest', pull.id),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: this.repoShape(repo) },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: this.repoShape(repo) },
      user: pull.user,
      created_at: pull.created_at,
      updated_at: pull.updated_at,
      html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
      mergeable: true,
    };
  }
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: Buffer } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

/** Parse a tree object's entries: {mode, name, oid}. */
export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.toString('ascii', off, sp);
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries back to a tree object. */
export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. */
export function buildCommit(tree: string, parents: string[], message: string, epochSec: number): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`);
  lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Walk a tree path to a blob oid (or a subtree oid). Returns null when missing. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; type: ObjType; mode: string } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const found = entries.find((e) => e.name === parts[i]);
    if (!found) return null;
    if (i === parts.length - 1) {
      const target = repo.objects.get(found.oid);
      if (!target) return null;
      return { oid: found.oid, type: target.type, mode: found.mode };
    }
    current = found.oid;
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode} for every blob. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree from a flat path map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeFromPaths(repo: Repo, store: Store, files: Map<string, { oid: string; mode: string }>): string {
  const build = (paths: Map<string, { oid: string; mode: string }>, prefix: string): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, v] of paths) {
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: v.mode, name: rest, oid: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path, v);
      }
    }
    for (const [dir, sub] of dirs) {
      const subOid = build(sub, prefix ? `${prefix}/${dir}` : dir);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(entries);
    return store.putObject(repo, 'tree', data);
  };
  return build(files, '');
}
