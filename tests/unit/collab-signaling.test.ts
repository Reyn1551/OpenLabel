import { describe, expect, it } from 'vitest';
import {
  buildInviteLink,
  buildRoomLink,
  lanAddressesFromSdp,
  newRoomId,
  parseRoomLink,
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

describe('LAN rendezvous links', () => {
  const SDP = [
    'v=0',
    'a=candidate:1 1 udp 2113937151 8f2a-11c2.local 52784 typ host generation 0',
    'a=candidate:2 1 udp 1677729535 103.19.180.14 52784 typ srflx raddr 0.0.0.0 rport 0',
    'a=candidate:3 1 udp 2113939711 192.168.1.24 46645 typ host generation 0',
    'a=candidate:4 1 udp 2113939711 127.0.0.1 40000 typ host generation 0',
  ].join('\r\n');

  it('returns real interface addresses, private ranges first', () => {
    expect(lanAddressesFromSdp(SDP)).toEqual(['192.168.1.24:46645', '103.19.180.14:52784']);
  });

  it('ignores mDNS names, loopback, and malformed lines', () => {
    const addresses = lanAddressesFromSdp(SDP);
    expect(addresses.some((entry) => entry.includes('.local'))).toBe(false);
    expect(addresses.some((entry) => entry.startsWith('127.'))).toBe(false);
    expect(lanAddressesFromSdp('nothing here')).toEqual([]);
  });

  it('deduplicates the same interface reported twice', () => {
    const twice = `${SDP}\r\na=candidate:9 1 udp 1 192.168.1.24 46645 typ host`;
    expect(lanAddressesFromSdp(twice).filter((e) => e.startsWith('192.168.1.24'))).toHaveLength(1);
  });

  it('round-trips a room link and marks it as needing no reply', () => {
    const link = buildRoomLink({
      room: 'abc123def456',
      host: '192.168.1.24:4173',
      projectId: 'prj_9',
      name: 'Bearing inspection',
    });
    expect(link).toContain('room=abc123def456');
    expect(link).toContain('host=192.168.1.24%3A4173');
    expect(link).not.toContain('r=1');
    expect(parseRoomLink(link)).toEqual({
      room: 'abc123def456',
      host: '192.168.1.24:4173',
      projectId: 'prj_9',
      name: 'Bearing inspection',
    });
  });

  it('rejects a room link that is missing the host or room', () => {
    expect(parseRoomLink('http://localhost:4173/join?room=abc&p=prj_1')).toBeNull();
    expect(parseRoomLink('http://localhost:4173/join?host=1.2.3.4:80&p=prj_1')).toBeNull();
    expect(parseRoomLink('http://localhost:4173/projects/prj_1/team')).toBeNull();
  });

  it('generates url-safe room ids that differ each time', () => {
    const ids = new Set(Array.from({ length: 40 }, () => newRoomId()));
    expect(ids.size).toBe(40);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/);
  });
});
