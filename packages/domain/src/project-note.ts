import type { ProjectNote } from './entities.js';

export type ProjectNotePayload = Pick<ProjectNote, 'projectId' | 'category' | 'content'>;

/** Tenant, author, and key are scoped by the caller before comparing payloads. */
export function matchesProjectNotePayload(note: ProjectNote, payload: ProjectNotePayload): boolean {
  return (
    note.projectId === payload.projectId &&
    note.category === payload.category &&
    note.content === payload.content
  );
}
