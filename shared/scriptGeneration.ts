import { z } from 'zod';
import { expressionTagListsSchema } from './scriptExpressionTags.js';
import { parseAzureEndpoint } from './azure.js';
import { studioLocaleCodeSchema } from './studio.js';

export const SCRIPT_EXPORT_BATCH_SIZE = 10;
export const MAX_SCRIPT_UTTERANCES = 50;
export const MAX_SCRIPT_STYLE_LENGTH = 200;
export const MAX_SCRIPT_BRIEF_LENGTH = 4000;
const speakerCountSchema = z.union([z.literal(1), z.literal(2)]);
const briefSchema = z.string().trim().min(1, 'Describe what the script should cover.').max(MAX_SCRIPT_BRIEF_LENGTH);
const styleSchema = z.string().trim().min(1, 'Describe the script style.').max(MAX_SCRIPT_STYLE_LENGTH);

const localeSchema = z.string().trim().pipe(studioLocaleCodeSchema);
export const scriptDeploymentSchema = z.string().trim().regex(
  /^[a-zA-Z0-9._-]{1,120}$/, 'Enter a valid Azure OpenAI text deployment name.',
);
export const foundryResponsesEndpointSchema = z.string().trim().max(300).transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/openai/v1/responses', '/openai/v1/responses/'].includes(url.pathname)) {
      return `${parseAzureEndpoint(url.origin).endpoint}/openai/v1/responses`;
    }
  } catch {
    // Both malformed URLs and unsupported Azure hosts use the same validation message.
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter the HTTPS Foundry resource address or its /openai/v1/responses endpoint, without a key or query in the URL.' });
  return z.NEVER;
});
export const scriptSettingsSchema = z.object({
  deployment: scriptDeploymentSchema,
  foundry: z.object({
    endpoint: foundryResponsesEndpointSchema,
    apiKey: z.string().trim().max(512).regex(/^[A-Za-z0-9+/_=-]*$/, 'Enter an Azure API key without spaces.').optional(),
  }).strict().optional(),
}).strict();
export type ScriptDeploymentSettings = {
  deployment: string; source: 'saved' | 'environment' | 'none'; secureStorageAvailable: boolean;
  foundry?: { endpoint: string };
};
export type ScriptLocaleOption = { value: string; label: string };
export const scriptBriefImprovementSchema = z.object({
  prompt: briefSchema,
  style: z.string().trim().max(MAX_SCRIPT_STYLE_LENGTH),
  speakers: speakerCountSchema,
  consent: z.literal(true),
}).strict();
export const scriptBriefSuggestionSchema = z.object({ suggestion: briefSchema }).strict();
export type ScriptBriefSuggestion = z.infer<typeof scriptBriefSuggestionSchema>;

function uniqueLocales(locales: string[]): boolean {
  return new Set(locales.map(locale => locale.toLowerCase())).size === locales.length;
}

export function scriptBriefFormat(brief: string): { speakers?: 1 | 2; utteranceCount?: number; error?: string } {
  const speakers = new Set<number>();
  const utterances = new Set<number>();
  const count = (token: string) => /^one$/i.test(token) ? 1 : /^two$/i.test(token) ? 2 : Number(token);
  for (const raw of brief.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '').trim();
    const speakerLabel = /^(?:number of speakers|speaker count|speakers?)\s*:\s*(\d+|one|two)(?:\s+speakers?)?[.!]?\s*$/i.exec(line);
    if (speakerLabel) speakers.add(count(speakerLabel[1]));
    for (const match of line.matchAll(/(?:^|[.!?:;]\s+)(?:use|write|generate|create|return)\s+(?:exactly\s+)?(?:(?:a|an)\s+)?(\d+|one|two)(?:[- ]speakers?\s+(?:dialogue|script|conversation)\b|\s+speakers?(?=\s*(?:[.,;:!?]|$)))/gi))
      speakers.add(count(match[1]));

    const utteranceLabel = /^(?:number of utterances|utterance count|utterances(?: per locale)?|total utterances)\s*:\s*(\d+)[.!]?\s*$/i.exec(line);
    if (utteranceLabel) utterances.add(Number(utteranceLabel[1]));
    for (const match of line.matchAll(/(?:^|[.!?:;]\s+)(?:write|generate|create|return|produce)\s+(?:exactly\s+)?(\d+)\s+(?:utterances?|turns?)(?:\s+(?:total|in total|per locale))?(?=\s*(?:[.;:!?]|$))/gi))
      utterances.add(Number(match[1]));
    const total = /\b(\d+)\s+utterances?\s+(?:in\s+)?total[.!]?\s*$/i.exec(line);
    if (total && !/\b(?:at least|at most|up to|no more than)\b/i.test(line)) utterances.add(Number(total[1]));
  }
  if (speakers.size > 1 || utterances.size > 1)
    return { error: 'The content brief specifies conflicting counts. Give one speaker count and one utterance total per locale.' };
  const speaker = [...speakers][0];
  const utteranceCount = [...utterances][0];
  if (speaker !== undefined && speaker !== 1 && speaker !== 2)
    return { error: 'The content brief must request 1 or 2 speakers.' };
  if (utteranceCount !== undefined && (utteranceCount < 1 || utteranceCount > MAX_SCRIPT_UTTERANCES))
    return { error: `The content brief must request between 1 and ${MAX_SCRIPT_UTTERANCES} utterances per locale.` };
  return { speakers: speaker, utteranceCount };
}

export const scriptGenerationSchema = z.object({
  locales: z.array(localeSchema).min(1, 'Select at least one language / accent.')
    .refine(uniqueLocales, 'Locales must be unique.'),
  style: styleSchema,
  speakers: speakerCountSchema,
  utteranceCount: z.number().int().min(1).max(MAX_SCRIPT_UTTERANCES),
  prompt: briefSchema,
  expressionTags: z.boolean().optional(),
  expressionTagLists: expressionTagListsSchema.optional(),
  consent: z.literal(true),
}).strict().transform((value, ctx) => {
  const format = scriptBriefFormat(value.prompt);
  if (format.error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: format.error });
    return z.NEVER;
  }
  const speakers = format.speakers ?? value.speakers;
  const utteranceCount = format.utteranceCount ?? value.utteranceCount;
  if (utteranceCount < speakers) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['utteranceCount'], message: 'Provide at least one utterance per speaker.' });
    return z.NEVER;
  }
  return { ...value, speakers, utteranceCount };
});
export type ScriptGenerationRequest = z.infer<typeof scriptGenerationSchema>;

const utteranceSchema = z.object({
  speaker: speakerCountSchema,
  text: z.string().trim().min(1).max(500).refine(
    text => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text), 'An utterance must be a single line without tabs.',
  ),
}).strict();
export const scriptUtterancesSchema = z.array(utteranceSchema).min(1).max(MAX_SCRIPT_UTTERANCES);
const scriptSchema = z.object({ locale: localeSchema, utterances: scriptUtterancesSchema }).strict();
export type GeneratedScript = z.infer<typeof scriptSchema>;
export const SCRIPT_PROGRESS_CONTENT_TYPE = 'application/x-ndjson';
export const scriptLocaleResultSchema = z.union([
  z.object({ script: scriptSchema }).strict(),
  z.object({ locale: localeSchema, error: z.string(), retryAfterMs: z.number().int().min(0).max(2_147_483_647).optional() }).strict(),
]);
export const scriptGenerationResultSchema = z.array(scriptLocaleResultSchema);
export type ScriptGenerationResult = z.infer<typeof scriptGenerationResultSchema>;
export type ScriptGenerationRun = {
  id: string;
  input: ScriptGenerationRequest;
  state: 'running' | 'pausing' | 'stopping' | 'cancelling' | 'paused' | 'cancelled' | 'completed' | 'failed';
  results: ScriptGenerationResult;
  activeLocales: string[];
  firstLocale?: string;
  retryAt?: number;
  error?: string;
  regeneration?: { locale: string; state: 'running' | 'done' | 'error'; message: string };
};
export type ScriptGenerationStatus = {
  run?: ScriptGenerationRun;
  textBusy: boolean;
  textRequest?: { id: string; kind: 'improve-brief' | 'generate' | 'script-tags' | 'recording-script'; cancelling: boolean };
};

export const scriptExportSchema = z.object({
  directory: z.string().trim().min(1, 'Enter a destination folder.').max(2048),
  style: styleSchema,
  speakers: speakerCountSchema,
  scripts: z.array(scriptSchema).min(1).max(SCRIPT_EXPORT_BATCH_SIZE)
    .refine(scripts => uniqueLocales(scripts.map(script => script.locale)), 'Locales must be unique.'),
}).strict().refine(value => value.scripts.every(script => hasScriptSpeakers(script.utterances, value.speakers)),
  'Every script must use exactly the requested speakers.');
export type ScriptExportResult = { file: string; path?: string; error?: string }[];

export function hasScriptSpeakers(utterances: z.infer<typeof scriptUtterancesSchema>, speakers: 1 | 2): boolean {
  const seen = new Set(utterances.map(utterance => utterance.speaker));
  return seen.has(1) && seen.has(2) === (speakers === 2);
}

export function scriptFileName(locale: string, style: string): string {
  // Azure Voices Studio accepts script names of up to 80 characters, excluding the extension.
  const suffix = style.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+/, '')
    .slice(0, 79 - locale.length).replace(/[\uD800-\uDBFF]$/u, '').replace(/_+$/, '');
  return `${locale}_${suffix || 'script'}.txt`;
}

export function scriptFileText(script: GeneratedScript, speakers: 1 | 2): string {
  return script.utterances.map(({ speaker, text }, index) => {
    const number = String(index + 1).padStart(5, '0');
    return `${script.locale}_${number}${speakers === 2 ? `_S${speaker}` : ''}\t${text}\r\n`;
  }).join('');
}
