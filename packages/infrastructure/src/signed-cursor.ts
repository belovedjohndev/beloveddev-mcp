import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CursorCodec, PageCursor } from '@beloveddev/application/pagination';
import { ApplicationError } from '@beloveddev/application/application-error';
import { blockerSeverities, projectStatuses } from '@beloveddev/domain/entities';
import { z } from 'zod';

const cursorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('projects'),
    tenantId: z.uuid(),
    status: z.enum(projectStatuses).nullable(),
    clientId: z.uuid().nullable(),
    query: z.string().min(1).max(200).nullable(),
    position: z.strictObject({ id: z.uuid() }),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('blockers'),
    tenantId: z.uuid(),
    projectId: z.uuid().nullable(),
    severity: z.enum(blockerSeverities).nullable(),
    position: z.strictObject({
      id: z.uuid(),
      blockedSince: z.iso.datetime({ precision: 6 }),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('evidence_search'),
    tenantId: z.uuid(),
    queryFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    position: z.strictObject({
      id: z.uuid(),
      relevanceScore: z
        .string()
        .min(1)
        .max(32)
        .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/)
        .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('opportunities'),
    tenantId: z.uuid(),
    filterFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    position: z.strictObject({
      id: z.uuid(),
      orderingTimestamp: z.iso.datetime({ precision: 6 }),
    }),
  }),
]);

export class SignedCursorCodec implements CursorCodec {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret, 'utf8') < 32)
      throw new Error('Cursor signing key must contain at least 32 bytes.');
  }
  encode(cursor: PageCursor): string {
    const payload = Buffer.from(JSON.stringify(cursorSchema.parse(cursor)), 'utf8').toString(
      'base64url',
    );
    return payload + '.' + this.signature(payload).toString('base64url');
  }
  decode(token: string): PageCursor {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error();
      const [payload, signature] = token.split('.');
      if (payload === undefined || signature === undefined) throw new Error();
      const supplied = Buffer.from(signature, 'base64url');
      if (
        supplied.toString('base64url') !== signature ||
        !timingSafeEqual(supplied, this.signature(payload))
      )
        throw new Error();
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) throw new Error();
      return cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new ApplicationError('VALIDATION_ERROR');
    }
  }
  private signature(payload: string): Buffer {
    return createHmac('sha256', this.secret).update('beloveddev-cursor:').update(payload).digest();
  }
}
