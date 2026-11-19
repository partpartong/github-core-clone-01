// REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests.
// Every reply is JSON; every error carries a string `message`; auth is checked by the caller.
import { b64decode, b64encode, nodeId, trialNowIso, trialNowSec } from './util.ts';
import {
  buildCommit,
  buildTreeFromPaths,
  flattenTree,
  lookupPath,
  parseCommit,
  parseTree,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { diffFiles, liveBaseSha, mergeBase, squashMerge } from './merge.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): RestReply {
  return { status, body: { message } };
}

const NOT_FOUND = 'Not Found';

function messageOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** Split a path into segments, decoding each. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
}

/** Parse ?page&per_page (GitHub defaults: page 1, per_page 30). */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** A paginated slice plus a GitHub Link header (absolute URLs, same origin). */
function paginate<T>(items: T[], page: number, perPage: number, baseUrl: string, query: URLSearchParams): { page: T[]; link: string | null } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${baseUrl}?${q.toString()}`;
  };
  const links: string[] = [];
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (pages > 1) links.push(`<${urlFor(pages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

/** The commit list for a ref: ancestors newest first, with parsed author/committer. */
function commitList(repo: Repo, tipOid: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const text = obj.data.toString('utf8');
    const author = parseIdent(text, 'author');
    const committer = parseIdent(text, 'committer');
    out.push({
      sha: oid,
      node_id: nodeId('Commit', oid),
      commit: {
        message: parsed.message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: parsed.tree },
      },
      author: { login: VIEWER_LOGIN },
      committer: { login: VIEWER_LOGIN },
      parents: parsed.parents.map((p) => ({ sha: p })),
      html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
      url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
    });
    for (const p of parsed.parents) stack.push(p);
  }
  return out;
}

function parseIdent(text: string, kind: 'author' | 'committer'): { name: string; email: string; date: string } {
  const m = text.match(new RegExp(`^${kind} (.+) <([^>]*)> (\\d+) [+-]\\d{4}$`, 'm'));
  if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNowIso() };
  return { name: m[1] ?? VIEWER_NAME, email: m[2] ?? VIEWER_EMAIL, date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------- the router

export function handleRest(
  store: Store,
  method: string,
  rawPath: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestReply {
  const segs = segments(rawPath);

  // GET /api/v3/ (root) — segs is empty here because the prefix was stripped by main.ts.
  if (segs.length === 0) {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, {
      current_user_url: `${origin}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${origin}/api/v3/authorizations`,
      code_search_url: `${origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${origin}/api/v3/search/commits?q={query}`,
      emails_url: `${origin}/api/v3/user/emails`,
      emojis_url: `${origin}/api/v3/emojis`,
      events_url: `${origin}/api/v3/events`,
      feeds_url: `${origin}/api/v3/feeds`,
      followers_url: `${origin}/api/v3/user/followers`,
      following_url: `${origin}/api/v3/user/following{/other_user}`,
      gists_url: `${origin}/api/v3/gists{/gist_id}`,
      hub_url: `${origin}/api/v3/hub`,
      issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
      issues_url: `${origin}/api/v3/issues`,
      keys_url: `${origin}/api/v3/user/keys`,
      label_search_url: `${origin}/api/v3/search/labels?q={query}`,
      notifications_url: `${origin}/api/v3/notifications`,
      organization_url: `${origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${origin}/api/v3/gists/public`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${origin}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${origin}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${origin}/api/v3/gists/starred`,
      user_url: `${origin}/api/v3/users/{user}`,
      user_organizations_url: `${origin}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${origin}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segs[0] === 'meta') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, { installed_version: '1.0.0', version: '1.0.0' });
  }

  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
      return jsonReply(200, {
        login: VIEWER_LOGIN,
        id: 1000,
        node_id: nodeId('User', 1000),
        avatar_url: `https://github.com/${VIEWER_LOGIN}.png`,
        type: 'User',
        site_admin: false,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        html_url: `https://github.com/${VIEWER_LOGIN}`,
        url: `${origin}/api/v3/users/${VIEWER_LOGIN}`,
      });
    }
    if (segs[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const repos = store.listRepos(VIEWER_LOGIN);
        const { page: slice, link } = paginate(repos.map((r) => store.repoShape(r)), page, perPage, `${origin}/api/v3/user/repos`, query);
        return jsonReply(200, slice, link ? { link } : undefined);
      }
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = messageOf(b.name, '');
        if (name === '') return errorReply(422, 'Validation Failed: name is required');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorReply(422, 'Validation Failed: name is invalid');
        if (store.getRepo(VIEWER_LOGIN, name)) return errorReply(422, 'Validation Failed: name already exists on this account');
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          messageOf(b.description, ''),
          typeof b.private === 'boolean' ? b.private : false,
          'main',
        );
        return jsonReply(201, store.repoShape(repo));
      }
      return errorReply(405, 'Method Not Allowed');
    }
    return errorReply(404, NOT_FOUND);
  }

  if (segs[0] !== 'repos' || segs.length < 3) return errorReply(404, NOT_FOUND);
  const owner = segs[1]!;
  const repoName = segs[2]!;
  const repo = store.getRepo(owner, repoName);
  const rest = segs.slice(3);

  // The repo itself must exist and belong to the token's owner (a foreign owner is a 404).
  if (!repo) return errorReply(404, NOT_FOUND);
  if (owner !== VIEWER_LOGIN) return errorReply(404, NOT_FOUND);

  if (rest.length === 0) {
    if (method === 'GET') return jsonReply(200, store.repoShape(repo));
    if (method === 'PATCH') {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
      repo.updated_at = trialNowIso();
      return jsonReply(200, store.repoShape(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest[0] === 'branches') {
    const branches: { name: string; commit: { sha: string } }[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (rest.length === 1) {
      if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
      return jsonReply(200, branches);
    }
    const branchName = rest.slice(1).join('/');
    const found = branches.find((b) => b.name === branchName);
    if (!found) return errorReply(404, NOT_FOUND);
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, { name: found.name, commit: { sha: found.commit.sha }, protected: false });
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref) ?? (isOid(ref) ? ref : undefined);
    if (!tip || !repo.objects.has(tip)) return errorReply(404, NOT_FOUND);
    return jsonReply(200, commitList(repo, tip));
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = (body ?? {}) as Record<string, unknown>;
      const ref = messageOf(b.ref, '');
      const sha = messageOf(b.sha, '');
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        return errorReply(422, 'Validation Failed: ref and sha are required');
      }
      if (repo.refs.has(ref)) return errorReply(422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, object: { sha, type: 'commit' }, url: `${origin}/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}` });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const full = `refs/${ref}`;
      const oid = repo.refs.get(full);
      if (!oid) return errorReply(404, NOT_FOUND);
      return jsonReply(200, { ref: full, object: { sha: oid, type: 'commit' } });
    }
    return errorReply(404, NOT_FOUND);
  }

  if (rest[0] === 'contents') {
    return handleContents(store, repo, method, rest.slice(1), query, body);
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') return jsonReply(200, repo.labels);
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const name = messageOf(b.name, '');
      if (name === '') return errorReply(422, 'Validation Failed: name is required');
      if (repo.labels.some((l) => l.name === name)) return errorReply(422, 'Validation Failed: label already exists');
      const label = { name, color: messageOf(b.color, 'ededed'), description: messageOf(b.description, '') };
      repo.labels.push(label);
      return jsonReply(201, label);
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest[0] === 'issues') {
    return handleIssues(store, repo, method, rest.slice(1), query, body, origin);
  }

  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, method, rest.slice(1), query, body, origin);
  }

  return errorReply(404, NOT_FOUND);
}

function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

// ---------------------------------------------------------------- contents

function handleContents(store: Store, repo: Repo, method: string, pathSegs: string[], query: URLSearchParams, body: unknown): RestReply {
  const path = pathSegs.join('/');
  const refParam = query.get('ref');
  const tipOid = (() => {
    if (refParam) return store.resolveRef(repo, refParam) ?? (isOid(refParam) ? refParam : undefined);
    return store.resolveRef(repo, repo.defaultBranch);
  })();

  if (method === 'GET') {
    if (!tipOid) return errorReply(404, NOT_FOUND);
    const commit = repo.objects.get(tipOid);
    if (!commit || commit.type !== 'commit') return errorReply(404, NOT_FOUND);
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      // Root listing.
      const entries = parseTree(repo.objects.get(treeOid)!.data).map((e) => {
        const target = repo.objects.get(e.oid);
        return {
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.oid,
          size: target && target.type === 'blob' ? target.data.length : 0,
          url: `/api/v3/repos/${repo.fullName}/contents/${encodeURIComponent(e.name)}`,
        };
      });
      return jsonReply(200, entries);
    }
    const found = lookupPath(repo, treeOid, path);
    if (!found) return errorReply(404, NOT_FOUND);
    const obj = repo.objects.get(found.oid)!;
    if (found.type === 'tree') {
      const entries = parseTree(obj.data).map((e) => {
        const target = repo.objects.get(e.oid);
        return {
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: `${path}/${e.name}`,
          sha: e.oid,
          size: target && target.type === 'blob' ? target.data.length : 0,
          url: `/api/v3/repos/${repo.fullName}/contents/${encodeURIComponent(path)}/${encodeURIComponent(e.name)}`,
        };
      });
      return jsonReply(200, entries);
    }
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: b64encode(obj.data),
      sha: found.oid,
      url: `/api/v3/repos/${repo.fullName}/contents/${encodeURIComponent(path)}`,
      html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${found.oid}`,
      download_url: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`,
    });
  }

  if (method === 'PUT') {
    const b = (body ?? {}) as Record<string, unknown>;
    const message = messageOf(b.message, 'Update file');
    const contentB64 = messageOf(b.content, '');
    if (contentB64 === '') return errorReply(422, 'Validation Failed: content is required');
    let content: Buffer;
    try {
      content = b64decode(contentB64);
    } catch {
      return errorReply(422, 'Validation Failed: content is not valid base64');
    }
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    const branchRef = store.branchRef(branch);
    const tip = repo.refs.get(branchRef);
    const blobOid = store.putObject(repo, 'blob', content);
    const shaParam = typeof b.sha === 'string' ? b.sha : undefined;
    let files = new Map<string, { oid: string; mode: string }>();
    let parents: string[] = [];
    let isUpdate = false;
    if (tip) {
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') return errorReply(404, NOT_FOUND);
      const treeOid = parseCommit(commit.data).tree;
      files = flattenTree(repo, treeOid);
      parents = [tip];
      const existing = files.get(path);
      if (existing) {
        isUpdate = true;
        if (shaParam === undefined) return errorReply(422, 'Validation Failed: sha is required to update a file');
        if (shaParam.toLowerCase() !== existing.oid.toLowerCase()) return errorReply(409, 'Conflict: the file has changed since the given sha');
      } else if (shaParam !== undefined) {
        return errorReply(422, 'Validation Failed: sha does not match a file that does not exist');
      }
    } else if (shaParam !== undefined) {
      return errorReply(422, 'Validation Failed: sha does not match a file that does not exist');
    }
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTreeFromPaths(repo, store, files);
    const commitData = buildCommit(treeOid, parents, message, trialNowSec());
    const commitOid = store.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitOid);
    repo.updated_at = trialNowIso();
    return jsonReply(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    });
  }

  if (method === 'DELETE') {
    const b = (body ?? {}) as Record<string, unknown>;
    const message = messageOf(b.message, 'Delete file');
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    const branchRef = store.branchRef(branch);
    const tip = repo.refs.get(branchRef);
    if (!tip) return errorReply(404, NOT_FOUND);
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return errorReply(404, NOT_FOUND);
    const treeOid = parseCommit(commit.data).tree;
    const files = flattenTree(repo, treeOid);
    const existing = files.get(path);
    if (!existing) return errorReply(404, NOT_FOUND);
    const shaParam = typeof b.sha === 'string' ? b.sha : undefined;
    if (shaParam !== undefined && shaParam.toLowerCase() !== existing.oid.toLowerCase()) {
      return errorReply(409, 'Conflict: the file has changed since the given sha');
    }
    files.delete(path);
    const newTree = buildTreeFromPaths(repo, store, files);
    const commitData = buildCommit(newTree, [tip], message, trialNowSec());
    const commitOid = store.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitOid);
    repo.updated_at = trialNowIso();
    return jsonReply(200, { commit: { sha: commitOid, message } });
  }

  return errorReply(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: unknown, origin: string): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      void sort;
      const { page, perPage } = pageParams(query);
      const { page: slice, link } = paginate(list.map((i) => store.issueShape(repo, i)), page, perPage, `${origin}/api/v3/repos/${repo.fullName}/issues`, query);
      return jsonReply(200, slice, link ? { link } : undefined);
    }
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const title = messageOf(b.title, '');
      if (title === '') return errorReply(422, 'Validation Failed: title is required');
      const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.some((l) => l.name === label)) {
          return errorReply(422, `Validation Failed: label ${label} does not exist`);
        }
      }
      const now = trialNowIso();
      const issue: Issue = {
        id: store.globalIssueId++,
        number: repo.issueSeq++,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        labels,
        user: { login: VIEWER_LOGIN, id: 1000 },
        created_at: now,
        updated_at: now,
        comments: [],
      };
      repo.issues.push(issue);
      return jsonReply(201, store.issueShape(repo, issue));
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) return errorReply(404, NOT_FOUND);
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return errorReply(404, NOT_FOUND);

  if (rest.length === 1) {
    if (method === 'GET') return jsonReply(200, store.issueShape(repo, issue));
    if (method === 'PATCH') {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
      if (Array.isArray(b.labels)) {
        const labels = b.labels.filter((x): x is string => typeof x === 'string');
        for (const label of labels) {
          if (!repo.labels.some((l) => l.name === label)) return errorReply(422, `Validation Failed: label ${label} does not exist`);
        }
        issue.labels = labels;
      }
      issue.updated_at = trialNowIso();
      return jsonReply(200, store.issueShape(repo, issue));
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      return jsonReply(200, issue.comments.map((c) => ({
        id: c.id,
        node_id: nodeId('IssueComment', c.id),
        body: c.body,
        user: c.user,
        created_at: c.created_at,
        updated_at: c.updated_at,
        html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
        url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
      })));
    }
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const text = messageOf(b.body, '');
      if (text === '') return errorReply(422, 'Validation Failed: body is required');
      const now = trialNowIso();
      const comment = {
        id: store.globalCommentId++,
        body: text,
        user: { login: VIEWER_LOGIN, id: 1000 },
        created_at: now,
        updated_at: now,
      };
      issue.comments.push(comment);
      return jsonReply(201, {
        id: comment.id,
        node_id: nodeId('IssueComment', comment.id),
        body: comment.body,
        user: comment.user,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
        url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
      });
    }
    return errorReply(405, 'Method Not Allowed');
  }

  return errorReply(404, NOT_FOUND);
}

// ---------------------------------------------------------------- pull requests

function handlePulls(store: Store, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: unknown, origin: string): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, perPage } = pageParams(query);
      const { page: slice, link } = paginate(list.map((p) => store.pullShape(repo, p)), page, perPage, `${origin}/api/v3/repos/${repo.fullName}/pulls`, query);
      return jsonReply(200, slice, link ? { link } : undefined);
    }
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const head = messageOf(b.head, '');
      const base = messageOf(b.base, '');
      const title = messageOf(b.title, '');
      if (head === '' || base === '' || title === '') return errorReply(422, 'Validation Failed: head, base and title are required');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (!headSha || !baseSha) return errorReply(422, 'Validation Failed: head or base branch does not exist');
      if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)) {
        return errorReply(422, 'Validation Failed: a pull request already exists for this head and base');
      }
      const now = trialNowIso();
      const pull: Pull = {
        id: store.globalPullId++,
        number: repo.pullSeq++,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        user: { login: VIEWER_LOGIN, id: 1000 },
        created_at: now,
        updated_at: now,
      };
      repo.pulls.push(pull);
      return jsonReply(201, store.pullShape(repo, pull));
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) return errorReply(404, NOT_FOUND);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return errorReply(404, NOT_FOUND);

  if (rest.length === 1) {
    if (method === 'GET') return jsonReply(200, store.pullShape(repo, pull));
    return errorReply(405, 'Method Not Allowed');
  }

  if (rest[1] === 'files') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    const headCommit = repo.objects.get(pull.headSha);
    const baseTip = liveBaseSha(store, repo, pull);
    const baseCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseCommit) return errorReply(404, NOT_FOUND);
    const mb = mergeBase(repo, pull.headSha, baseTip);
    const baseTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    return jsonReply(200, diffFiles(repo, baseTree, headTree).map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `https://github.com/${repo.fullName}/blob/${pull.headSha}/${f.filename}`,
      raw_url: `https://github.com/${repo.fullName}/raw/${pull.headSha}/${f.filename}`,
      contents_url: `/api/v3/repos/${repo.fullName}/contents/${encodeURIComponent(f.filename)}?ref=${pull.headSha}`,
    })));
  }

  if (rest[1] === 'merge') {
    if (method !== 'PUT') return errorReply(405, 'Method Not Allowed');
    if (pull.merged || pull.state !== 'open') return errorReply(405, 'Pull Request is already merged or closed');
    const mergeSha = squashMerge(store, repo, pull);
    if (mergeSha === null) return errorReply(405, 'Pull Request cannot be merged: merge conflict');
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = trialNowIso();
    pull.merge_commit_sha = mergeSha;
    pull.updated_at = trialNowIso();
    return jsonReply(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  }

  return errorReply(404, NOT_FOUND);
}
