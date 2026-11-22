import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import { z } from 'zod';
import { protectKey } from './credentials.js';
import { Store } from './store.js';
import { decodeStudioText, parseStudioScript } from './studioScripts.js';
import { localScriptPaths } from './scriptSourcePaths.js';
import { realDirectory } from './localDirectory.js';
import { STUDIO_SYNTHESIS_BATCH_SIZE, studioClipSchema, studioLocaleCodeSchema, studioPlanRequestSchema, studioVoiceSchema, validStudioName, type StudioCell, type StudioPlan, type StudioPlanRequest, type StudioRun, type StudioVoice } from '../shared/studio.js';
import { studioVoiceLocales } from '../shared/studioVoices.js';
import { studioExpressionMarkup, studioSsml } from '../shared/studioSsml.js';

export { studioSsml };

type SpeechCredentials = { region: string; endpoint: string; key: string };
const speechConnectionSchema = z.object({
  region: z.string().trim().regex(/^[a-z0-9-]{2,40}$/),
  endpoint: z.string().trim().max(300).default(''),
  apiKey: z.string().trim().max(512).regex(/^[A-Za-z0-9+/_=-]*$/).default(''),
}).strict();
const storedSchema = z.object({ region: z.string(), endpoint: z.string(), protectedKey: z.string() }).strict();
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unexpected synthesis error.';
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const windowsVoiceName = (name: string) => name.replace(/[%<>:"/\\|?*\x00-\x1f]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const studioOutputGroup = (locale: string, voice: StudioVoice) =>
  `${locale || 'Auto'} ${/^female$/i.test(voice.Gender) ? 'Female' : /^male$/i.test(voice.Gender) ? 'Male' : 'Unspecified'}`;
const settingsSchema = studioPlanRequestSchema.pick({ rate: true, pitch: true, concurrency: true }).extend({
  format: z.literal('riff-24khz-16bit-mono-pcm'),
});
type RunSettings = z.infer<typeof settingsSchema>;
const savedRunSchema = z.object({
  id: z.string().uuid(), status: z.enum(['running', 'pausing', 'paused', 'completed', 'cancelled', 'failed']),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(), output: z.string(), byLocale: z.string(),
  error: z.string().optional(), settings: settingsSchema,
  cells: z.array(studioClipSchema.omit({ name: true, source: true }).extend({
    id: z.string().uuid(), script: z.string().max(80), clip: z.string().refine(value => validStudioName(value, 100)),
    voice: studioVoiceSchema, locale: z.union([z.literal(''), studioLocaleCodeSchema]), path: z.string().max(240),
    status: z.enum(['queued', 'synthesizing', 'done', 'skipped', 'failed']), error: z.string().optional(),
    languageFallback: z.discriminatedUnion('reason', [
      z.object({ reason: z.literal('no-filename-locale') }),
      z.object({ reason: z.literal('unsupported-locale'), requestedLocale: studioLocaleCodeSchema }),
    ]).optional(),
  })).min(1),
});

function speechBase(credentials: SpeechCredentials): string {
  if (!credentials.endpoint) return `https://${credentials.region}.tts.speech.microsoft.com`;
  let url: URL;
  try { url = new URL(credentials.endpoint); } catch { throw new Error('Enter a valid Azure Speech resource endpoint.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(url.hostname) ||
      url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error('The custom endpoint must be an HTTPS Azure cognitiveservices.azure.com resource root.');
  return `${url.origin}/tts`;
}

async function existingFingerprint(file: string): Promise<string | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Output is not a regular file: ${file}`);
    if (stat.size > 100 * 1024 * 1024) throw new Error(`Output exceeds Voice Scoring's 100 MB file limit: ${file}`);
    const bytes = await readFile(file);
    validateWav(bytes);
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function validateWav(bytes: Buffer): void {
  if (bytes.length < 45 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Audio is not a complete WAV file.');
  let format = false, data = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('Audio contains an incomplete WAV chunk.');
    if (id === 'fmt ' && size >= 16) format = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 &&
      bytes.readUInt32LE(start + 4) === 24000 && bytes.readUInt16LE(start + 14) === 16;
    if (id === 'data' && size > 0) data = true;
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error('Audio must contain nonempty 24 kHz, 16-bit mono PCM.');
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  try { await mkdir(target); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await realDirectory(target);
  return target;
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export class AzureVoicesStudio {
  private saved?: SpeechCredentials;
  private catalog: StudioVoice[] = [];
  private catalogTime = 0;
  private connectionGeneration = 0;
  private catalogGeneration = 0;
  private plans = new Map<string, { plan: StudioPlan; request: StudioPlanRequest; credentials: SpeechCredentials; fingerprints: Map<string, string> }>();
  private runs = new Map<string, StudioRun>();
  private runSettings = new Map<string, RunSettings>();
  private cancelled = new Set<string>();
  private executing = new Set<string>();
  private finalizing = new Set<string>();
  private starting = false;
  constructor(private store: Store, private fetcher: typeof fetch = fetch) {}

  async load() {
    if (await this.store.exists('speech-connection.json')) {
      const saved = storedSchema.parse(await this.store.read('speech-connection.json'));
      const credentials = { region: saved.region, endpoint: saved.endpoint, key: await protectKey(saved.protectedKey, 'unprotect') };
      speechBase(credentials);
      this.saved = credentials;
      this.invalidateConnection();
    }
  }
  private invalidateConnection() {
    this.connectionGeneration++;
    this.catalogGeneration++;
    this.catalog = []; this.catalogTime = 0; this.plans.clear();
  }
  private checkConnectionGeneration(generation: number) {
    if (this.connectionGeneration !== generation) throw new Error('Speech connection changed while loading voices. Refresh the voice list.');
  }
  private current(): SpeechCredentials {
    const value = this.saved ?? { region: process.env.AZURE_SPEECH_REGION ?? '', endpoint: process.env.AZURE_SPEECH_ENDPOINT ?? '', key: process.env.AZURE_SPEECH_KEY ?? '' };
    if (!value.region || !value.key) throw new Error('Configure an Azure Speech region and key first.');
    speechConnectionSchema.parse({ region: value.region, endpoint: value.endpoint, apiKey: value.key });
    speechBase(value);
    return { ...value };
  }
  verificationCredentials(): SpeechCredentials {
    return this.current();
  }
  status() {
    const env = { region: process.env.AZURE_SPEECH_REGION ?? '', endpoint: process.env.AZURE_SPEECH_ENDPOINT ?? '', key: process.env.AZURE_SPEECH_KEY ?? '' };
    const value = this.saved ?? env;
    return { region: value.region, endpoint: value.endpoint, configured: !!(value.region && value.key), source: this.saved ? 'saved' : value.key ? 'environment' : 'none', defaultOutput: path.join(os.homedir(), 'Music', 'Azure Voices') };
  }
  async save(input: unknown) {
    const value = speechConnectionSchema.parse(input);
    const old = this.saved ?? { region: process.env.AZURE_SPEECH_REGION ?? '', endpoint: process.env.AZURE_SPEECH_ENDPOINT ?? '', key: process.env.AZURE_SPEECH_KEY ?? '' };
    const key = value.apiKey || ((value.region === old.region && value.endpoint === old.endpoint) ? old.key : '');
    if (!key) throw new Error('Enter a Speech key when configuring a new resource.');
    const next = { region: value.region, endpoint: value.endpoint, key };
    speechBase(next);
    const protectedKey = await protectKey(key, 'protect');
    await this.store.save('speech-connection.json', { region: next.region, endpoint: next.endpoint, protectedKey });
    this.saved = next;
    this.invalidateConnection();
    return this.status();
  }
  async clear() {
    if (await this.store.exists('speech-connection.json')) await this.store.remove('speech-connection.json');
    this.saved = undefined;
    this.invalidateConnection();
    return this.status();
  }
  async voices(refresh = false): Promise<StudioVoice[]> {
    if (!refresh && this.catalog.length && Date.now() - this.catalogTime < 24 * 3600_000) return this.catalog;
    const connection = this.current();
    const generation = this.connectionGeneration;
    let response: Response;
    try { response = await this.fetcher(`${speechBase(connection)}/cognitiveservices/voices/list`, {
      headers: { 'Ocp-Apim-Subscription-Key': connection.key }, signal: AbortSignal.timeout(30000), redirect: 'error',
    }); } catch {
      this.checkConnectionGeneration(generation);
      throw new Error('Could not reach Azure Speech. Check the region, endpoint and network.');
    }
    this.checkConnectionGeneration(generation);
    if (!response.ok) throw new Error(`Azure Speech voice list failed (HTTP ${response.status}). Check the key, region and resource permissions.`);
    const body: unknown = await response.json();
    this.checkConnectionGeneration(generation);
    const parsed = z.array(studioVoiceSchema).refine(items =>
      new Set(items.map(item => item.ShortName.toLowerCase())).size === items.length, 'Azure returned duplicate voice ShortNames.').parse(body);
    this.catalog = parsed;
    this.catalogTime = Date.now();
    this.catalogGeneration++;
    this.plans.clear();
    return this.catalog;
  }
  async readPaths(paths: string[]) {
    const results: { name: string; script?: ReturnType<typeof parseStudioScript>['script']; warnings?: string[]; error?: string }[] = [];
    for await (const entry of localScriptPaths(paths)) {
      if (entry.error) { results.push(entry); continue; }
      try {
        results.push({ name: entry.name, ...parseStudioScript(path.basename(entry.name), decodeStudioText(await readFile(entry.name))) });
      } catch (error) { results.push({ name: entry.name, error: errorText(error) }); }
    }
    return results;
  }
  async plan(input: unknown): Promise<StudioPlan> {
    const request = studioPlanRequestSchema.parse(input);
    for (const [token, saved] of this.plans) if (Date.parse(saved.plan.expiresAt) <= Date.now()) this.plans.delete(token);
    while (this.plans.size >= 20) {
      const oldest = this.plans.keys().next().value;
      if (oldest) this.plans.delete(oldest);
    }
    const generation = this.catalogGeneration;
    const credentials = this.current();
    if (!this.catalog.length || Date.now() - this.catalogTime >= 24 * 3600_000) throw new Error('Load the current voice catalog before previewing.');
    if (request.runName !== undefined && !validStudioName(request.runName, 80)) throw new Error('Invalid run name. Use a valid Windows folder name.');
    const parent = await realDirectory(request.outputParent);
    await access(parent, constants.W_OK);
    const output = request.runName ? path.join(parent, request.runName) : parent;
    let exists = !request.runName;
    if (request.runName) {
      try { await realDirectory(output); exists = true; } catch (error) { if (!missing(error)) throw error; }
      if (exists && !request.useExisting) throw new Error('This run folder already exists. Choose another name or explicitly select reuse.');
      if (!exists && request.useExisting) throw new Error('The selected existing run folder does not exist.');
    }
    if (request.runName && exists) for (const name of ['run.json', 'manifest.csv']) {
      try {
        const stat = await lstat(path.join(output, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Existing ${name} must be a regular file, not a link or directory.`);
      } catch (error) { if (!missing(error)) throw error; }
    }
    const voices = request.voices.map(name => {
      const voice = this.catalog.find(item => item.ShortName === name);
      if (!voice) throw new Error(`Voice is no longer in the current catalog: ${name}`);
      return voice;
    });
    if (new Set(request.voices).size !== voices.length) throw new Error('Selected voices must be unique.');
    const catalogLocales = request.localeFromFilename
      ? [...new Set(this.catalog.flatMap(studioVoiceLocales))].sort((a, b) => b.length - a.length) : [];
    const voiceLocales = new Map(voices.map(voice => [voice.ShortName, new Set(studioVoiceLocales(voice).map(locale => locale.toLowerCase()))]));
    const scriptLocales = new Map<string, string>();
    const scriptNames = new Set<string>(), clipNames = new Set<string>();
    for (const script of request.scripts) {
      if (!validStudioName(script.name, 80)) throw new Error(`Invalid script name: ${script.name}`);
      if (scriptNames.has(script.name.toLowerCase())) throw new Error(`Duplicate script name: ${script.name}`);
      scriptNames.add(script.name.toLowerCase());
      if (request.localeFromFilename) {
        const name = script.name.toLowerCase();
        const detected = catalogLocales.find(locale => {
          const prefix = locale.toLowerCase();
          return name === prefix || (name.startsWith(prefix) && /^[_ .-]/.test(name.slice(prefix.length)));
        });
        scriptLocales.set(script.name, detected ?? '');
      } else {
        if (script.locale && !localePattern.test(script.locale)) throw new Error(`Invalid language for ${script.name}.`);
        for (const voice of voices) if (script.locale && !voiceLocales.get(voice.ShortName)?.has(script.locale.toLowerCase()))
          throw new Error(`${voice.ShortName} does not list ${script.locale} as a supported locale.`);
        scriptLocales.set(script.name, script.locale ? Intl.getCanonicalLocales(script.locale)[0] : '');
      }
      for (const clip of script.clips) {
        if (!validStudioName(clip.name, 100)) throw new Error(`Invalid clip name: ${clip.name}`);
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(clip.text)) throw new Error(`Clip ${clip.name} contains characters not supported in SSML.`);
        if (clipNames.has(clip.name.toLowerCase())) throw new Error(`Duplicate clip name across scripts: ${clip.name}`);
        clipNames.add(clip.name.toLowerCase());
      }
    }
    const byLocale = request.runName ? path.join(output, 'by-locale') : output;
    const cells: StudioCell[] = [];
    const fingerprints = new Map<string, string>();
    const destinations = new Set<string>();
    for (const script of request.scripts) for (const clip of script.clips) for (const voice of voices) {
      const requestedLocale = scriptLocales.get(script.name) ?? '';
      const languageFallback: StudioCell['languageFallback'] = !request.localeFromFilename ? undefined
        : !requestedLocale ? { reason: 'no-filename-locale' }
          : !voiceLocales.get(voice.ShortName)?.has(requestedLocale.toLowerCase())
            ? { reason: 'unsupported-locale', requestedLocale } : undefined;
      const locale = languageFallback ? '' : requestedLocale;
      const folder = studioOutputGroup(locale, voice);
      const voiceFolder = windowsVoiceName(voice.ShortName);
      if (!voiceFolder || /[. ]$/.test(voiceFolder) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(voiceFolder)) throw new Error(`Voice has an invalid folder name: ${voice.ShortName}`);
      const file = path.join(byLocale, folder, voiceFolder, `${clip.name}.wav`);
      if (file.length > 240) throw new Error(`Output path exceeds 240 characters: ${file}`);
      if (destinations.has(file.toLowerCase())) throw new Error(`Output paths collide: ${file}`);
      destinations.add(file.toLowerCase());
      if (exists) {
        for (const dir of [byLocale, path.join(byLocale, folder), path.join(byLocale, folder, voiceFolder)]) {
          try { await realDirectory(dir); } catch (error) { if (!missing(error)) throw error; }
        }
      }
      const fingerprint = exists ? await existingFingerprint(file) : undefined;
      if (fingerprint && !request.useExisting) throw new Error(`An output WAV already exists: ${file}. Choose a different output folder.`);
      const id = randomUUID();
      if (fingerprint) fingerprints.set(id, fingerprint);
      cells.push({ id, script: script.name, clip: clip.name, line: clip.line, text: clip.text, voice, locale, path: file, status: fingerprint ? 'skipped' : 'queued', ...(languageFallback && { languageFallback }) });
    }
    const pending = cells.filter(cell => cell.status === 'queued');
    const warnings = ['Text units count UTF-16 code units and exclude SSML markup and retries; Azure may bill more than this preview.'];
    const unlistedStyles = new Set<string>();
    const soundTags = new Set<string>();
    let characters = 0;
    for (const cell of pending) {
      const expression = studioExpressionMarkup(cell.voice, cell.text);
      characters += expression.spokenText.length;
      for (const tag of expression.unlistedStyles) unlistedStyles.add(tag);
      for (const tag of expression.soundTags) soundTags.add(tag);
    }
    if (unlistedStyles.size)
      warnings.push(`Style tags not advertised by one or more selected voices are still included in SSML; Azure may ignore unsupported styles: ${[...unlistedStyles].join(', ')}.`);
    if (soundTags.size)
      warnings.push(`Sound tags are removed from speech but do not generate sound effects: ${[...soundTags].join(', ')}.`);
    const fallbackCount = cells.filter(cell => cell.languageFallback).length;
    if (fallbackCount) warnings.push(`${fallbackCount} clip/voice pairs have no SSML language tag because the filename locale was missing or unsupported. See the Language column for each reason.`);
    if (cells.some(cell => !cell.locale)) warnings.push('Auto relies on the selected voice to interpret the language; single-language voices generally use their primary locale. Azure does not return the detected language, so Auto folders have no language metadata for Voice Scoring.');
    if ((request.rate || request.pitch) && voices.some(voice => /DragonHD/i.test(voice.ShortName))) warnings.push('Dragon HD models support only a subset of SSML; custom rate or pitch may not be supported by every selected voice.');
    if (pending.length) warnings.push('Atomic output requires a filesystem that supports hard links. If saving fails after Azure returns audio, the request may still be billed.');
    if (cells.some(cell => cell.status === 'skipped')) warnings.push('Existing WAV files are skipped by path and format only; their text and settings are not verified.');
    if (request.runName && request.useExisting) warnings.push('Reusing the run folder replaces its run.json and manifest.csv with the new run report.');
    if (/onedrive/i.test(parent)) warnings.push('The output directory appears to be in OneDrive; sync can slow or lock file writes.');
    if (characters > 100_000) warnings.push('This run exceeds 100,000 characters and may incur significant charges.');
    if (this.catalogGeneration !== generation) throw new Error('The voice catalog or connection changed while preparing the preview. Preview again.');
    const plan: StudioPlan = { token: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString(), output, byLocale, calls: pending.length, characters, cells, warnings };
    this.plans.set(plan.token, { plan: structuredClone(plan), request, credentials, fingerprints });
    return plan;
  }
  async start(token: string, consent: boolean): Promise<StudioRun> {
    if (!consent) throw new Error('Explicit confirmation of Azure charges is required.');
    this.requireIdle();
    const saved = this.plans.get(token);
    if (!saved || Date.parse(saved.plan.expiresAt) <= Date.now()) throw new Error('Preview expired. Preview the run again.');
    this.plans.delete(token);
    this.starting = true;
    try {
    const { plan, request, credentials, fingerprints } = saved;
    await realDirectory(request.outputParent);
    if (!request.runName || request.useExisting) {
      await realDirectory(plan.output);
      for (const cell of plan.cells) {
        for (const dir of [plan.byLocale, path.dirname(path.dirname(cell.path)), path.dirname(cell.path)]) {
          try { await realDirectory(dir); } catch (error) { if (!missing(error)) throw error; }
        }
        if (await existingFingerprint(cell.path) !== fingerprints.get(cell.id)) throw new Error('Output files changed after preview. Preview again before starting.');
      }
    } else {
      try { await mkdir(plan.output); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('The output folder appeared after preview. Preview again.');
        throw error;
      }
    }
    const id = randomUUID();
    const reportPath = path.join(plan.output, request.runName ? 'run.json' : `run-${id}.json`);
    const settings = { rate: request.rate, pitch: request.pitch, concurrency: request.concurrency, format: 'riff-24khz-16bit-mono-pcm' } as const;
    const run: StudioRun = { id, status: 'running', startedAt: new Date().toISOString(), output: plan.output, byLocale: plan.byLocale, cells: structuredClone(plan.cells), reportPath };
    this.runs.set(run.id, run);
    try { await this.persist(run, settings); } catch (error) { this.runs.delete(run.id); throw error; }
    this.runSettings.set(run.id, settings);
    void this.execute(run, settings, credentials);
    return run;
    } finally { this.starting = false; }
  }
  private requireIdle() {
    if (this.starting || this.executing.size) throw new Error('A synthesis run is already starting, running or pausing.');
  }
  pause(id: string) {
    const run = this.getRun(id);
    if (run.status === 'running' && !this.finalizing.has(id)) run.status = 'pausing';
    return run;
  }
  async resume(id: string, consent: boolean) {
    if (!consent) throw new Error('Explicit confirmation of Azure charges is required.');
    this.requireIdle();
    const run = this.getRun(id);
    const settings = this.runSettings.get(id);
    if (!settings || !['paused', 'cancelled', 'failed'].includes(run.status) || !run.cells.some(cell => cell.status === 'queued'))
      throw new Error('This run has no resumable clips.');
    this.starting = true;
    try {
      const credentials = this.current();
      const next = { ...run, status: 'running' as const, finishedAt: undefined, error: undefined };
      await this.persist(next, settings);
      Object.assign(run, next);
      void this.execute(run, settings, credentials);
      return run;
    } finally { this.starting = false; }
  }
  async reopen(file: string): Promise<StudioRun> {
    this.requireIdle();
    this.starting = true;
    try {
      if (!path.isAbsolute(file)) throw new Error('Enter the absolute path to the saved Studio run JSON.');
      const reportPath = path.resolve(file);
      const output = await realDirectory(path.dirname(reportPath));
      const filename = path.basename(reportPath);
      if (!/^run(?:-[\da-f-]{36})?\.json$/i.test(filename)) throw new Error('Select a Studio run.json or run-<id>.json report.');
      const stat = await lstat(reportPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('Select a regular Studio run report no larger than 256 MB.');
      const { settings, ...data } = savedRunSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
      if (filename !== 'run.json' && filename !== `run-${data.id}.json`) throw new Error('The saved report filename does not match its run ID.');
      const byLocale = filename === 'run.json' ? path.join(output, 'by-locale') : output;
      if (data.output !== output || data.byLocale !== byLocale) throw new Error('Reopen the report from its original output folder.');
      if (this.runs.has(data.id)) return this.getRun(data.id);
      const paths = new Set<string>(), ids = new Set<string>(), checkedDirectories = new Set<string>();
      for (const cell of data.cells) {
        const group = path.basename(path.dirname(path.dirname(cell.path)));
        const baseGroup = studioOutputGroup(cell.locale, cell.voice);
        const voiceFolder = windowsVoiceName(cell.voice.ShortName);
        const part = group.startsWith(`${baseGroup} part `) ? group.slice(baseGroup.length + 6) : '';
        if ((group !== baseGroup && (!/^\d+$/.test(part) || Number(part) < 2)) ||
            !validStudioName(voiceFolder.replace(/%[\da-f]{2}/gi, '_'), 600) ||
            cell.path !== path.join(byLocale, group, voiceFolder, `${cell.clip}.wav`) ||
            paths.has(cell.path.toLowerCase()) || ids.has(cell.id)) throw new Error('The saved report contains an invalid or duplicate output path or clip ID.');
        paths.add(cell.path.toLowerCase()); ids.add(cell.id);
        for (const directory of [byLocale, path.join(byLocale, group), path.dirname(cell.path)]) {
          if (checkedDirectories.has(directory)) continue;
          try { await realDirectory(directory); } catch (error) { if (!missing(error)) throw error; }
          checkedDirectories.add(directory);
        }
        if (cell.status === 'synthesizing') cell.status = 'queued';
        if (cell.status === 'queued' && await existingFingerprint(cell.path)) cell.status = 'skipped';
      }
      const resumable = ['running', 'pausing', 'paused', 'cancelled', 'failed'].includes(data.status) && data.cells.some(cell => cell.status === 'queued');
      const run: StudioRun = { ...data, status: resumable ? 'paused' : ['running', 'pausing', 'paused'].includes(data.status) ? 'completed' : data.status, reportPath };
      this.runs.set(run.id, run);
      this.runSettings.set(run.id, settings);
      return run;
    } finally { this.starting = false; }
  }
  getRun(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error('Run not found in this server session.');
    return run;
  }
  async getRunView(id: string, checkAudio = false): Promise<StudioRun> {
    const run = this.getRun(id);
    if (!checkAudio && ['running', 'pausing'].includes(run.status)) return run;
    const saved = run.cells.filter(cell => cell.status === 'done' || cell.status === 'skipped');
    const missingAudioIds: string[] = [];
    for (let offset = 0; offset < saved.length; offset += 32) {
      const missingInBatch = await Promise.all(saved.slice(offset, offset + 32).map(async cell => {
        try {
          await lstat(cell.path);
          return undefined;
        } catch (error) {
          if (missing(error)) return cell.id;
          throw error;
        }
      }));
      for (const id of missingInBatch) if (id) missingAudioIds.push(id);
    }
    return { ...run, missingAudioIds };
  }
  listRuns() { return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  cancel(id: string) {
    const run = this.getRun(id);
    if (run.status === 'running' && !this.finalizing.has(id)) this.cancelled.add(id);
    return run;
  }
  private async persist(run: StudioRun, request: RunSettings) {
    await realDirectory(run.output);
    if (!run.reportPath) throw new Error('The run report path is missing.');
    const tmp = path.join(run.output, `run.${run.id}.tmp`);
    await writeFile(tmp, JSON.stringify({ ...run, settings: request }, null, 2), { mode: 0o600 });
    await rename(tmp, run.reportPath);
    const header = ['run_id', 'clip_name', 'script_name', 'line_no', 'text', 'locale', 'voice_short_name', 'gender', 'rate', 'pitch', 'characters', 'status', 'error', 'path_by_locale', 'language_fallback', 'requested_locale'];
    const rows = run.cells.map(cell => [run.id, cell.clip, cell.script, cell.line, cell.text, cell.locale || 'Auto', cell.voice.ShortName, cell.voice.Gender, request.rate, request.pitch, cell.text.length, cell.status, cell.error ?? '', cell.path,
      cell.languageFallback?.reason ?? '', cell.languageFallback?.reason === 'unsupported-locale' ? cell.languageFallback.requestedLocale : ''].map(csvCell).join(','));
    const manifest = path.join(run.output, `manifest.${run.id}.tmp`);
    await writeFile(manifest, [header.join(','), ...rows].join('\r\n'), { mode: 0o600 });
    await rename(manifest, path.join(run.output, path.basename(run.reportPath) === 'run.json' ? 'manifest.csv' : `manifest-${run.id}.csv`));
  }
  private async synthesize(cell: StudioCell, request: RunSettings, credentials: SpeechCredentials): Promise<Buffer> {
    for (let attempt = 0; attempt < 5; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${speechBase(credentials)}/cognitiveservices/v1`, {
          method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': credentials.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'AzureVoicesStudio' },
          body: studioSsml(cell.voice, cell.text, cell.locale, request.rate, request.pitch), signal: AbortSignal.timeout(120000), redirect: 'error',
        });
      } catch { throw new Error('Azure Speech request failed or timed out. The request may have been billed; check Azure before retrying.'); }
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        validateWav(bytes);
        return bytes;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const retryAfter = response.headers.get('retry-after');
        const requested = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
          : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - Date.now())
            : 2 ** attempt * 1000;
        if (requested > 30_000) throw new Error(`Azure Speech requested a retry after more than 30 seconds (HTTP ${response.status}). Retry this clip later.`);
        await delay(requested); continue;
      }
      throw new Error(`Azure Speech synthesis failed (HTTP ${response.status}).`);
    }
    throw new Error('Azure Speech retry limit reached.');
  }
  private async execute(run: StudioRun, request: RunSettings, credentials: SpeechCredentials) {
    this.executing.add(run.id);
    const stopped = () => run.status === 'pausing' || this.cancelled.has(run.id);
    try {
      const root = run.byLocale === run.output ? await realDirectory(run.output) : await ensureChildDirectory(run.output, 'by-locale');
      const queue = run.cells.filter(cell => cell.status === 'queued');
      for (let offset = 0; offset < queue.length && !stopped(); offset += STUDIO_SYNTHESIS_BATCH_SIZE) {
        let next = offset;
        const end = Math.min(offset + STUDIO_SYNTHESIS_BATCH_SIZE, queue.length);
        const worker = async () => {
          while (next < end && !stopped()) {
            const cell = queue[next++];
            let generated = false;
            try {
              const group = await ensureChildDirectory(root, path.basename(path.dirname(path.dirname(cell.path))));
              await ensureChildDirectory(group, path.basename(path.dirname(cell.path)));
              if (await existingFingerprint(cell.path)) throw new Error('An output file appeared after preview. No request was sent for this clip.');
              if (stopped()) return;
              cell.status = 'synthesizing';
              const bytes = await this.synthesize(cell, request, credentials);
              generated = true;
              await realDirectory(path.dirname(cell.path));
              const temp = `${cell.path}.${randomUUID()}.tmp`;
              try {
                await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
                await link(temp, cell.path);
              } finally { try { await unlink(temp); } catch (error) { if (!missing(error)) throw error; } }
              cell.status = 'done';
            } catch (error) {
              cell.status = 'failed'; cell.error = `${errorText(error)}${generated ? ' Azure returned audio, so the request may have been billed even though saving failed.' : ''}`;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(request.concurrency, end - offset) }, worker));
        if (end < queue.length && !stopped()) await this.persist(run, request);
      }
      this.finalizing.add(run.id);
      const status = this.cancelled.has(run.id) ? 'cancelled' : run.status === 'pausing' && run.cells.some(cell => cell.status === 'queued') ? 'paused' : 'completed';
      const finishedAt = status === 'paused' ? undefined : new Date().toISOString();
      await this.persist({ ...run, status, finishedAt }, request);
      run.status = status; run.finishedAt = finishedAt;
    } catch (error) {
      run.status = 'failed'; run.error = `Run could not continue: ${errorText(error)}`; run.finishedAt = new Date().toISOString();
      try { await this.persist(run, request); } catch (persistError) { console.error('Studio run persistence failed:', errorText(persistError)); }
    } finally { this.cancelled.delete(run.id); this.finalizing.delete(run.id); this.executing.delete(run.id); }
  }
}

export async function registerStudio(app: Express, store: Store, fetcher?: typeof fetch) {
  const studio = new AzureVoicesStudio(store, fetcher);
  await studio.load();
  app.get('/api/studio/connection', (_req, res) => res.json(studio.status()));
  app.put('/api/studio/connection', async (req, res) => res.json(await studio.save(req.body)));
  app.delete('/api/studio/connection', async (_req, res) => res.json(await studio.clear()));
  app.get('/api/studio/voices', async (req, res) => res.json(await studio.voices(req.query.refresh === '1')));
  app.post('/api/studio/scripts', (req, res) => {
    const input = z.object({ name: z.string().max(100), text: z.string().max(2_000_000) }).strict().parse(req.body);
    res.json(parseStudioScript(input.name, input.text));
  });
  app.post('/api/studio/paths', async (req, res) => {
    const input = z.object({ paths: z.array(z.string().min(1).max(1000)).min(1).max(100) }).strict().parse(req.body);
    res.json(await studio.readPaths(input.paths));
  });
  app.post('/api/studio/plan', async (req, res) => res.json(await studio.plan(req.body)));
  app.post('/api/studio/runs', async (req, res) => {
    const input = z.object({ token: z.string().uuid(), consent: z.boolean() }).strict().parse(req.body);
    res.status(201).json(await studio.start(input.token, input.consent));
  });
  app.get('/api/studio/runs', (_req, res) => res.json(studio.listRuns()));
  app.get('/api/studio/runs/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await studio.getRunView(z.string().uuid().parse(req.params.id), req.query.checkAudio === '1'));
  });
  app.post('/api/studio/runs/reopen', async (req, res) => {
    const input = z.object({ path: z.string().min(1).max(1000) }).strict().parse(req.body);
    const run = await studio.reopen(input.path);
    res.json(await studio.getRunView(run.id));
  });
  app.post('/api/studio/runs/:id/pause', (req, res) => res.json(studio.pause(z.string().uuid().parse(req.params.id))));
  app.post('/api/studio/runs/:id/resume', async (req, res) => {
    const input = z.object({ consent: z.boolean() }).strict().parse(req.body);
    res.json(await studio.resume(z.string().uuid().parse(req.params.id), input.consent));
  });
  app.post('/api/studio/runs/:id/cancel', (req, res) => res.json(studio.cancel(z.string().uuid().parse(req.params.id))));
  app.get('/api/studio/runs/:id/audio/:clipId', async (req, res) => {
    const run = studio.getRun(z.string().uuid().parse(req.params.id));
    const cell = run.cells.find(item => item.id === z.string().uuid().parse(req.params.clipId));
    if (!cell || !['done', 'skipped'].includes(cell.status)) throw new Error('Audio is not available.');
    await realDirectory(path.dirname(cell.path));
    if (!await existingFingerprint(cell.path)) throw new Error('Audio file is no longer available.');
    res.type('audio/wav').send(await readFile(cell.path));
  });
  return studio;
}
