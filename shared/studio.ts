import { z } from 'zod';

export type StudioSpeechStatus = {
  region: string; endpoint: string; configured: boolean; source: 'saved' | 'environment' | 'none'; defaultOutput: string;
};
export const studioLocaleCodeSchema = z.string().max(40).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/);
export const studioVoiceSchema = z.object({
  ShortName: z.string().min(1).max(200),
  DisplayName: z.string().max(200),
  Locale: studioLocaleCodeSchema,
  LocaleName: z.string().max(200).optional(),
  Gender: z.string().trim().min(1).max(40),
  VoiceType: z.string().max(100).optional(),
  StyleList: z.array(z.string().max(100)).optional(),
  Status: z.string().max(100).optional(),
  SecondaryLocaleList: z.array(studioLocaleCodeSchema).default([]),
});
export type StudioVoice = z.infer<typeof studioVoiceSchema>;
export const MAX_STUDIO_VOICES = 100;
export const STUDIO_SYNTHESIS_BATCH_SIZE = 200;
export const studioClipSchema = z.object({
  name: z.string().min(1).max(100), text: z.string().min(1).max(3000),
  line: z.number().int().positive(), source: z.enum(['tab', 'auto']),
});
export const studioScriptSchema = z.object({
  name: z.string().min(1).max(80), clips: z.array(studioClipSchema).min(1).max(500),
  locale: z.string().max(40).default(''),
});
export type StudioScript = z.infer<typeof studioScriptSchema>;
export const studioPlanRequestSchema = z.object({
  scripts: z.array(studioScriptSchema).min(1).max(50),
  localeFromFilename: z.boolean().optional(),
  voices: z.array(z.string().min(1).max(200)).min(1).max(MAX_STUDIO_VOICES),
  outputParent: z.string().min(1), runName: z.string().min(1).max(80).optional(),
  useExisting: z.boolean(), rate: z.number().int().min(-50).max(50),
  pitch: z.number().int().min(-50).max(50), concurrency: z.number().int().min(1).max(16),
}).strict();
export type StudioPlanRequest = z.infer<typeof studioPlanRequestSchema>;
export type StudioCell = {
  id: string; script: string; clip: string; line: number; text: string; voice: StudioVoice;
  locale: string; path: string; status: 'queued' | 'synthesizing' | 'done' | 'skipped' | 'failed';
  error?: string;
  languageFallback?: { reason: 'no-filename-locale' } | { reason: 'unsupported-locale'; requestedLocale: string };
};
export type StudioPlan = {
  token: string; expiresAt: string; output: string; byLocale: string;
  calls: number; characters: number; cells: StudioCell[]; warnings: string[];
};
export type StudioRun = {
  id: string; status: 'running' | 'pausing' | 'paused' | 'completed' | 'cancelled' | 'failed';
  startedAt: string; finishedAt?: string; output: string; byLocale: string;
  cells: StudioCell[]; error?: string; reportPath?: string; missingAudioIds?: string[];
};

export function validStudioName(name: string, max: number): boolean {
  return !!name && name.length <= max && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    && /^[\p{L}\p{N}_. -]+$/u.test(name);
}
