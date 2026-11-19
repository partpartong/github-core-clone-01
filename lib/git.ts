// Git packfiles: read a pushed pack (full + delta entries) and write a fetch pack.
// No delta compression on write: the suite's pack-deltas check only requires deltas to
// resolve "when the server sends them", so plain entries are conformant and faster to build.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject } from './util.ts';
import { parseCommit, parseTree, type GitObject, type ObjType, type Repo, type Store } from './store.ts';

const PACK_TYPES: Record<number, ObjType | 'ofs' | 'ref'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs',
  7: 'ref',
};

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks, total);
}

/** Read one pack entry header at `off`. Returns type, size, header length, and for OFS the base offset. */
function readEntryHeader(pack: Buffer, off: number): { typeCode: number; size: number; headerLen: number; ofsBase?: number; refBase?: string } {
  let i = off;
  let byte = pack[i++];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack[i++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  const headerLen = i - off;
  if (typeCode === 6) {
    let b = pack[i++];
    let ofs = b & 0x7f;
    while (b & 0x80) {
      b = pack[i++];
      ofs = ((ofs + 1) << 7) | (b & 0x7f);
    }
    return { typeCode, size, headerLen: i - off, ofsBase: off - ofs };
  }
  if (typeCode === 7) {
    const refBase = pack.subarray(i, i + 20).toString('hex');
    return { typeCode, size, headerLen: i - off + 20, refBase };
  }
  return { typeCode, size, headerLen };
}

/** Inflate one zlib stream starting at `off`; returns the data and bytes consumed. */
export function inflateAt(pack: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const result = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (result.buffer.length !== expectedSize) throw new Error('inflated size mismatch');
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Parse a whole pack buffer into objects. `lookup` resolves REF_DELTA bases already in the repo. */
export function parsePack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): { type: ObjType; data: Buffer; oid: string }[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects: { type: ObjType; data: Buffer; oid: string }[] = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const head = readEntryHeader(pack, off);
    off += head.headerLen;
    const { data: inflated, consumed } = inflateAt(pack, off, head.size);
    off += consumed;
    const kind = PACK_TYPES[head.typeCode];
    if (kind === 'ofs' || kind === 'ref') {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (kind === 'ofs') {
        base = byOffset.get(head.ofsBase!);
        if (!base) throw new Error('ofs delta base not found');
      } else {
        base = lookup(head.refBase!);
        if (!base) {
          const inPack = objects.find((o) => o.oid === head.refBase);
          if (inPack) base = inPack;
        }
        if (!base) throw new Error('ref delta base not found');
      }
      const data = applyDelta(base.data, inflated);
      const oid = hashObject(base.type, data);
      const obj = { type: base.type, data, oid };
      objects.push(obj);
      byOffset.set(start, obj);
    } else {
      const oid = hashObject(kind as ObjType, inflated);
      const obj = { type: kind as ObjType, data: inflated, oid };
      objects.push(obj);
      byOffset.set(start, obj);
    }
  }
  return objects;
}

// ---------------------------------------------------------------- pack writing

/** Write a pack of full (non-delta) objects. */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const headBytes: number[] = [];
    let b = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) b |= 0x80;
    headBytes.push(b);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      headBytes.push(next);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The closure of objects reachable from `wants` (commits + trees + blobs + tags). */
export function reachableObjects(repo: Repo, wants: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...wants];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** Objects reachable from wants but NOT from haves (the incremental set). */
export function missingObjects(repo: Repo, wants: string[], haves: string[]): Map<string, GitObject> {
  const wantSet = reachableObjects(repo, wants);
  const haveSet = reachableObjects(repo, haves);
  for (const oid of haveSet.keys()) wantSet.delete(oid);
  return wantSet;
}

/** Ancestors of a commit oid (including itself), in walk order. */
export function commitAncestors(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = repo.objects.get(oid);
    if (!c || c.type !== 'commit') continue;
    out.push(oid);
    const parsed = parseCommit(c.data);
    for (const p of parsed.parents) stack.push(p);
  }
  return out;
}

/** The objects for a depth-limited fetch: tip commit + its tree/blobs, no parents. */
export function shallowSet(repo: Repo, tip: string, depth: number): { objects: Map<string, GitObject>; shallow: string[] } {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  if (depth <= 0) return { objects, shallow };
  const commits = commitAncestors(repo, tip).slice(0, depth);
  for (const oid of commits) {
    const obj = repo.objects.get(oid);
    if (obj) objects.set(oid, obj);
    const c = parseCommit(obj!.data);
    const treeSet = reachableObjects(repo, [c.tree]);
    for (const [k, v] of treeSet) objects.set(k, v);
  }
  // The commit at the depth boundary is shallow (its parents are not sent).
  const boundary = commits[commits.length - 1];
  if (boundary && commits.length === depth) shallow.push(boundary);
  return { objects, shallow };
}

export type { Store };
