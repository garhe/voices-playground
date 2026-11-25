import { z } from 'zod';
import { scriptExportFormatSchema, scriptFileName, type ScriptExportFormat } from './scriptGeneration.js';
import { studioLocaleCodeSchema } from './studio.js';

export const MAX_RECORDING_BRIEF_LENGTH = 8000;
export const MAX_RECORDING_ROWS = 200;
export const MAX_RECORDING_FILE_ROWS = 8000;
export const RECORDING_BATCH_CHARACTERS = 1800;
export const RECORDING_BATCH_START_CONCURRENCY = 4;
export const RECORDING_BATCH_CONCURRENCY = 20;
export const MAX_RECORDING_DOMAINS = 20;
export const MAX_RECORDING_DOMAIN_LENGTH = 80;
export const MAX_RECORDING_TARGET_CHARACTERS = 100_000;
export const RECORDING_EXPORT_BATCH_SIZE = 10;
export const DEFAULT_RECORDING_ROLE = 'Agent';
export const RECORDING_AGENT_ACKNOWLEDGMENTS = 'Make warmth, patience, and professionalism audible in the Agent’s words, not just the tone label. Welcome routine callers with genuine enthusiasm; meet worry or frustration with calm, specific compassion. Show care by offering to help and explaining the next step. Ask rather than command, and thank callers for their time or effort when it fits. Use natural local politeness, not stock phrases or forced cheer.';
export const RECORDING_INTERJECTIONS = 'In at least 70% of calls (round up), the Agent uses an audible local interjection or conversational particle. Place it where speakers naturally do: at the start, mid-turn, or at the end of a clause. Vary expressions and placement, not a token on every turn. An English “Oh” or a Cantonese “嘅” can fit; use other languages’ own markers. Avoid dismissive reactions and do not count silence or punctuation.';
export const RECORDING_AGENT_COVERAGE = 'All coverage targets apply only to the Agent, even when another role is recorded. Customer lines should sound natural and include details only when the scenario calls for them; they neither count toward nor constrain Agent coverage.';
export const RECORDING_SUBTYPE_COVERAGE = 'In each locale and Agent-gender workbook, at least 5% of calls (rounded up) must cover each Agent speech subtype, even with a narrow topic selection. Agent spelling and clarity readback also have separate 5% minimums. A call counts once per subtype and can cover several. Existing higher minimums and exact email and website quotas still apply.';
// Full street addresses, emails and URLs already have stronger or exact validators.
export const RECORDING_ANNOTATED_SUBTYPES = {
  organization: 'organization or brand name',
  product: 'named product',
  title: 'personal, professional or honorific title',
  country: 'country name',
  region: 'state, province or region name',
  locality: 'city, town, village, district or neighborhood name',
  transitLandmark: 'transit hub, airport, landmark or road name',
  naturalFeature: 'named natural geographic feature',
  abbreviatedPlace: 'abbreviated place name',
  postalCode: 'ZIP or postal code',
  unitNumber: 'unit, apartment or suite number',
  domesticPhone: 'domestic mobile or telephone number (without country code)',
  internationalPhone: 'international mobile or telephone number (with country calling code)',
  phoneExtension: 'telephone extension number',
  date: 'calendar date',
  time: 'clock time',
  cardinal: 'cardinal or large number used as a value, not as an identifier',
  fractional: 'decimal, fraction or percentage',
  ordinalRangeQuantity: 'ordinal, numerical range or quantity',
  money: 'currency or financial amount',
  numericId: 'numeric identifier',
  alphabeticCode: 'alphabetic code',
  alphanumericId: 'alphanumeric identifier',
  formattedId: 'structured or formatted identifier',
  securityCode: 'fictional verification or security code',
  medicationTreatment: 'medication or treatment',
  conditionSymptom: 'medical condition or symptom',
  anatomySpecialty: 'anatomy or medical specialty',
  procedureTest: 'medical procedure or test',
  dosageFrequencyMeasurement: 'medical dosage, frequency or measurement',
  hardwareDevice: 'hardware or device term',
  softwarePlatformVersion: 'software, platform or version term',
  networkWebCloud: 'network, web or cloud term (not a URL)',
  spelling: 'spelling a word or name aloud to verify it',
  readback: 'repeating information from an earlier turn for clarity',
} as const;
export type RecordingAnnotatedSubtype = keyof typeof RECORDING_ANNOTATED_SUBTYPES;
export const recordingAnnotatedSubtypes = Object.keys(RECORDING_ANNOTATED_SUBTYPES) as RecordingAnnotatedSubtype[];
export const RECORDING_DISFLUENCIES = 'Write both sides for the ear with everyday local phrasing. In a typical 8–12-turn call, aim for 3–5 distinct moments of spontaneous speech in Agent replies; add more in longer calls if natural. Mix brief filled pauses, false starts, self-corrections, or repeated words while recalling, checking, or clarifying. Vary placement and leave many turns fluent. Use spoken words and ordinary punctuation, not stage directions or ellipses in place of speech. Keep names, digits, and contact details intact.';
export const RECORDING_LOCAL_SPEECH = 'For every locale, write dialogue that sounds like a real local phone conversation, not formal prose or translated English. Both speakers should use common local terms that name the actual place, object, or action in the scenario. Keep the target language primary; actively use familiar loanwords or brief, idiomatic code-switches where local speakers would naturally use them. In each non-English locale, include Agent-spoken English words in at least 50% of applicable calls, rounding up. Applicable calls are those whose topic and local speech conventions support natural English mixing; plan enough such cases rather than declaring them all inapplicable. English-language locales are exempt; prefer the natural local expression when mixing would sound forced. Customer-only English, email addresses, and reference codes do not count as Agent code-switching. Spread varied terms across domains and replies, not the same token in every call. Depending on the locale and topic, terms like cashback, tracking, late checkout, dashboard, roaming, or claim status may fit. These are examples, not a required phrase list. Do not rely on email, eSIM, or Wi-Fi as default English vocabulary or reuse one small English phrase bank across locales.';
export const RECORDING_DIALOGUE_VARIETY = 'Vary the Agent dialogue structure, not just scenarios and opening words. Across calls, vary turn counts within the brief limits, sentence shapes, reply lengths, question types, explanation depth, acknowledgment wording, and closing language. Use different appropriate paths: a targeted diagnostic question, a useful finding already available, a choice with trade-offs, step-by-step guidance, or a follow-up when a fix cannot be completed now. Keep necessary verification before protected actions, but do not force every call into the same verification-investigation-fix-confirmation wording or turn positions. Do not repeat sentence frames with only nouns, IDs, or dates replaced. Maintain variety across the whole script and earlier batches.';
export const RECORDING_SPOKEN_DETAILS = 'Have the Agent say varied amounts, quantities, percentages, durations, and service references using locally formatted digits. In at least 10% of calls per draft or batch (round up), the Agent says a familiar acronym or initialism. Plan contexts where one fits, such as ATM for cash access, ID for verification, or ASAP for urgency if idiomatic. Vary terms and use established local equivalents; do not force English. Airport codes, identifiers, and text inside emails or websites do not count. Avoid unnecessary personal-data readbacks.';
export const RECORDING_AGENT_OPENINGS = 'The Agent starts exactly 10% of calls per script, rounded up, with a warm local greeting, their fictional name, and a question asking how they can help. Vary the welcome. Otherwise the Customer starts. Both formats alternate and end with the Agent.';
export const RECORDING_CONTACT_DETAILS = 'Per workbook, exactly 5% of calls include an Agent-spoken fictional email and another 5% an Agent-spoken website, rounding each count up. Use separate calls, at most one email or website given by the Agent per call. Plan at least two calls for a standalone draft. Separately, at least 10% of calls per draft or batch need a full Agent-spoken service address (round up): number, street or building, and city or district, not the Customer’s home address. Use readable local fictional names and pronounceable standalone .com domains, not .test, example.com, or known brands.';
export const RECORDING_REFERENCE_DETAILS = 'Per locale and batch, at least 10% of calls each must include an Agent-spoken phone number, account number, and case/ticket number, counted separately and rounded up. Use distinct fictional values in local formats and reserved phone ranges where available; never use real numbers, card numbers, or credentials. When giving a phone number, say whose number it is and that it is a phone number or how to call it. Never say just a department name followed by digits. Spread the details across calls.';
export const RECORDING_DATE_TIME_DETAILS = 'In every locale, have the Agent give a concrete timing detail in most calls, such as a transaction timestamp, delivery window, appointment, cutoff, or callback slot. Across calls, use a mix of calendar dates, clock times, and time windows. Use digits and local formats; keep timing details consistent and read them back only when useful.';
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
  paired: z.literal(true).optional(),
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
  format: scriptExportFormatSchema.optional(),
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
    spokenAddress: z.string().trim().min(1).max(500).optional(),
    addressLocality: z.string().trim().min(1).max(200).optional(),
    introductionName: z.string().trim().min(1).max(100).optional(),
    spokenInterjection: z.string().trim().min(1).max(60).optional(),
    spokenAcronym: z.string().trim().min(1).max(30).optional(),
    phoneNumber: z.string().trim().min(1).max(60).optional(),
    accountNumber: z.string().trim().min(1).max(60).optional(),
    caseNumber: z.string().trim().min(1).max(60).optional(),
    spokenSubtypes: z.record(z.custom<RecordingAnnotatedSubtype>(
      key => typeof key === 'string' && Object.hasOwn(RECORDING_ANNOTATED_SUBTYPES, key), 'Unknown speech subtype'),
      z.string().trim().min(1).max(200)).optional(),
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

export function recordingScriptFileName(locale: string, name: string, agentGender?: RecordingAgentGender, format: ScriptExportFormat = 'xlsx'): string {
  const suffix = agentGender === 'female' ? '_Female' : agentGender === 'male' ? '_Male' : '';
  return scriptFileName(locale, name).replace(/\.txt$/, `${suffix}.${format}`);
}

export function recordingScriptTable(script: RecordingScript, recordedRole: string): (string | number)[][] {
  const header = RECORDING_COLUMNS.map(column => column === 'Emotional Tone' ? recordingToneHeader(recordedRole) : column);
  return [header, ...script.rows.map(row => [row.id, row.scenario, row.turn, row.role, row.content, row.tone, row.wordCount])];
}

export function recordingScriptText(script: RecordingScript, recordedRole: string): string {
  return recordingScriptTable(script, recordedRole).map(columns => `${columns.join('\t')}\r\n`).join('');
}
