import { z } from 'zod';
import { type VoiceDescriptors } from './voiceDescriptors.js';
import { voiceDescriptorRows } from './voiceDescriptorResults.js';
import { activeDimensions, dimensionLabel, summarize, profileSchema, settingsSchema, type Dimension, type Job, type VoiceGender, type VoiceLabel } from './domain.js';
import type { BatchTest } from './batch.js';
import { studioVoiceModel } from './studioVoices.js';
import { testNameMetadata } from './history.js';

export type ArenaMetadata = { domain: string; locale: string; scripts: string[] };
export type ArenaTest = BatchTest & { arena: ArenaMetadata; voiceLabels?: VoiceLabel[] };
export type ArenaPreview = { directory: string; token: string; ignoredFiles: number; tests: ArenaTest[] };
const localPath = z.string().trim().transform(value => value.replace(/^"(.*)"$/, '$1')).pipe(z.string().trim().min(1));
const scriptDirectorySource = z.object({ scriptsDirectory: localPath }).strict();
const scriptPathsSource = z.object({ scriptPaths: z.array(localPath).min(1) }).strict();
export type ArenaScriptSource = z.infer<typeof scriptDirectorySource> | z.infer<typeof scriptPathsSource>;
const directoryImport = z.object({ directory: localPath, layout: z.enum(['voices', 'tests']) });
const directoriesImport = z.object({ directories: z.array(localPath).min(1), layout: z.literal('tests') });
export const arenaImportSchema = z.union([
  directoryImport.merge(scriptDirectorySource),
  directoryImport.merge(scriptPathsSource),
  directoriesImport.merge(scriptDirectorySource),
  directoriesImport.merge(scriptPathsSource),
]);
const arenaUpload = z.object({
  files: z.array(z.object({
    id: z.string().uuid(), path: z.string().min(1).max(500), voice: z.string().trim().min(1).max(200),
    size: z.number().int().positive().max(100 * 1024 * 1024),
  }).strict()).min(1),
});
export const arenaUploadSchema = z.union([
  arenaUpload.merge(scriptDirectorySource),
  arenaUpload.merge(scriptPathsSource),
]);
export const arenaReferenceSchema = z.object({ token: z.string().uuid(), testName: z.string().min(1) }).strict();
export type ArenaReference = z.infer<typeof arenaReferenceSchema>;
export const arenaSettingsSchema = z.object({
  judges: settingsSchema.innerType().shape.judges,
  profile: profileSchema.optional(),
}).superRefine((value, ctx) => {
  if (!settingsSchema.safeParse(value).success) ctx.addIssue({ code: 'custom', message: 'Arena judge IDs must be unique.' });
  if (value.profile && (value.profile.stage !== 'tts' || value.profile.scope !== 'single'))
    ctx.addIssue({ code: 'custom', message: 'Arena requires TTS single-speaker evaluation.' });
});
export type ArenaSettings = z.infer<typeof arenaSettingsSchema>;

export function arenaScript(name: string): ArenaMetadata {
  const stem = name.replace(/\.txt$/i, '');
  const match = /^([a-z]{2,3}(?:-[a-z]{4})?-(?:[a-z]{2}|\d{3}))_(.+)$/i.exec(stem);
  if (!match) throw new Error(`Script "${name}" must be named <locale>_<domain>.txt, for example en-US_Customer_Services.txt.`);
  const locale = Intl.getCanonicalLocales(match[1])[0];
  const domain = match[2].trim().replace(/[\s_]+/g, '_').toLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(domain)) throw new Error(`Invalid script domain in "${name}".`);
  return { locale, domain, scripts: [stem] };
}

export type ArenaCell = {
  voice: string; model: string; domain: string; locale: string; score: number; gender: VoiceGender;
  jobId: string; createdAt: string; files: number; panel: string; rubric: string; comparison: string;
  dimensionScores?: { dimension: Dimension; label: string; score: number | null }[];
  voiceDescriptors?: VoiceDescriptors;
};
export type ArenaFilterVoice = { voice: string; model: string; gender: VoiceGender };
export type ArenaReport = {
  id: string; name: string; createdAt: string; status: Job['status']; arena: ArenaMetadata;
  voices: number; eligibleVoices: number;
  filterVoices?: ArenaFilterVoice[];
};
export type ArenaData = { cells: ArenaCell[]; reports: ArenaReport[] };

export function arenaData(jobs: Job[]): ArenaData {
  const cells = new Map<string, ArenaCell>();
  const reports: ArenaReport[] = [];
  for (const job of [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
    if (!job.arena) continue;
    const summaries = summarize(job);
    const eligible = summaries.filter(row => job.status === 'completed' && row.score !== null && row.eligibleFiles === row.files);
    const descriptors = new Map(voiceDescriptorRows(job).map(row => [row.voice, row.labels]));
    const genders = testNameMetadata(job.name ?? '').genders;
    const voiceDetails = (voice: string): ArenaFilterVoice => ({
      voice, model: studioVoiceModel({ ShortName: voice }),
      gender: job.voiceLabels?.find(label => label.voice === voice)?.gender ??
        (genders.length === 1 ? genders[0] : 'Unspecified'),
    });
    reports.push({
      id: job.id, name: job.name ?? 'Arena test', createdAt: job.createdAt, status: job.status, arena: job.arena,
      voices: summaries.length, eligibleVoices: eligible.length,
      filterVoices: [...new Set(job.clips.map(clip => clip.voice))].map(voiceDetails),
    });
    for (const row of eligible) {
      const { domain, locale } = job.arena;
      const voice = row.voice;
      const key = JSON.stringify([domain, locale, voice]);
      if (cells.has(key)) continue;
      const panel = job.judges.map(judge => judge.deployment).sort().join(', ');
      const rubric = job.profile.rubric?.name ?? job.rubric;
      cells.set(key, {
        ...voiceDetails(voice),
        domain, locale, score: row.score!, jobId: job.id, createdAt: job.createdAt, files: row.files, panel, rubric,
        dimensionScores: activeDimensions(job.profile).map(dimension => ({
          dimension, label: dimensionLabel(job.profile, dimension), score: row.dimensions[dimension],
        })),
        voiceDescriptors: descriptors.get(voice),
        comparison: JSON.stringify([panel, job.profile.rubric ?? job.rubric, job.profile.target]),
      });
    }
  }
  return { cells: [...cells.values()], reports };
}
