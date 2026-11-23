import { z } from 'zod';
import { MAX_SCRIPT_BRIEF_LENGTH } from '../shared/scriptGeneration';

export const MAX_TEMPLATE_NAME_LENGTH = 80;
const STORAGE_KEY = 'voices-playground.script-brief-templates.v1';
const DEFAULT_BRIEF_STORAGE_KEY = 'voices-playground.default-script-brief.v1';
const promptSchema = z.string().max(MAX_SCRIPT_BRIEF_LENGTH).refine(prompt => !!prompt.trim(), 'Enter a content brief.');
const templateSchema = z.object({
  name: z.string().trim().min(1, 'Enter a template name.').max(MAX_TEMPLATE_NAME_LENGTH),
  prompt: promptSchema,
}).strict();
export type BriefTemplate = z.infer<typeof templateSchema>;
const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

export function loadDefaultBrief(storage: Pick<Storage, 'getItem'>): string | null {
  return promptSchema.nullable().parse(storage.getItem(DEFAULT_BRIEF_STORAGE_KEY));
}

export function saveDefaultBrief(storage: Pick<Storage, 'setItem'>, prompt: string): void {
  const parsed = promptSchema.safeParse(prompt);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  try { storage.setItem(DEFAULT_BRIEF_STORAGE_KEY, parsed.data); }
  catch { throw new Error('Could not save the default brief in this browser. Your brief is still in the editor.'); }
}

export function loadBriefTemplates(storage: Pick<Storage, 'getItem'>): BriefTemplate[] {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return [];
  return z.array(templateSchema).parse(JSON.parse(saved));
}

export function saveBriefTemplate(
  storage: Pick<Storage, 'getItem' | 'setItem'>, draft: BriefTemplate, builtIns: readonly BriefTemplate[],
): { template: BriefTemplate; templates: BriefTemplate[] } {
  const parsed = templateSchema.safeParse(draft);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const template = parsed.data;
  let existing: BriefTemplate[];
  try { existing = loadBriefTemplates(storage); }
  catch { throw new Error('Saved templates could not be read. No templates were overwritten.'); }
  if ([...builtIns, ...existing].some(item => nameKey(item.name) === nameKey(template.name))) {
    throw new Error('A template with that name already exists. Choose a different name.');
  }
  const templates = [...existing, template];
  try { storage.setItem(STORAGE_KEY, JSON.stringify(templates)); }
  catch { throw new Error('Could not save the template to this browser. Your brief is still in the editor.'); }
  return { template, templates };
}

export function updateBriefTemplate(
  storage: Pick<Storage, 'getItem' | 'setItem'>, name: string, prompt: string,
): BriefTemplate[] {
  const parsed = promptSchema.safeParse(prompt);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  let existing: BriefTemplate[];
  try { existing = loadBriefTemplates(storage); }
  catch { throw new Error('Saved templates could not be read. No templates were changed.'); }
  if (!existing.some(template => template.name === name)) {
    throw new Error('This saved template no longer exists. Your brief is still in the editor.');
  }
  const templates = existing.map(template => template.name === name ? { ...template, prompt: parsed.data } : template);
  try { storage.setItem(STORAGE_KEY, JSON.stringify(templates)); }
  catch { throw new Error('Could not update the template in this browser. Your brief is still in the editor.'); }
  return templates;
}

export function deleteBriefTemplate(storage: Pick<Storage, 'getItem' | 'setItem'>, name: string): BriefTemplate[] {
  let existing: BriefTemplate[];
  try { existing = loadBriefTemplates(storage); }
  catch { throw new Error('Saved templates could not be read. No templates were changed.'); }
  if (!existing.some(template => template.name === name)) {
    throw new Error('This saved template no longer exists. No templates were deleted.');
  }
  const templates = existing.filter(template => template.name !== name);
  try { storage.setItem(STORAGE_KEY, JSON.stringify(templates)); }
  catch { throw new Error('Could not delete the template from this browser.'); }
  return templates;
}
