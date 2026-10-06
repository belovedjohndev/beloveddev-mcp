import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PageCursor } from '@beloveddev/application/pagination';
import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { SignedCursorCodec } from '../src/signed-cursor.js';

const secret = 'private-cursor-test-key-with-32-bytes';
const codec = new SignedCursorCodec(secret);
const projects: PageCursor = {
  version: 1,
  kind: 'projects',
  tenantId: fixtureId(1),
  status: null,
  clientId: null,
  query: null,
  position: { id: fixtureId(2) },
};
const blockers: PageCursor = {
  version: 1,
  kind: 'blockers',
  tenantId: fixtureId(1),
  projectId: null,
  severity: 'high',
  position: { id: fixtureId(2), blockedSince: '2026-02-01T09:00:00.123456Z' },
};
function sign(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return (
    payload +
    '.' +
    createHmac('sha256', secret).update('beloveddev-cursor:').update(payload).digest('base64url')
  );
}
describe('signed cursor integrity', () => {
  it.each([projects, blockers])('round trips deterministic versioned $kind positions', (cursor) => {
    const token = codec.encode(cursor);
    expect(token).toBe(codec.encode(cursor));
    expect(codec.decode(token)).toEqual(cursor);
    expect(token).not.toContain(secret);
  });
  it.each(['', 'bad', 'a.b', 'a'.repeat(4097), 'abc.def.extra'])(
    'rejects malformed tokens',
    (token) => {
      expect(() => codec.decode(token)).toThrow('The input is invalid.');
    },
  );
  it('rejects tampering, padding, and a different key', () => {
    const token = codec.encode(projects);
    const [payload, signature] = token.split('.');
    expect(() => codec.decode('A' + token.slice(1))).toThrow('The input is invalid.');
    expect(() => codec.decode(payload + '=.' + signature)).toThrow('The input is invalid.');
    expect(() =>
      new SignedCursorCodec('another-private-cursor-key-32-bytes').decode(token),
    ).toThrow('The input is invalid.');
  });
  it.each([
    { ...projects, version: 2 },
    { ...projects, kind: 'unknown' },
    { ...projects, tenantId: 'invalid' },
    { ...projects, position: { id: 'invalid' } },
    { ...projects, position: { id: fixtureId(2), offset: 1 } },
    { ...blockers, position: { id: fixtureId(2), blockedSince: '2026-02-01T09:00:00.123Z' } },
    { ...blockers, position: { id: fixtureId(2), blockedSince: 'invalid' } },
  ])('rejects signed but invalid cursor structures', (value) => {
    expect(() => codec.decode(sign(value))).toThrow('The input is invalid.');
  });
  it('rejects an undersized signing key without echoing it', () => {
    expect(() => new SignedCursorCodec('private-short')).toThrow(
      'Cursor signing key must contain at least 32 bytes.',
    );
  });
});
