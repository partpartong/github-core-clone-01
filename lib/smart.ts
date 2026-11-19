// Smart HTTP: info/refs advertisements, protocol-v2 upload-pack (ls-refs, fetch),
// and v0 receive-pack (push). All auth is checked by the caller.
import { PKT_FLUSH, PKT_DELIM, pktLine, readPktLines, sideband } from './util.ts';
import {
  commitAncestors,
  missingObjects,
  parsePack,
  reachableObjects,
  shallowSet,
  writePack,
} from './git.ts';
import { parseCommit, parseTree, type Repo, type Store } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

/** All refs of a repo, sorted by name. */
function allRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Peel a tag object to its commit oid, or the oid itself when it is a commit. */
function peelToCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const m = text.match(/^object ([0-9a-f]{40})$/m);
    if (m) return peelToCommit(repo, m[1]);
  }
  return null;
}

/** The default branch's tip oid, or null when the repo is empty. */
function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------- advertisements

/** GET /info/refs?service=git-upload-pack — v2 when the client asks, else v0. */
export function advertisementUploadPack(repo: Repo, wantsV2: boolean): Buffer {
  const tip = defaultTip(repo);
  const refs = allRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  if (wantsV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('agent=forge/1.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // v0: HEAD line carries the capabilities; peeled tags get a ^{} line.
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} agent=forge/1.0 object-format=sha1 side-band-64k shallow`;
  if (!tip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET /info/refs?service=git-receive-pack — v0 only. */
export function advertisementReceivePack(repo: Repo): Buffer {
  const tip = defaultTip(repo);
  const refs = allRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const caps = 'report-status side-band-64k delete-refs agent=forge/1.0';
  if (!tip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 upload-pack

interface V2Request {
  command: string;
  args: string[];
}

/** Parse a v2 request body into its command and argument lines. */
export function parseV2Request(body: Buffer): V2Request {
  const { lines } = readPktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      // agent= / object-format= lines are ignored
    } else {
      args.push(text);
    }
  }
  return { command, args };
}

/** POST /{o}/{r}.git/git-upload-pack — protocol v2 (ls-refs, fetch). */
export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const req = parseV2Request(body);
  if (req.command === 'ls-refs') return lsRefsResponse(repo, req.args);
  if (req.command === 'fetch') return fetchResponse(repo, req.args);
  // Unknown command: a sideband error in a packfile section is the honest answer.
  const err = Buffer.concat([pktLine('packfile\n'), sideband(3, Buffer.from('unknown command\n', 'utf8')), PKT_FLUSH]);
  return err;
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  if (prefixes.length === 0) {
    if (tip) {
      if (symrefs) parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      else parts.push(pktLine(`${tip} HEAD\n`));
    } else if (unborn) {
      if (symrefs) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      else parts.push(pktLine(`unborn HEAD\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowReq.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7), 10);
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: ignored
  }
  const parts: Buffer[] = [];
  const validWants = wants.filter((w) => isOid(w) && repo.objects.has(w));
  if (validWants.length === 0) {
    // Nothing to fetch: NAK and no packfile section.
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(PKT_DELIM);
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  // Common commits: haves reachable from the wants.
  const wantClosure = reachableObjects(repo, validWants);
  const common = haves.filter((h) => wantClosure.has(h));

  // Acknowledgments section.
  parts.push(pktLine('acknowledgments\n'));
  if (common.length > 0) {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);

  // The objects to send.
  let objects: Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }> = new Map();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== null && Number.isFinite(depth) && depth > 0) {
    for (const want of validWants) {
      const { objects: set, shallow } = shallowSet(repo, want, depth);
      for (const [k, v] of set) objects.set(k, v);
      for (const s of shallow) if (!shallowOut.includes(s)) shallowOut.push(s);
    }
    // Boundaries the client already had that are now fully present are unshallow.
    for (const b of shallowReq) {
      if (objects.has(b) && !shallowOut.includes(b)) unshallowOut.push(b);
    }
  } else {
    objects = missingObjects(repo, validWants, haves);
  }

  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }

  if (objects.size > 0) {
    const pack = writePack([...objects.values()]);
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      parts.push(sideband(1, pack.subarray(off, Math.min(off + CHUNK, pack.length))));
    }
    parts.push(PKT_DELIM);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{o}/{r}.git/git-receive-pack — v0, report-status inside sideband band 1. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = readPktLines(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const main = nul >= 0 ? text.slice(0, nul) : text;
    const parts = main.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = rest.length > 0 ? rest : null;

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes && packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const obj of objects) {
        if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\s+/g, ' ').trim() : 'unpacker error';
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);

  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (!isOid(cmd.newOid) || !repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // Update: old must match, and the new tip must descend from the old.
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} stale info`);
      continue;
    }
    const target = peelToCommit(repo, cmd.newOid);
    if (target === null) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    const ancestors = commitAncestors(repo, target);
    if (!ancestors.includes(cmd.oldOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }

  const inner = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < inner.length; off += CHUNK) {
    out.push(sideband(1, inner.subarray(off, Math.min(off + CHUNK, inner.length))));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}
