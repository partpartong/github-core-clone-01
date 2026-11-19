// Shared git-merge helpers: merge-base, three-way merge, diff, squash merge, mergeability.
// Used by both the REST router and the GraphQL executor so the two surfaces agree.
import { buildCommit, buildTreeFromPaths, flattenTree, parseCommit, type Pull, type Repo, type Store } from './store.ts';
import { trialNowSec } from './util.ts';

/** The merge-base of two commits: the first common ancestor walking the head's history. */
export function mergeBase(repo: Repo, headOid: string, baseOid: string): string | null {
  const baseAncestors = new Set<string>();
  const stack = [baseOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const walk = [headOid];
  const seen = new Set<string>();
  while (walk.length > 0) {
    const oid = walk.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) walk.push(p);
  }
  return null;
}

/** A three-way merge of trees. Returns the merged path map, or null on conflict. */
export function threeWayMerge(repo: Repo, baseTree: string, oursTree: string, theirsTree: string): Map<string, { oid: string; mode: string }> | null {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o && t && o.oid === t.oid) {
      out.set(path, o);
      continue;
    }
    if (b && o && o.oid === b.oid) {
      if (t) out.set(path, t);
      continue;
    }
    if (b && t && t.oid === b.oid) {
      if (o) out.set(path, o);
      continue;
    }
    if (!b && o && !t) {
      out.set(path, o);
      continue;
    }
    if (!b && t && !o) {
      out.set(path, t);
      continue;
    }
    if (!b && !o && t) {
      out.set(path, t);
      continue;
    }
    if (!b && o && t) {
      return null;
    }
    return null;
  }
  return out;
}

/** The diff between two trees: filename, status, additions, deletions, changes, blob sha. */
export function diffFiles(repo: Repo, baseTree: string, headTree: string): { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[] = [];
  const lineSet = (text: string): Set<string> => new Set(text.split('\n').filter((l) => l !== ''));
  const countLines = (data: Buffer): number => {
    const text = data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const [path, h] of head) {
    const b = base.get(path);
    if (!b) {
      const obj = repo.objects.get(h.oid);
      const additions = obj ? countLines(obj.data) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.oid });
      continue;
    }
    if (b.oid === h.oid) continue;
    const oldObj = repo.objects.get(b.oid);
    const newObj = repo.objects.get(h.oid);
    const oldLines = oldObj ? lineSet(oldObj.data.toString('utf8')) : new Set<string>();
    const newLines = newObj ? lineSet(newObj.data.toString('utf8')) : new Set<string>();
    let additions = 0;
    for (const l of newLines) if (!oldLines.has(l)) additions += 1;
    let deletions = 0;
    for (const l of oldLines) if (!newLines.has(l)) deletions += 1;
    if (additions === 0 && deletions === 0) additions = 1;
    out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.oid });
  }
  for (const [path] of base) {
    if (!head.has(path)) {
      const obj = repo.objects.get(base.get(path)!.oid);
      const deletions = obj ? countLines(obj.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: base.get(path)!.oid });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/** The pull request's base tip as it stands now (the branch may have moved since the PR was opened). */
export function liveBaseSha(store: Store, repo: Repo, pull: Pull): string {
  return store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
}

/** Whether a pull request's head can merge cleanly onto its base. */
export function prMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const headCommit = repo.objects.get(pull.headSha);
  const baseTip = liveBaseSha(store, repo, pull);
  const baseCommit = repo.objects.get(baseTip);
  if (!headCommit || !baseCommit) return false;
  const mb = mergeBase(repo, pull.headSha, baseTip);
  if (mb === null) return false;
  const mbCommit = repo.objects.get(mb);
  if (!mbCommit) return false;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const mbTree = parseCommit(mbCommit.data).tree;
  return threeWayMerge(repo, mbTree, baseTree, headTree) !== null;
}

/** Perform a squash merge of a pull request. Returns the merge commit sha, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headCommit = repo.objects.get(pull.headSha);
  const baseTip = liveBaseSha(store, repo, pull);
  const baseCommit = repo.objects.get(baseTip);
  if (!headCommit || !baseCommit) return null;
  const mb = mergeBase(repo, pull.headSha, baseTip);
  if (mb === null) return null;
  const mbCommit = repo.objects.get(mb);
  if (!mbCommit) return null;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const mbTree = parseCommit(mbCommit.data).tree;
  const merged = threeWayMerge(repo, mbTree, baseTree, headTree);
  if (merged === null) return null;
  const newTree = buildTreeFromPaths(repo, store, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit(newTree, [baseTip], message, trialNowSec());
  const commitOid = store.putObject(repo, 'commit', commitData);
  repo.refs.set(store.branchRef(pull.baseRef), commitOid);
  return commitOid;
}
