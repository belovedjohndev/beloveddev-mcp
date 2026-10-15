import { noteCategories } from '@beloveddev/domain/entities';
import { z } from 'zod';

// Preserve exact text and opaque keys: whitespace changes are distinct operations.
// Reject NUL and lone surrogates; the Unicode regex permits valid surrogate pairs.
export const createProjectNoteInput = z.strictObject({
  projectId: z.uuid(),
  category: z.enum(noteCategories),
  content: z
    .string()
    .min(1)
    .max(10_000)
    .refine((value) => /\S/u.test(value) && !/\0|[\uD800-\uDFFF]/u.test(value)),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .refine((value) => /\S/u.test(value) && !/\0|[\uD800-\uDFFF]/u.test(value)),
});
