import { z } from 'zod';
import { scriptFileName } from './scriptGeneration.js';
import { studioLocaleCodeSchema } from './studio.js';

export const MAX_RECORDING_BRIEF_LENGTH = 8000;
export const MAX_RECORDING_ROWS = 200;
export const MAX_RECORDING_FILE_ROWS = 8000;
export const RECORDING_BATCH_CHARACTERS = 1800;
export const MAX_RECORDING_DOMAINS = 20;
export const MAX_RECORDING_DOMAIN_LENGTH = 80;
export const MAX_RECORDING_TARGET_CHARACTERS = 100_000;
export const RECORDING_EXPORT_BATCH_SIZE = 10;
export const DEFAULT_RECORDING_ROLE = 'Agent';
export const RECORDING_AGENT_ACKNOWLEDGMENTS = 'Start every service Agent reply with a short, audible acknowledgment of what the Customer just said, before any question, explanation, or next step. Usually a few words are enough; then move straight to the useful response. Acknowledgment does not mean repeating the problem or delivering a full sentence of sympathy on every turn. Express empathy briefly when the Customer first raises a concern or shares a new impact. On routine follow-ups, acknowledge the new detail or answer without paraphrasing it. This applies in every locale: in vi-VN, for example, use brief, relationship-appropriate cues such as "Dạ, em rõ rồi" where it fits, not a repeated full sentence about how the Customer must feel. English examples only: "Yep, got it", "Alright, I see", "Sure", or "Of course". Use locally natural equivalents, not literal translations or a required phrase list. Use "Definitely" only for something the Agent can actually confirm. Do not use the opener as a greeting, a filler, or an unverified promise. Use each opener at most twice across the script and never on consecutive Agent turns. Before returning the script, revise Agent replies that skip the acknowledgment, repeat the same opener back to back, or restate something the Customer already said without a verification need.';
export const RECORDING_LOCAL_SPEECH = 'For every locale, write dialogue that sounds like a real local phone conversation, not formal prose or translated English. Use short clauses, everyday phrasing, and forms of address that fit the speakers. Keep the target language primary, but actively use familiar loanwords or brief, idiomatic code-switches where local speakers would naturally use them for that topic. For example, in zh-HK keep the conversation in colloquial Hong Kong Cantonese and naturally mix in terms like booking, email, refund, or check when they fit. This is an example, not a rule limited to zh-HK or a requirement to use English: in any locale, prefer the natural local expression when mixing would sound forced. No fixed terms or mixing quota.';
export const RECORDING_DATE_TIME_DETAILS = 'In every locale, build useful date and time details into the dialogue regularly. Plan scenarios where a date, clock time, or time window matters, and include at least one concrete timing detail in most calls: for example a transaction timestamp, delivery window, appointment date and time, cutoff, outage start, or callback slot. Across the calls, use a mix of calendar dates, clock times, and time windows rather than only vague references such as "soon" or "the other day". Use digits and locally natural date order, time notation, and spoken phrasing. Keep details consistent and read them back only when needed. Do not add a date or time where it would sound forced.';
export const DEFAULT_RECORDING_ID_START = '4010000001';
export const RECORDING_COLUMNS = ['ID', 'Scenario', 'Turn', 'Role', 'Content', 'Emotional Tone', 'Wordcount'] as const;

const localeSchema = z.string().trim().pipe(studioLocaleCodeSchema);
const roleSchema = z.string().trim().max(60).regex(/^[^\t\r\n]*$/, 'Use a role name without tabs or line breaks.');
const domainSchema = z.string().trim().min(1).max(MAX_RECORDING_DOMAIN_LENGTH)
  .regex(/^[^\t\r\n,;]+$/, 'Separate domains with commas, semicolons, or new lines.');
const cell = (max: number) => z.string().trim().max(max).regex(/^[^\t\r\n]*$/);

export const recordingDomainsSchema = z.array(domainSchema).min(1, 'Enter at least one domain.')
  .max(MAX_RECORDING_DOMAINS, `Enter no more than ${MAX_RECORDING_DOMAINS} domains.`)
  .superRefine((domains, context) => {
    if (new Set(domains.map(domain => domain.toLocaleLowerCase())).size !== domains.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each domain must be unique.' });
  });

export function parseRecordingDomains(value: string): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const domain of value.split(/[,;\r\n]+/).map(item => item.trim()).filter(Boolean)) {
    const key = domain.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); domains.push(domain); }
  }
  return domains;
}

export const recordingIdStartSchema = z.string().trim()
  .regex(/^\d{1,18}$/, 'Enter a starting ID of 1 to 18 digits, for example 4010000001.');

export const recordingRowSchema = z.object({
  id: cell(40),
  scenario: cell(120).min(1),
  turn: z.number().int().min(1).max(MAX_RECORDING_ROWS),
  role: cell(60).min(1),
  content: cell(2000).min(1),
  tone: cell(60),
  wordCount: z.number().int().min(0).max(5000),
}).strict();
export type RecordingRow = z.infer<typeof recordingRowSchema>;

export const recordingAgentGenderSchema = z.enum(['female', 'male']);
export type RecordingAgentGender = z.infer<typeof recordingAgentGenderSchema>;

export type RecordingVariant = { locale: string; agentGender?: RecordingAgentGender };

export function recordingVariantKey({ locale, agentGender }: RecordingVariant): string {
  return `${locale.toLowerCase()}:${agentGender ?? ''}`;
}

export function recordingVariants(locales: string[], genders: RecordingAgentGender[]): RecordingVariant[] {
  return locales.flatMap(locale => genders.length ? genders.map(agentGender => ({ locale, agentGender })) : [{ locale }]);
}

export function recordingScenarioKey(scenario: string): string {
  return scenario.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export const recordingScriptSchema = z.object({
  locale: localeSchema,
  agentGender: recordingAgentGenderSchema.optional(),
  rows: z.array(recordingRowSchema).min(1).max(MAX_RECORDING_FILE_ROWS),
}).strict();
export type RecordingScript = z.infer<typeof recordingScriptSchema>;

export const recordingGenerateSchema = z.object({
  locale: localeSchema,
  prompt: z.string().trim().min(1, 'Describe what the recording script should cover.').max(MAX_RECORDING_BRIEF_LENGTH),
  recordedRole: roleSchema,
  agentGender: recordingAgentGenderSchema.optional(),
  domains: recordingDomainsSchema,
  previousScenarios: z.array(cell(120).min(1)).max(MAX_RECORDING_FILE_ROWS).optional(),
  totalCharacters: z.number().int().min(1).max(MAX_RECORDING_TARGET_CHARACTERS).optional(),
  consent: z.literal(true),
}).strict();
export type RecordingGenerateRequest = z.infer<typeof recordingGenerateSchema>;

export const recordingBatchRequestSchema = z.object({
  runId: z.string().uuid(),
  input: recordingGenerateSchema.extend({
    totalCharacters: z.number().int().min(1).max(MAX_RECORDING_TARGET_CHARACTERS),
  }),
}).strict();
export type RecordingBatchRequest = z.infer<typeof recordingBatchRequestSchema>;
export const recordingBatchRunSchema = recordingBatchRequestSchema.extend({
  targets: z.array(recordingScriptSchema.pick({ locale: true, agentGender: true })).min(1),
});
export type RecordingBatchRun = z.infer<typeof recordingBatchRunSchema>;

const recordingBatchProgress = {
  characters: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
};
export const recordingBatchResultSchema = z.discriminatedUnion('done', [
  z.object({ ...recordingBatchProgress, done: z.literal(false) }),
  z.object({ ...recordingBatchProgress, done: z.literal(true), script: recordingScriptSchema }),
]);
export type RecordingBatchResult = z.infer<typeof recordingBatchResultSchema>;

export function usesRecordingBatches(input: RecordingGenerateRequest): input is RecordingBatchRequest['input'] {
  return input.totalCharacters !== undefined && input.totalCharacters > RECORDING_BATCH_CHARACTERS;
}

export const recordingExportSchema = z.object({
  directory: z.string().trim().min(1, 'Enter a destination folder.').max(2048),
  name: z.string().trim().min(1, 'Enter a file name.').max(200),
  recordedRole: roleSchema,
  scripts: z.array(recordingScriptSchema).min(1).max(RECORDING_EXPORT_BATCH_SIZE)
    .refine(scripts => new Set(scripts.map(recordingVariantKey)).size === scripts.length, 'Each locale and Agent gender combination must be unique.'),
}).strict();
export type RecordingExportResult = { file: string; path?: string; error?: string }[];

/** Rows as returned by the model; IDs, turns and word counts are added by the app. */
export const recordingDraftSchema = z.object({
  rows: z.array(z.object({
    conversation: z.coerce.number().int().min(1).max(MAX_RECORDING_ROWS),
    scenario: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(60),
    content: z.string().trim().min(1).max(2000),
    tone: z.string().nullish().transform(value => value?.trim() ?? ''),
  })).min(1).max(MAX_RECORDING_ROWS),
});
export type RecordingDraft = z.infer<typeof recordingDraftSchema>;

export function cleanCell(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

export function isRecordedRole(role: string, recordedRole: string): boolean {
  const target = recordedRole.trim();
  return !target || role.trim().localeCompare(target, undefined, { sensitivity: 'accent' }) === 0;
}

function segmenter(locale: string): Intl.Segmenter {
  try { return new Intl.Segmenter(locale, { granularity: 'word' }); }
  catch { return new Intl.Segmenter(locale.split('-')[0], { granularity: 'word' }); }
}

/** Counts words with the locale's word-break rules, so CJK and Thai text is segmented instead of split on spaces. */
export function countWords(text: string, locale: string): number {
  let count = 0;
  for (const segment of segmenter(locale).segment(text)) if (segment.isWordLike) count++;
  return count;
}

export function buildRecordingRows(draft: RecordingDraft, locale: string, recordedRole: string): RecordingRow[] {
  let conversation: number | undefined;
  let turn = 0;
  return draft.rows.map(row => {
    if (row.conversation !== conversation) { conversation = row.conversation; turn = 0; }
    turn++;
    const content = cleanCell(row.content);
    const recorded = isRecordedRole(row.role, recordedRole);
    return {
      id: '', scenario: cleanCell(row.scenario), turn, role: cleanCell(row.role), content,
      tone: recorded ? cleanCell(row.tone) : '', wordCount: countWords(content, locale),
    };
  });
}

export function recordingCharacterCount(rows: RecordingRow[]): number {
  return rows.reduce((total, row) => total + Array.from(row.content).length, 0);
}

export function assignRecordingIds(scripts: RecordingScript[], idStart: string, recordedRole: string): RecordingScript[] {
  const start = recordingIdStartSchema.parse(idStart);
  const first = BigInt(start);
  return scripts.map(script => {
    let next = first;
    return {
      ...script,
      rows: script.rows.map(row => {
        if (!isRecordedRole(row.role, recordedRole)) return { ...row, id: '' };
        const id = next.toString().padStart(start.length, '0');
        next++;
        return { ...row, id };
      }),
    };
  });
}

export function recordingToneHeader(recordedRole: string): string {
  return recordedRole.trim() ? `${recordedRole.trim()} Emotional Tone` : 'Emotional Tone';
}

export function recordingScriptFileName(locale: string, name: string, agentGender?: RecordingAgentGender): string {
  const suffix = agentGender === 'female' ? '_Female' : agentGender === 'male' ? '_Male' : '';
  return scriptFileName(locale, name).replace(/\.txt$/, `${suffix}.xlsx`);
}

export function recordingScriptTable(script: RecordingScript, recordedRole: string): (string | number)[][] {
  const header = RECORDING_COLUMNS.map(column => column === 'Emotional Tone' ? recordingToneHeader(recordedRole) : column);
  return [header, ...script.rows.map(row => [row.id, row.scenario, row.turn, row.role, row.content, row.tone, row.wordCount])];
}

export function recordingScriptText(script: RecordingScript, recordedRole: string): string {
  return recordingScriptTable(script, recordedRole).map(columns => `${columns.join('\t')}\r\n`).join('');
}
