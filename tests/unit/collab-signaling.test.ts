import { describe, expect, it } from 'vitest';
import {
  buildInviteLink,
  decodeSignalLink,
  encodeSignal,
  encodeSignalLink,
  parseInviteLink,
  type Signal,
} from '@/collab/signaling';

const OFFER: Signal = {
  v: 1,
  kind: 'offer',
  peer: 'peer-aaaaaaaaaaaaaaaa',
  sdp: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n${'a=candidate:1 1 udp 1 192.168.1.9 5000 typ host\r\n'.repeat(40)}`,
};

describe('invite links', () => {
  it('round-trips a compressed code', async () => {
    const code = await encodeSignalLink(OFFER);
    expect(code.startsWith('OL2.')).toBe(true);
    await expect(decodeSignalLink(code)).resolves.toEqual(OFFER);
  });

  it('still decodes the uncompressed form', async () => {
    const code = encodeSignal(OFFER);
    expect(code.startsWith('OL1.')).toBe(true);
    await expect(decodeSignalLink(code)).resolves.toEqual(OFFER);
  });

  it('is meaningfully smaller than plain base64 for repetitive SDP', async () => {
    const plain = encodeSignal(OFFER);
    const packed = await encodeSignalLink(OFFER);
    expect(packed.length).toBeLessThan(plain.length * 0.6);
  });

  it('builds a link the app can route to, carrying project and name', () => {
    const link = buildInviteLink('OL2.abc', 'prj_123', 'Bearing inspection');
    expect(link).toContain('/join?');
    expect(link).toContain('c=OL2.abc');
    expect(link).toContain('p=prj_123');
    expect(link).toContain('n=Bearing+inspection');
    expect(link).not.toContain('r=1');
  });

  it('marks a reply link and parses it back', () => {
    const link = buildInviteLink('OL2.abc', 'prj_123', 'Bearing inspection', true);
    expect(parseInviteLink(link)).toEqual({
      code: 'OL2.abc',
      projectId: 'prj_123',
      name: 'Bearing inspection',
      reply: true,
    });
  });

  it('rejects a link without a code or project', () => {
    expect(parseInviteLink('http://localhost:4173/join?p=prj_1')).toBeNull();
    expect(parseInviteLink('http://localhost:4173/join?c=OL2.abc')).toBeNull();
    expect(parseInviteLink('http://localhost:4173/projects/prj_1/team')).toBeNull();
    expect(parseInviteLink('not a url at all')).toBeNull();
  });

  it('reports a truncated compressed code instead of throwing raw', async () => {
    const code = await encodeSignalLink(OFFER);
    await expect(decodeSignalLink(code.slice(0, 40))).rejects.toThrow(/truncated|decompress/i);
  });

  it('rejects a code with the wrong prefix', async () => {
    await expect(decodeSignalLink('NOPE.abc')).rejects.toThrow(/Not an OpenLabel invite code/);
  });
});
