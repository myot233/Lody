import { z } from 'zod';
import type { LodyComponentDocument, LodyComponentEvent } from 'acp-extension-core';
export type { LodyComponentDocument, LodyComponentEvent } from 'acp-extension-core';

const text = z.string().max(65_536);
const id = z.string().min(1).max(128);
const input = z.string().max(4096);
const color = z.string().regex(/^#[\da-f]{6}$/i);
export const lodyComponentDocumentSchema: z.ZodType<LodyComponentDocument> = z
  .object({
    version: z.literal(1),
    id,
    revision: z.number().int().nonnegative(),
    title: z.string().max(512),
    theme: z
      .object({ name: id, foreground: color, background: color, accent: color })
      .strict()
      .optional(),
    nodes: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text }).strict(),
          z.object({ type: z.literal('button'), id, label: z.string().max(512), input }).strict(),
          z.object({ type: z.literal('input'), id, label: z.string().max(512) }).strict(),
        ])
      )
      .max(256),
    keybindings: z
      .array(z.object({ key: id, label: z.string().max(512), input }).strict())
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.nodes.flatMap((node) => (node.type === 'text' ? [] : [node.id]));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate control id' });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 131_072)
      ctx.addIssue({ code: 'custom', message: 'Component document exceeds limit' });
  });

export const lodyComponentEventSchema: z.ZodType<LodyComponentEvent> = z
  .object({
    version: z.literal(1),
    componentId: id,
    revision: z.number().int().nonnegative(),
    input,
  })
  .strict();

export function parseLodyComponentDocument(value: unknown): LodyComponentDocument | undefined {
  const parsed = lodyComponentDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
