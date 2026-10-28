/**
 * Manual signaling for WebRTC collab sessions.
 *
 * No signaling server exists: the initiator pastes an offer code to the other
 * person, who pastes back an answer code. Codes therefore travel over a chat
 * channel, which means the decoder must treat them as hostile/truncated input
 * and never allocate unbounded memory from them.
 */

import type { PeerId } from './types';

export const SIGNAL_PREFIX = 'OL1.';
/** Deflate-compressed payload. SDP shrinks by roughly 70% this way. */
export const SIGNAL_PREFIX_DEFLATE = 'OL2.';

/** Upper bound on the decoded JSON payload; an SDP with host candidates is ~4 KiB. */
export const MAX_SIGNAL_BYTES = 256 * 1024;

/** Base64url expansion of MAX_SIGNAL_BYTES, used to reject oversized codes before decoding. */
const MAX_ENCODED_LENGTH = Math.ceil(MAX_SIGNAL_BYTES / 3) * 4;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SignalKind = 'offer' | 'answer';

export interface Signal {
  v: 1;
  kind: SignalKind;
  peer: PeerId;
  sdp: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/');
  const remainder = padded.length % 4;
  const binary = atob(remainder === 1 ? padded.slice(0, -1) : padded + '='.repeat((4 - remainder) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Encode one offer/answer as a copy-pasteable `OL1.` code.
 *
 * Round-tripping is the whole contract: `decodeSignal(encodeSignal(s))` must
 * return a value equal to `s`, and the payload must stay small enough to paste
 * into a chat message, hence the hard byte cap.
 */
export function encodeSignal(signal: Signal): string {
  const json = JSON.stringify(signal);
  const bytes = encoder.encode(json);
  if (bytes.length > MAX_SIGNAL_BYTES) {
    throw new Error(
      `Invite payload is ${bytes.length} bytes, which exceeds the ${MAX_SIGNAL_BYTES}-byte limit.`,
    );
  }
  return SIGNAL_PREFIX + toBase64Url(bytes);
}

/**
 * Validate and decode an invite code.
 *
 * Every failure mode is reported as a plain `Error` with a message naming the
 * specific defect, because the code arrives from another person and the UI
 * shows that message verbatim.
 */
export function decodeSignal(code: string): Signal {
  if (typeof code !== 'string') throw new Error('Invite code must be a string.');

  // Codes are copied by hand, so line breaks and stray spaces are normal noise.
  const normalized = code.replace(/\s+/gu, '');
  if (!normalized.startsWith(SIGNAL_PREFIX)) {
    throw new Error(`Not an OpenLabel invite code: expected the "${SIGNAL_PREFIX}" prefix.`);
  }

  const encoded = normalized.slice(SIGNAL_PREFIX.length);
  if (encoded.length === 0) {
    throw new Error(`Invite code is empty after the "${SIGNAL_PREFIX}" prefix.`);
  }
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error('Invite code contains characters that are not valid base64url.');
  }
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new Error(
      `Invite code is ${encoded.length} characters, which exceeds the ${MAX_ENCODED_LENGTH}-character limit.`,
    );
  }

  let json: string;
  try {
    json = decoder.decode(fromBase64Url(encoded));
  } catch {
    throw new Error('Invite code is not valid base64url text.');
  }

  if (encoder.encode(json).length > MAX_SIGNAL_BYTES) {
    throw new Error(`Invite payload exceeds the ${MAX_SIGNAL_BYTES}-byte limit.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invite code did not contain valid JSON; it may be truncated.');
  }

  return assertSignal(parsed);
}

function assertSignal(value: unknown): Signal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invite code JSON must be an object.');
  }

  const record = value as Record<string, unknown>;

  if (record.v !== 1) {
    throw new Error(`Unsupported invite code version: expected 1, received ${String(record.v)}.`);
  }
  if (record.kind !== 'offer' && record.kind !== 'answer') {
    throw new Error(`Invite code kind must be "offer" or "answer", received ${String(record.kind)}.`);
  }
  if (typeof record.peer !== 'string' || record.peer.length === 0) {
    throw new Error('Invite code is missing a non-empty "peer" identifier.');
  }
  if (typeof record.sdp !== 'string' || record.sdp.length === 0) {
    throw new Error('Invite code is missing a non-empty "sdp" description.');
  }

  return { v: 1, kind: record.kind, peer: record.peer, sdp: record.sdp };
}

async function pipeThrough(
  transform: CompressionStream | DecompressionStream,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  // Start reading before writing so a decode error surfaces as a rejection on
  // this promise instead of an unhandled event on the stream.
  const read = (async (): Promise<Uint8Array<ArrayBuffer>> => {
    const reader = transform.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_SIGNAL_BYTES) throw new Error('Invite payload exceeds the byte limit.');
    }
    const out = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  })();

  try {
    await writer.write(bytes);
    await writer.close();
  } catch {
    // A truncated stream fails on the read side; that rejection is the signal.
  }
  return read;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(new CompressionStream('deflate-raw'), bytes);
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(new DecompressionStream('deflate-raw'), bytes);
}

function canCompress(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/**
 * Encodes an offer/answer for a link.
 *
 * An SDP with a handful of candidates is a few kilobytes of very repetitive
 * text, so deflate shrinks it enough to sit in a chat message comfortably. The
 * prefix records which format was used, and decoding falls back to plain `OL1.`
 * when the browser lacks the compression API.
 */
export async function encodeSignalLink(signal: Signal): Promise<string> {
  const json = JSON.stringify(signal);
  const bytes = encoder.encode(json);
  if (bytes.length > MAX_SIGNAL_BYTES) {
    throw new Error(
      `Invite payload is ${bytes.length} bytes, which exceeds the ${MAX_SIGNAL_BYTES}-byte limit.`,
    );
  }
  if (!canCompress()) return encodeSignal(signal);
  const packed = await deflate(bytes);
  if (packed.length > MAX_SIGNAL_BYTES) return encodeSignal(signal);
  return SIGNAL_PREFIX_DEFLATE + toBase64Url(packed);
}

/** Decodes either format; the `OL1.` path is the synchronous decoder above. */
export async function decodeSignalLink(code: string): Promise<Signal> {
  if (typeof code !== 'string') throw new Error('Invite code must be a string.');
  const normalized = code.replace(/\s+/gu, '');
  if (normalized.startsWith(SIGNAL_PREFIX)) return decodeSignal(normalized);
  if (!normalized.startsWith(SIGNAL_PREFIX_DEFLATE)) {
    throw new Error(`Not an OpenLabel invite code: expected the "${SIGNAL_PREFIX}" prefix.`);
  }

  const encoded = normalized.slice(SIGNAL_PREFIX_DEFLATE.length);
  if (encoded.length === 0) throw new Error('Invite code is empty after the prefix.');
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error('Invite code contains characters that are not valid base64url.');
  }
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new Error(`Invite code exceeds the ${MAX_ENCODED_LENGTH}-character limit.`);
  }
  if (!canCompress()) {
    throw new Error('This browser cannot read compressed invite codes; update your browser.');
  }

  let json: string;
  try {
    json = decoder.decode(await inflate(fromBase64Url(encoded) as Uint8Array<ArrayBuffer>));
  } catch {
    throw new Error('Invite code is compressed but could not be decompressed; it may be truncated.');
  }
  if (encoder.encode(json).length > MAX_SIGNAL_BYTES) {
    throw new Error(`Invite payload exceeds the ${MAX_SIGNAL_BYTES}-byte limit.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invite code did not contain valid JSON; it may be truncated.');
  }
  return assertSignal(parsed);
}

/** Query parameters used by the one-click join route. */
export interface InviteLink {
  code: string;
  projectId: string;
  /** Project name, so the joining device can label the project immediately. */
  name: string;
  /** True when this link carries the answer back to the device that invited. */
  reply: boolean;
}

/** Builds `…/join?c=<code>&p=<projectId>&n=<name>` on the app's own origin. */
export function buildInviteLink(code: string, projectId: string, name = '', reply = false): string {
  const base = import.meta.env.BASE_URL || '/';
  const url = new URL(`${base.replace(/\/+$/u, '')}/join`, window.location.origin);
  url.searchParams.set('c', code);
  url.searchParams.set('p', projectId);
  if (name) url.searchParams.set('n', name);
  if (reply) url.searchParams.set('r', '1');
  return url.toString();
}

/** Reads a join link, tolerating a code pasted with surrounding whitespace. */
export function parseInviteLink(input: string): InviteLink | null {
  let parsed: URL;
  try {
    parsed = new URL(input, window.location.origin);
  } catch {
    return null;
  }
  if (!parsed.pathname.endsWith('/join')) return null;
  const code = parsed.searchParams.get('c')?.trim();
  const projectId = parsed.searchParams.get('p')?.trim();
  if (!code || !projectId) return null;
  return {
    code,
    projectId,
    name: parsed.searchParams.get('n')?.trim() ?? '',
    reply: parsed.searchParams.get('r') === '1',
  };
}
/**
 * Extracts the LAN address of the creating device from its own SDP.
 *
 * Host candidates carry the interface address (192.168.x.x and friends). That
 * address is what another device on the same network can reach, which is what
 * makes a one-click link possible without a server.
 */
export function lanAddressFromSdp(sdp: string): string | null {
  const candidates = sdp.match(/a=candidate:[^\r\n]+/gu) ?? [];
  let fallback: string | null = null;
  for (const line of candidates) {
    const parts = line.trim().split(/\s+/u);
    // candidate:<foundation> <component> <transport> <priority> <address> <port> typ ...
    const address = parts[4];
    const port = parts[5];
    if (!address || !port || !/^\d+$/u.test(port)) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/u.test(address)) continue;
    if (address.startsWith('127.')) continue;
    if (address.startsWith('192.168.') || address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./u.test(address)) {
      return `${address}:${port}`;
    }
    if (!fallback) fallback = `${address}:${port}`;
  }
  return fallback;
}

/**
 * All reachable interface addresses from an SDP, private ranges first.
 *
 * A machine can expose several interfaces (VPN, docker, Wi-Fi). The guest should
 * try them in order rather than trust whichever candidate happened to come first.
 */
export function lanAddressesFromSdp(sdp: string): string[] {
  const candidates = sdp.match(/a=candidate:[^\r\n]+/gu) ?? [];
  const privateUsed: string[] = [];
  const others: string[] = [];
  for (const line of candidates) {
    const parts = line.trim().split(/\s+/u);
    const address = parts[4];
    const port = parts[5];
    if (!address || !port || !/^\d+$/u.test(port)) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/u.test(address)) continue;
    if (address.startsWith('127.')) continue;
    const entry = `${address}:${port}`;
    const isPrivate =
      address.startsWith('192.168.') ||
      address.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./u.test(address);
    const bucket = isPrivate ? privateUsed : others;
    if (!bucket.includes(entry)) bucket.push(entry);
  }
  return [...privateUsed, ...others];
}

/** A link that pairs without a reply: it names a rendezvous room on the LAN. */
export function buildRoomLink(input: {
  room: string;
  host: string;
  projectId: string;
  name?: string;
}): string {
  const base = import.meta.env.BASE_URL || '/';
  const url = new URL(`${base.replace(/\/+$/u, '')}/join`, window.location.origin);
  url.searchParams.set('room', input.room);
  url.searchParams.set('host', input.host);
  url.searchParams.set('p', input.projectId);
  if (input.name) url.searchParams.set('n', input.name);
  return url.toString();
}

export interface RoomInvite {
  room: string;
  host: string;
  projectId: string;
  name: string;
}

export function parseRoomLink(input: string): RoomInvite | null {
  let parsed: URL;
  try {
    parsed = new URL(input, window.location.origin);
  } catch {
    return null;
  }
  if (!parsed.pathname.endsWith('/join')) return null;
  const room = parsed.searchParams.get('room')?.trim();
  const host = parsed.searchParams.get('host')?.trim();
  const projectId = parsed.searchParams.get('p')?.trim();
  if (!room || !host || !projectId) return null;
  return { room, host, projectId, name: parsed.searchParams.get('n')?.trim() ?? '' };
}

/** Small, unambiguous room id; no characters that need URL escaping. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}
