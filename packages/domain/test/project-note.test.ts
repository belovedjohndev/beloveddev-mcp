import type { ProjectNote } from '../src/entities.js';
import { matchesProjectNotePayload } from '../src/project-note.js';
import { describe, expect, it } from 'vitest';

const note: ProjectNote = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  projectId: '00000000-0000-4000-8000-000000000003',
  authorUserId: '00000000-0000-4000-8000-000000000004',
  category: 'decision',
  content: 'Use PostgreSQL.\n',
  idempotencyKey: 'note-request-1',
  createdAt: new Date('2026-10-12T00:00:00Z'),
};

describe('project note retry payload comparison', () => {
  it('matches exactly the project, category, and content', () => {
    expect(matchesProjectNotePayload(note, note)).toBe(true);
  });

  it.each([
    { projectId: '00000000-0000-4000-8000-000000000005' },
    { category: 'technical' as const },
    { content: 'Use SQLite.\n' },
    { content: 'Use PostgreSQL.' },
    { content: 'use PostgreSQL.\n' },
  ])('detects a distinct payload: %j', (change) => {
    expect(matchesProjectNotePayload(note, { ...note, ...change })).toBe(false);
  });
});
