import type { BlockerSeverity, ProjectStatus } from '@beloveddev/domain/entities';

export interface ProjectPosition {
  readonly id: string;
}
export interface BlockerPosition {
  readonly id: string;
  /** UTC ISO timestamp with six fractional digits, preserving PostgreSQL precision. */
  readonly blockedSince: string;
}
export interface EvidenceSearchPosition {
  readonly id: string;
  /** Canonical PostgreSQL real output, used for an exact rank keyset comparison. */
  readonly relevanceScore: string;
}

export type PageCursor =
  | {
      readonly version: 1;
      readonly kind: 'projects';
      readonly tenantId: string;
      readonly status: ProjectStatus | null;
      readonly clientId: string | null;
      readonly query: string | null;
      readonly position: ProjectPosition;
    }
  | {
      readonly version: 1;
      readonly kind: 'blockers';
      readonly tenantId: string;
      readonly projectId: string | null;
      readonly severity: BlockerSeverity | null;
      readonly position: BlockerPosition;
    }
  | {
      readonly version: 1;
      readonly kind: 'evidence_search';
      readonly tenantId: string;
      readonly queryFingerprint: string;
      readonly position: EvidenceSearchPosition;
    };

/** Encoding, integrity checks, and structural validation belong to the adapter. */
export interface CursorCodec {
  encode(cursor: PageCursor): string;
  decode(token: string): PageCursor;
}
