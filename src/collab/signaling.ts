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