// Shared helpers for the forge: fixed time, ids, JSON replies, pkt-line framing.
// Everything deterministic: no Date.now(), no Math.random() in any response.
import { createHash } from 'node:crypto';

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW when set, else the competition opening. */
export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return '2026-11-14T06:30:00.000Z';
}

/** Epoch seconds for the fixed now. */
export function trialNowSec(): number {
  return Math.floor(new Date(trialNowIso()).getTime() / 1000);
}

/** sha1 of a git object header + payload, hex. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** base64 of a global id, opaque and stable. */
export function nodeId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** Decode a global id back to [kind, id]. */
export function parseNodeId(value: string): [string, string] | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return [text.slice(0, i), text.slice(i + 1)];
  } catch {
    return null;
  }
}

/** A short request id: deterministic counter-based, never random. */
let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${String(requestSeq).padStart(6, '0')}`;
}

/** JSON body for a reply. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a JSON request body; returns {ok:false} on malformed JSON. */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Base64 encode/decode for contents. */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------- pkt-line
// A pkt-line is 4 hex digits of (payload length + 4) followed by the payload.
// Flush is "0000", delim is "0001", response-end is "0002".

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Split a buffer into pkt-lines; returns {lines, rest}. Each line is {kind, payload}. */
export function readPktLines(buf: Buffer): { lines: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[]; rest: Buffer } {
  const lines: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    lines.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, rest: buf.subarray(off) };
}

/** Encode a sideband frame: band 1 = data, 2 = progress, 3 = error. */
export function sideband(band: 1 | 2 | 3, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([band]), payload]);
  return pktLine(body);
}
