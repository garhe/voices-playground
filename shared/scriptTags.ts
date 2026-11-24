import { z } from 'zod';
import { DEFAULT_EXPRESSION_TAG_LISTS, expressionTagListsSchema, type ExpressionTagLists } from './scriptExpressionTags.js';
import { MAX_SCRIPT_FILE_BYTES } from './scriptSources.js';

export const MAX_TAG_SCRIPT_FILES = 50;
export const scriptTagSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paths'), paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(MAX_TAG_SCRIPT_FILES) }).strict(),
  z.object({ type: z.literal('text'), name: z.string().trim().min(1).max(240).regex(/^[^<>:"/\\|?*\p{Cc}]+$/u),
    text: z.string().min(1).max(MAX_SCRIPT_FILE_BYTES) }).strict(),
]);
export const scriptTagInspectionSchema = z.object({
  source: scriptTagSourceSchema,
  tagLists: expressionTagListsSchema.optional(),
}).strict();
export const scriptTagRequestSchema = z.object({
  action: z.enum(['add', 'remove']),
  source: scriptTagSourceSchema,
  tagLists: expressionTagListsSchema.optional(),
  consent: z.boolean().optional(),
}).strict().refine(input => input.action === 'remove' || input.consent === true,
  'Confirm that Azure may receive the script text before adding tags.');

export type ScriptTagRequest = z.input<typeof scriptTagRequestSchema>;
export type ScriptTagSource = z.infer<typeof scriptTagSourceSchema>;
export type ScriptTagResult = { source: string; name: string; path?: string; text?: string; error?: string };
export type ScriptTagInspection = { source: string; tagged?: boolean; error?: string };

export function scriptHasExpressionTags(text: string, lists: ExpressionTagLists = DEFAULT_EXPRESSION_TAG_LISTS): boolean {
  const known = new Set([
    ...DEFAULT_EXPRESSION_TAG_LISTS.styles, ...DEFAULT_EXPRESSION_TAG_LISTS.sounds,
    ...lists.styles, ...lists.sounds,
  ].map(name => name.toLowerCase()));
  const lines = text.split(/\r\n|\n|\r/);
  const first = lines.findIndex(line => line.trim());
  const header = lines[first]?.trim() === '---';
  const end = header ? lines.findIndex((line, index) => index > first && line.trim() === '---') : -1;
  const firstSpoken = lines.findIndex((line, index) =>
    index > end && line.trim() && !line.trimStart().startsWith('//'));
  if (header && end < 0) return false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index <= end || !line.trim() || line.trimStart().startsWith('//')) continue;
    const tab = line.indexOf('\t');
    if (tab >= 0 && index === firstSpoken && /^(filename|file|name|id)$/i.test(line.slice(0, tab).trim())) continue;
    const value = tab >= 0 ? line.slice(tab + 1) : line;
    const quoted = /^(\s*")(.*)("\s*)$/u.exec(value);
    const spoken = quoted ? quoted[2] : value;
    const annotation = /\[([\p{L}][\p{L}\p{N}_-]*)\]/giu;
    for (const match of spoken.matchAll(annotation)) if (known.has(match[1].toLowerCase())) return true;
  }
  return false;
}
