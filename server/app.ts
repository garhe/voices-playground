import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z, ZodError } from 'zod';
import {
  clipSchema, clipScopeError, referenceWindow, settingsSchema, profileSchema, languageHintSchema, resolveLanguageHint, testNameSchema, evaluationName, retryableAudioIssue, SAMPLE_RATE, MAX_SECONDS, RUBRIC_VERSION,
  type Job, type Profile, type StoredClip, type TestQueueState, type EvaluationWorkspace, type JudgeResult, unassessedInputs, evaluationWorkspace,
  rubricSchema, rubricContentSchema, DEFAULT_RUBRIC, ARENA_RUBRIC, BUILT_IN_RUBRIC_IDS, DEFAULT_JUDGE_DEPLOYMENTS, type Rubric,
} from '../shared/domain.js';
import { measurements, wav } from './audio.js';
import { judgeAudio, JudgeAudioError, testRealtimeConnection } from './realtime.js';
import { Store } from './store.js';
import { QueueTiming } from './queueTiming.js';
import { Connection, type Credentials } from './credentials.js';
import { testHistory, testMetadataSchema, canManageTest, type BulkTestResult } from '../shared/history.js';
import { FolderSorting } from './sorting.js';
import { BatchImport } from './batch.js';
import { registerStudio } from './studio.js';
import { speechCheck } from './speechCheck.js';
import { registerScriptGeneration } from './scriptGeneration.js';
import { ArenaImport } from './arena.js';
import { mergeArenaReports, summarizeArenaReport, arenaReferenceSchema, arenaSettingsSchema } from '../shared/arena.js';
import { renderShareScorecard } from './shareScorecard.js';
import { validThemeSelection } from '../src/theme.js';

const uuid = z.string().uuid();
const CLIP_READ_BATCH_SIZE = 32;
const LARGE_JOB_CHECKPOINT_BATCH_SIZE = 25;
const message = (error: unknown) => error instanceof Error ? error.message : 'Unexpected evaluation failure.';
class EvaluationSaveError extends Error {
  constructor(cause: unknown) { super(message(cause), { cause }); }
}
function evaluationResults(job: Job): JudgeResult[] {
  const selection = job.retrySelection;
  if (!selection) return job.results;
  const keys = new Set(selection.map(({ clipId, judgeId }) => JSON.stringify([clipId, judgeId])));
  return job.results.filter(({ clipId, judgeId }) => keys.has(JSON.stringify([clipId, judgeId])));
}
function unassessedResults(job: Job, file?: string): JudgeResult[] {
  return unassessedInputs(job).filter(input => !file || input.clip.file === file)
    .flatMap(input => input.judges.map<JudgeResult>(({ judge, result }) => result ?? {
      clipId: input.clip.id, judgeId: judge.id, status: 'pending',
    }));
}
function prepareRetry(job: Job, selected: JudgeResult[]) {
  const existing = new Set(job.results);
  for (const result of selected) {
    if (existing.has(result)) {
      const { clipId: _clipId, judgeId: _judgeId, previousEvaluations, ...evaluation } = result;
      result.previousEvaluations = [...(previousEvaluations ?? []), { ...evaluation, retriedAt: new Date().toISOString() }];
    } else job.results.push(result);
    result.status = 'pending'; delete result.error; delete result.assessment; delete result.model;
    delete result.responseFormat; delete result.audioDiagnostics;
  }
  job.retrySelection = selected.map(({ clipId, judgeId }) => ({ clipId, judgeId }));
}
const jobRequest = z.object({
  name: testNameSchema,
  profile: profileSchema,
  clipIds: z.array(uuid).min(1),
  clipOverrides: z.array(z.object({
    id: uuid, voice: z.string().trim().min(1).max(200), language: languageHintSchema,
  })).optional(),
  consent: z.literal(true),
  enqueue: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  judges: settingsSchema.innerType().shape.judges.optional(),
  arena: arenaReferenceSchema.optional(),
  voiceLabels: testMetadataSchema.innerType().shape.voiceLabels.optional(),
}).refine(r => new Set(r.clipIds).size === r.clipIds.length, 'Clip IDs must be unique.')
  .refine(r => {
    if (!r.clipOverrides) return true;
    const clipIds = new Set(r.clipIds);
    return new Set(r.clipOverrides.map(c => c.id)).size === r.clipOverrides.length &&
      r.clipOverrides.every(c => clipIds.has(c.id));
  }, 'Clip overrides must be unique and refer to selected clips.');
const bulkJobRequest = z.object({
  action: z.enum(['delete', 'redo']), ids: z.array(uuid).min(1), consent: z.literal(true).optional(),
}).strict().refine(value => new Set(value.ids).size === value.ids.length, 'Test IDs must be unique.')
  .refine(value => value.action !== 'redo' || value.consent === true, 'Redo requires permission to send saved audio to Azure and incur new charges.');

export function validateScope(profile: Profile, clips: StoredClip[]) {
  const error = clipScopeError(profile.scope, clips);
  if (error) throw new Error(error);
}

export async function createApp(options: {
  dataDir: string; endpoint?: string; key?: string; deployments?: string;
  clipConcurrency?: 1 | 2;
  saveRetryDelayMs?: number;
  scriptDeployment?: string; scriptFetch?: typeof fetch;
  evaluate?: typeof judgeAudio; testConnection?: typeof testRealtimeConnection; speechFetch?: typeof fetch; port?: number;
  verifySpeech?: (clip: StoredClip, pcm: Buffer, locale: string, windowed: boolean, signal: AbortSignal) => Promise<NonNullable<StoredClip['speechCheck']>>;
}) {
  const store = new Store(options.dataDir);
  await store.init();
  const connection = new Connection(store, { endpoint: options.endpoint, key: options.key });
  await connection.load();
  if (!await store.exists('settings.json')) {
    const deployments = options.deployments ? options.deployments.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_JUDGE_DEPLOYMENTS;
    await store.save('settings.json', settingsSchema.parse({
      judges: deployments.map((deployment, i) => ({ id: randomUUID(), name: `Judge ${i + 1}`, deployment })),
    }));
  }
  settingsSchema.parse(await store.settings());
  const rubricLibrarySchema = z.array(rubricSchema).refine(items =>
    new Set([...BUILT_IN_RUBRIC_IDS, ...items.map(item => item.id)]).size === items.length + BUILT_IN_RUBRIC_IDS.length, 'Rubric IDs must be unique and must not replace a built-in rubric.');
  let rubrics = await store.exists('rubrics.json') ? rubricLibrarySchema.parse(await store.read('rubrics.json')) : [];
  let rubricWrite = false;
  const savedJobs = await store.jobs();
  let queueOrder = Math.max(0, ...savedJobs.map(job => job.queueOrder ?? 0));
  for (const job of savedJobs) {
    if (job.retryAfter !== undefined) {
      delete job.retryAfter;
      await store.saveJob(job);
    }
    if (job.status === 'running') {
      job.status = 'interrupted';
      for (const result of evaluationResults(job)) if (['running', 'pending'].includes(result.status)) {
        result.status = 'interrupted'; result.error = 'Server stopped before this assessment completed. Resume to retry.';
      }
      await store.saveJob(job);
    }
    if (job.autoRetry && ['completed', 'interrupted'].includes(job.status)) {
      const selected = unassessedResults(job);
      if (selected.length) {
        prepareRetry(job, selected);
        job.status = 'queued';
        job.queueOrder = Math.min(0, ...savedJobs.map(saved => saved.queueOrder ?? 0)) - 1;
        await store.saveJob(job);
      }
    }
  }
  const app = express();
  app.disable('x-powered-by');
  type Queue = {
    active?: { job: Job; controller: AbortController };
    activeTiming?: { rate: QueueTiming; selected: JudgeResult[] };
    waiting: Job[];
    paused: boolean;
    error?: string;
    runtimeError?: string;
    saveRecovery?: { jobId: string; detail: string; attempts: number; memoryOnly: boolean };
    saveRetryTimer?: ReturnType<typeof setTimeout>;
    dispatching: boolean;
    queuedWrites: number;
  };
  const queueOrderCompare = (a: Job, b: Job) =>
    (a.queueOrder ?? 0) - (b.queueOrder ?? 0) || a.createdAt.localeCompare(b.createdAt);
  function createQueue(workspace: EvaluationWorkspace): Queue {
    const waiting = savedJobs.filter(job => job.status === 'queued' && evaluationWorkspace(job) === workspace).sort(queueOrderCompare);
    return { waiting, paused: waiting.length > 0, dispatching: false, queuedWrites: 0 };
  }
  const queues = { scoring: createQueue('scoring'), arena: createQueue('arena') };
  const allQueues = Object.values(queues);
  const queueForJob = (job: Job) => queues[evaluationWorkspace(job)];
  const findActive = (id: string) => allQueues.find(queue => queue.active?.job.id === id)?.active;
  const findWaiting = (id: string) => allQueues.find(queue => queue.waiting.some(job => job.id === id));
  const allWaiting = () => allQueues.flatMap(queue => queue.waiting).sort(queueOrderCompare);
  const hasWork = (queue: Queue) => queue.active || queue.dispatching || queue.queuedWrites || queue.waiting.length;
  const changingJobs = new Set<string>();
  const evaluate = options.evaluate ?? judgeAudio;
  const testConnection = options.testConnection ?? testRealtimeConnection;
  let connectionWrite = false;
  let testingConnection = false;
  const queuedTest = (job: Job) => ({
    id: job.id, name: evaluationName(job), workspace: evaluationWorkspace(job),
    retry: job.retrySelection ? true : undefined, autoRetryCount: job.autoRetryCount,
  });
  function queueState(queue: Queue): TestQueueState {
    const { active, activeTiming, waiting, paused, error, saveRecovery, runtimeError } = queue;
    const current = activeTiming?.selected.filter(result => result.status === 'pending' || result.status === 'running').length ?? 0;
    const queued = activeTiming && !paused ? waiting.reduce((count, job) =>
      count + evaluationResults(job).filter(result => result.status !== 'completed').length, 0) : 0;
    return {
      paused, runtimeError,
      error: error ?? (saveRecovery ? `${saveRecovery.detail} ${paused
        ? 'Automatic save retry is paused. Select Start queue to continue.'
        : 'Retrying the local save automatically. No later test will start before this one.'}` : undefined),
      recoveringSave: !!saveRecovery && !paused && !error,
      eta: activeTiming?.rate.minutesLeft(performance.now(), current, queued, paused) ?? {},
      active: active && queuedTest(active.job),
      waiting: waiting.map(queuedTest),
    };
  }
  function clearSaveRetryTimer(queue: Queue) {
    clearTimeout(queue.saveRetryTimer);
    queue.saveRetryTimer = undefined;
  }
  function retryQueueSave(job: Job, error: unknown, checkpoint?: 'saved' | 'memory-only') {
    const queue = queueForJob(job);
    const previous = queue.saveRecovery?.jobId === job.id ? queue.saveRecovery : undefined;
    const attempts = (previous?.attempts ?? 0) + 1;
    const memoryOnly = checkpoint === undefined ? previous?.memoryOnly ?? false : checkpoint === 'memory-only';
    const detail = `Could not save "${evaluationName(job)}": ${connection.redact(error)}.${
      memoryOnly ? ' The latest checkpoint is in memory; keep the server running.' : ''}`;
    queue.saveRecovery = { jobId: job.id, detail, attempts, memoryOnly };
    console.warn(detail);
    if (!previous) void store.recordQueueSaveRetry(job.id, checkpoint ? { phase: 'running', checkpoint } : { phase: 'starting' });
    if (queue.paused) return;
    clearSaveRetryTimer(queue);
    const delay = Math.min((options.saveRetryDelayMs ?? 5000) * 2 ** Math.min(attempts - 1, 3), 30000);
    queue.saveRetryTimer = setTimeout(() => {
      queue.saveRetryTimer = undefined;
      void drainQueue(queue);
    }, delay);
    queue.saveRetryTimer.unref();
  }
  async function drainQueue(queue: Queue) {
    const { waiting, saveRecovery } = queue;
    if (queue.active || queue.dispatching || queue.queuedWrites || queue.paused || queue.saveRetryTimer || !waiting.length) return;
    queue.dispatching = true;
    let next: Job | undefined;
    try {
      const credentials = connection.current();
      const recoveryIndex = saveRecovery ? waiting.findIndex(job => job.id === saveRecovery?.jobId) : -1;
      [next] = waiting.splice(Math.max(0, recoveryIndex), 1);
      const controller = new AbortController();
      next.status = 'running'; queue.active = { job: next, controller };
      await store.saveJob(next);
      if (saveRecovery?.jobId === next.id) queue.saveRecovery = undefined;
      void run(next, controller, credentials);
    } catch (error) {
      if (next) {
        next.status = 'queued'; waiting.unshift(next); queue.active = undefined;
        if (next.autoRetry) {
          retryQueueSave(next, error);
          return;
        }
        void store.recordSavePause(next.id, { phase: 'starting' });
      }
      queue.paused = true;
      queue.error = `Queue paused: ${connection.redact(error)}. Resolve the problem and start the queue again.`;
      console.error(queue.error);
    } finally { queue.dispatching = false; }
  }
  function newEvaluation(input: Pick<Job, 'name' | 'profile' | 'judges' | 'clips' | 'autoRetry'>, enqueue: boolean): Job {
    const clips = input.clips.map(({ speechCheck: _speechCheck, ...clip }) => clip);
    return {
      ...input, clips, id: randomUUID(), createdAt: new Date().toISOString(), status: enqueue ? 'queued' : 'running',
      profile: { ...input.profile, rubric: input.profile.rubric ?? structuredClone(DEFAULT_RUBRIC) },
      rubric: RUBRIC_VERSION,
      autoRetry: input.autoRetry ?? true,
      collectVoiceDescriptors: true,
      results: clips.flatMap(clip => input.judges.map(judge => ({ clipId: clip.id, judgeId: judge.id, status: 'pending' }))),
    };
  }
  const firstQueueOrder = (queue: Queue) => queue.waiting.reduce((min, job) => Math.min(min, job.queueOrder ?? 0), 0) - 1;
  async function saveEvaluation(job: Job) {
    try { await store.saveJob(job); }
    catch (error) { throw new EvaluationSaveError(error); }
  }
  async function enqueueEvaluation(job: Job, first = false) {
    const queue = queueForJob(job);
    job.queueOrder = first ? firstQueueOrder(queue) : ++queueOrder;
    await saveEvaluation(job);
    queue.waiting.push(job); queue.waiting.sort(queueOrderCompare);
  }
  function ensureChangeable(id: string) {
    if (findActive(id) || findWaiting(id) || changingJobs.has(id))
      throw new Error('This test is running, queued or being changed. Cancel a waiting test or wait for it to finish.');
  }
  async function deleteEvaluation(id: string) {
    ensureChangeable(id);
    changingJobs.add(id);
    try { await store.remove(path.join('jobs', `${id}.json`)); }
    finally { changingJobs.delete(id); }
  }
  app.use((req, res, next) => {
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${options.port ?? 4310}`, `localhost:${options.port ?? 4310}`];
    if (!host || !allowedHosts.includes(host)) { res.status(403).json({ error: 'Only the local application host is allowed.' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed.' }); return;
    }
    if (req.path.startsWith('/api') && req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return;
    }
    if (req.path.startsWith('/.data') || req.path.startsWith('/.env')) { res.sendStatus(404); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '9mb' }));
  const folderSorting = new FolderSorting(options.dataDir);
  const batchImport = new BatchImport();
  const arenaImport = new ArenaImport();
  const studio = await registerStudio(app, store, options.speechFetch);
  registerScriptGeneration(app, { connection, store, studio, defaultDeployment: options.scriptDeployment, fetchText: options.scriptFetch });
  const loadReportSummaries = store.jobProjections(job => ({
    history: testHistory(job), arena: summarizeArenaReport(job),
  }));
  const loadArenaReports = async () => mergeArenaReports((await loadReportSummaries()).map(item => item.arena));
  app.get('/api/arena', async (_req, res) => res.json(await loadArenaReports()));
  app.get('/api/arena/share-scorecard', async (req, res) => {
    const theme = z.string().refine(validThemeSelection, 'Unknown workspace theme.').optional().parse(req.query.theme);
    const { cells } = await loadArenaReports();
    if (!cells.length) {
      res.status(409).json({ error: 'No fully assessed Arena results are available to share.' });
      return;
    }
    const html = await renderShareScorecard(cells, theme);
    res.attachment('index.html').type('html').send(html);
  });
  app.get('/api/arena/settings', async (_req, res) => res.json(
    await store.exists('arena-settings.json') ? await store.read('arena-settings.json') : await store.settings(),
  ));
  app.put('/api/arena/settings', async (req, res) => {
    const settings = arenaSettingsSchema.parse(req.body);
    await store.save('arena-settings.json', settings);
    res.json(settings);
  });
  app.post('/api/arena/preview', async (req, res) => res.json(await arenaImport.plan(req.body)));
  app.post('/api/arena/uploads/preview', async (req, res) => res.json(await arenaImport.planUploads(req.body)));
  app.get('/api/arena/:token/audio/:id', async (req, res) => {
    res.type('application/octet-stream').send(await arenaImport.audio(uuid.parse(req.params.token), uuid.parse(req.params.id)));
  });
  app.post('/api/batch/preview', async (req, res) => res.json(await batchImport.plan(req.body)));
  app.get('/api/batch/:token/audio/:id', async (req, res) => {
    const audio = await batchImport.audio(uuid.parse(req.params.token), uuid.parse(req.params.id));
    res.type('application/octet-stream').send(audio);
  });
  app.post('/api/folders/preview', async (req, res) => res.json(await folderSorting.plan(req.body)));
  app.post('/api/folders/apply', async (req, res) => res.json(await folderSorting.apply(req.body)));
  app.get('/api/config', async (_req, res) => res.json({
    ...await store.settings(), ...connection.status(), runtimeError: queues.scoring.runtimeError, rubric: RUBRIC_VERSION,
  }));
  app.get('/api/rubrics', (_req, res) => res.json([DEFAULT_RUBRIC, ...rubrics]));
  app.post('/api/rubrics', async (req, res) => {
    if (rubricWrite) { res.status(409).json({ error: 'A rubric is being saved. Try again shortly.' }); return; }
    rubricWrite = true;
    try {
      const content = rubricContentSchema.parse(req.body);
      if ([DEFAULT_RUBRIC, ARENA_RUBRIC, ...rubrics].some(item => item.name.toLowerCase() === content.name.toLowerCase())) {
        res.status(409).json({ error: 'A rubric with this name already exists. Enter a different name for the new preset.' }); return;
      }
      const rubric = rubricSchema.parse({ ...content, id: randomUUID(), revision: 1 });
      const next = [...rubrics, rubric];
      await store.save('rubrics.json', next);
      rubrics = next; res.status(201).json(rubric);
    } finally { rubricWrite = false; }
  });
  app.put('/api/rubrics/:id', async (req, res) => {
    if (req.params.id === DEFAULT_RUBRIC.id) { res.status(409).json({ error: 'The built-in default is read-only. Save an edited copy as a new preset.' }); return; }
    const id = uuid.parse(req.params.id);
    if (rubricWrite) { res.status(409).json({ error: 'A rubric is being saved. Try again shortly.' }); return; }
    rubricWrite = true;
    try {
      const input = rubricContentSchema.extend({ revision: z.number().int().positive() }).parse(req.body);
      const previous = rubrics.find(item => item.id === id);
      if (!previous) { res.status(404).json({ error: 'This rubric preset no longer exists. Refresh the presets.' }); return; }
      if (input.revision !== previous.revision) { res.status(409).json({ error: 'This rubric was changed in another window. Refresh the presets before saving again.' }); return; }
      if ([DEFAULT_RUBRIC, ARENA_RUBRIC, ...rubrics].some(item => item.id !== id && item.name.toLowerCase() === input.name.toLowerCase())) {
        res.status(409).json({ error: 'A rubric with this name already exists. Enter a different rubric name.' }); return;
      }
      const rubric: Rubric = rubricSchema.parse({ ...input, id, revision: previous.revision + 1 });
      const next = rubrics.map(item => item.id === id ? rubric : item);
      await store.save('rubrics.json', next);
      rubrics = next; res.json(rubric);
    } finally { rubricWrite = false; }
  });
  app.delete('/api/rubrics/:id', async (req, res) => {
    if (req.params.id === DEFAULT_RUBRIC.id) { res.status(409).json({ error: 'The built-in default cannot be deleted.' }); return; }
    const id = uuid.parse(req.params.id);
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    if (rubricWrite) { res.status(409).json({ error: 'A rubric is being saved. Try again shortly.' }); return; }
    rubricWrite = true;
    try {
      const previous = rubrics.find(item => item.id === id);
      if (!previous) { res.status(404).json({ error: 'This rubric preset no longer exists. Refresh the presets.' }); return; }
      if (previous.revision !== revision) { res.status(409).json({ error: 'This rubric was changed in another window. Refresh the presets before deleting it.' }); return; }
      const next = rubrics.filter(item => item.id !== id);
      await store.save('rubrics.json', next);
      rubrics = next; res.json({ deleted: id });
    } finally { rubricWrite = false; }
  });
  app.put('/api/connection', async (req, res) => {
    if (connectionWrite) { res.status(409).json({ error: 'Connection settings are already being saved. Try again shortly.' }); return; }
    connectionWrite = true;
    try { res.json(await connection.save(req.body)); }
    finally { connectionWrite = false; }
  });
  app.delete('/api/connection', async (_req, res) => {
    if (connectionWrite) { res.status(409).json({ error: 'Connection settings are already being saved. Try again shortly.' }); return; }
    connectionWrite = true;
    try { res.json(await connection.clear()); }
    finally { connectionWrite = false; }
  });
  app.post('/api/connection/test', async (req, res) => {
    const { judges } = settingsSchema.parse(req.body);
    if (testingConnection) { res.status(409).json({ error: 'A connection test is already running.' }); return; }
    const credentials = connection.current();
    testingConnection = true;
    try {
      const results = await Promise.all(judges.map(async judge => {
        try {
          const output = await testConnection({ ...credentials, judge });
          return { judgeId: judge.id, ok: true, model: output.model };
        } catch (error) {
          const detail = connection.redact(error);
          console.error(`Connection test for ${judge.name} failed: ${detail}`);
          return { judgeId: judge.id, ok: false, error: detail };
        }
      }));
      res.json({ results });
    } finally { testingConnection = false; }
  });
  app.put('/api/settings', async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    await store.save('settings.json', settings); res.json(settings);
  });
  app.post('/api/clips', async (req, res) => {
    const { clip, pcm } = z.object({
      clip: clipSchema,
      pcm: z.string().min(1).max(SAMPLE_RATE * 2 * MAX_SECONDS * 4 / 3 + 4)
        .refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid base64 audio.'),
    }).parse(req.body);
    const bytes = Buffer.from(pcm, 'base64');
    const seconds = bytes.length / (SAMPLE_RATE * 2);
    if (bytes.length % 2 || seconds < 0.5 || seconds > MAX_SECONDS || Math.abs(seconds - (clip.end - clip.start)) > 0.025) {
      res.status(400).json({ error: `Audio must be 24 kHz mono PCM16, match the selected duration, and last 0.5-${MAX_SECONDS} seconds.` }); return;
    }
    const stored = { ...clip, technical: measurements(bytes) };
    await store.saveClip(stored, bytes);
    res.status(201).json(stored);
  });
  app.get('/api/clips/:id/audio', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const audio = wav(await store.pcm(id));
    res.type('wav').set('Accept-Ranges', 'bytes');
    const ranges = req.get('Range')?.startsWith('bytes=') ? req.range(audio.length, { combine: true }) : undefined;
    if (ranges === -1) { res.status(416).set('Content-Range', `bytes */${audio.length}`).end(); return; }
    if (ranges && ranges !== -2 && ranges.type === 'bytes' && ranges.length === 1) {
      const { start, end } = ranges[0];
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${audio.length}`).send(audio.subarray(start, end + 1));
      return;
    }
    res.send(audio);
  });
  app.get('/api/jobs', async (_req, res) => {
    const reports = await loadReportSummaries();
    const queued = new Map(allWaiting().map(job => [job.id, job]));
    res.json(reports.map(({ history }) => {
      const live = findActive(history.id)?.job;
      if (live) return testHistory(live);
      return queued.has(history.id) && history.status !== 'queued' ? { ...history, status: 'queued' } : history;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  app.post('/api/jobs/bulk', async (req, res) => {
    const input = bulkJobRequest.parse(req.body);
    if (input.action === 'redo') connection.current();
    const writing = new Set<Queue>();
    const result: BulkTestResult = { succeeded: [], failed: [] };
    try {
      for (const id of input.ids) {
        try {
          if (input.action === 'delete') {
            await deleteEvaluation(id);
            result.succeeded.push({ id });
            continue;
          }
          ensureChangeable(id);
          changingJobs.add(id);
          try {
            const source = await store.read<Job>(path.join('jobs', `${id}.json`));
            const queue = queueForJob(source);
            if (!writing.has(queue)) { writing.add(queue); queue.queuedWrites++; }
            if (!canManageTest(source)) throw new Error('This test is running or queued. Wait or cancel it before redoing.');
            const profile = profileSchema.parse(source.profile);
            const { judges } = settingsSchema.parse({ judges: source.judges });
            if (!source.clips.length) throw new Error('Redo requires saved audio inputs. Use Edit inputs to prepare a new test.');
            const clips = source.clips.map(clip => ({ ...clip, ...clipSchema.parse(clip) }));
            validateScope(profile, clips);
            for (const clip of clips)
              if (!await store.hasPcm(clip.id)) throw new Error(`Saved audio is unavailable for ${clip.file}. Import the original recording again.`);
            const job = newEvaluation({ name: evaluationName(source), profile, judges, clips }, true);
            if (source.arena) job.arena = structuredClone(source.arena);
            if (source.voiceLabels) job.voiceLabels = source.voiceLabels.map(label => ({ ...label }));
            await enqueueEvaluation(job);
            result.succeeded.push({ id, newId: job.id });
          } finally { changingJobs.delete(id); }
        } catch (error) {
          const detail = error instanceof ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : connection.redact(error);
          console.error(`Bulk ${input.action} failed for test ${id}: ${detail}`);
          result.failed.push({ id, error: detail });
        }
      }
      res.json(result);
    } finally {
      for (const queue of writing) { queue.queuedWrites--; void drainQueue(queue); }
    }
  });
  const queueWorkspace = z.enum(['scoring', 'arena']).optional();
  function queueResponse(workspace?: EvaluationWorkspace): TestQueueState {
    if (workspace) return queueState(queues[workspace]);
    // Keep the unscoped API for existing local scripts; workspace views always request a specific queue.
    const states = allQueues.map(queueState);
    const primary = states.find(state => state.active) ?? states.find(state => state.error) ?? states[0];
    return { ...primary, paused: states.some(state => state.paused), waiting: allWaiting().map(queuedTest) };
  }
  app.get('/api/queue', (req, res) => res.json(queueResponse(queueWorkspace.parse(req.query.workspace))));
  app.post('/api/queue/pause', (req, res) => {
    const workspace = queueWorkspace.parse(req.query.workspace);
    for (const queue of workspace ? [queues[workspace]] : allQueues) {
      queue.paused = true; clearSaveRetryTimer(queue);
    }
    res.json(queueResponse(workspace));
  });
  app.post('/api/queue/start', async (req, res) => {
    z.object({ consent: z.literal(true) }).parse(req.body);
    const workspace = queueWorkspace.parse(req.query.workspace);
    connection.current();
    await Promise.all((workspace ? [queues[workspace]] : allQueues).map(queue => {
      clearSaveRetryTimer(queue);
      queue.paused = false; queue.error = undefined;
      return drainQueue(queue);
    }));
    res.json(queueResponse(workspace));
  });
  app.get('/api/jobs/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json(findActive(id)?.job ?? findWaiting(id)?.waiting.find(job => job.id === id) ?? await store.read<Job>(path.join('jobs', `${id}.json`)));
  });
  app.get('/api/jobs/:id/draft', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const job = await store.read<Job>(path.join('jobs', `${id}.json`));
    const available = await Promise.all(job.clips.map(c => store.hasPcm(c.id)));
    res.json({ job, clips: job.clips.filter((_c, i) => available[i]), missing: available.filter(value => !value).length });
  });
  app.patch('/api/jobs/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const metadata = testMetadataSchema.parse(req.body);
    if (findActive(id) || findWaiting(id) || changingJobs.has(id)) {
      res.status(409).json({ error: 'This evaluation is running, queued or being changed. Cancel a waiting test before editing its labels.' }); return;
    }
    changingJobs.add(id);
    try {
      const job = await store.read<Job>(path.join('jobs', `${id}.json`));
      if (metadata.voiceLabels.some(label => !job.clips.some(clip => clip.voice === label.voice))) {
        res.status(400).json({ error: 'Gender labels must refer to voices in this evaluation.' }); return;
      }
      job.name = metadata.name; job.voiceLabels = metadata.voiceLabels;
      await store.saveJob(job);
      res.json(job);
    } finally { changingJobs.delete(id); }
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (findActive(id) || findWaiting(id) || changingJobs.has(id)) {
      res.status(409).json({ error: 'This evaluation is running, queued or being changed. Cancel a waiting test before deleting it.' }); return;
    }
    await deleteEvaluation(id);
    res.json({ deleted: id });
  });
  async function run(job: Job, controller: AbortController, credentials: Credentials, selected = evaluationResults(job)) {
    const queue = queueForJob(job);
    const rate = new QueueTiming(performance.now());
    queue.activeTiming = { rate, selected };
    try {
      if (job.rubric !== RUBRIC_VERSION) throw new Error('The rubric changed. Create a new evaluation with the current rubric.');
      const byClip = new Map<string, Map<string, JudgeResult>>();
      for (const result of selected) {
        if (result.status === 'completed') continue;
        const byJudge = byClip.get(result.clipId) ?? new Map<string, JudgeResult>();
        byJudge.set(result.judgeId, result);
        byClip.set(result.clipId, byJudge);
      }
      const batchCheckpoints = job.clips.length > 200;
      const speechChecks = new Map<string, Promise<void>>();
      let completedSinceSave = 0;
      let lastSave = Date.now();
      let checkpoint: Promise<void> | undefined;
      let failure: { error: unknown } | undefined;
      function stopWorkers(error: unknown) {
        failure ??= { error };
        controller.abort();
      }
      function checkSpeech(clip: StoredClip, pcm: Buffer): Promise<void> {
        const arena = job.arena;
        if (!arena || job.profile.arenaSpeechCheck !== true) return Promise.resolve();
        let pending = speechChecks.get(clip.id);
        if (!pending) {
          pending = (async () => {
            let key = '';
            try {
              const windowed = !!referenceWindow(clip, job.clips);
              if (options.verifySpeech) {
                clip.speechCheck = await options.verifySpeech(clip, pcm, arena.locale, windowed, controller.signal);
              } else {
                const credentials = studio.verificationCredentials();
                key = credentials.key;
                clip.speechCheck = await speechCheck(
                  credentials, pcm, arena.locale, clip.referenceScript, windowed, controller.signal, options.speechFetch,
                );
              }
            } catch (error) {
              if (controller.signal.aborted) return;
              const detail = connection.redact(error);
              clip.speechCheck = { status: 'failed', error: key ? detail.replaceAll(key, '[REDACTED]') : detail };
              console.error(`Speech check failed for clip ${clip.id}: ${clip.speechCheck.error}`);
            }
          })();
          speechChecks.set(clip.id, pending);
        }
        return pending;
      }
      async function scoreJudge(clip: StoredClip, judge: Job['judges'][number], result: JudgeResult, pcm: Buffer) {
        if (controller.signal.aborted) { result.status = 'cancelled'; return; }
        result.status = 'running'; delete result.error; delete result.responseFormat;
        delete result.assessment; delete result.model; delete result.audioDiagnostics;
        if (!batchCheckpoints) await saveEvaluation(job);
        if (controller.signal.aborted) { result.status = 'cancelled'; return; }
        try {
          await checkSpeech(clip, pcm);
          if (controller.signal.aborted) { result.status = 'cancelled'; return; }
          const output = await evaluate({
            ...credentials, judge, pcm, role: clip.role,
            ...(job.arena && clip.referenceScript ? { referenceScript: clip.referenceScript, referenceWindow: referenceWindow(clip, job.clips) } : {}),
            collectVoiceDescriptors: job.collectVoiceDescriptors === true,
            profile: { ...job.profile, language: resolveLanguageHint(clip.language, job.profile.language) }, signal: controller.signal,
          });
          result.assessment = output.assessment; result.model = output.model; result.status = 'completed';
          result.responseFormat = output.responseFormat;
          result.audioDiagnostics = output.audioDiagnostics;
          if (output.responseFormat === 'function_call_with_preamble')
            console.warn(`Judge ${judge.name} returned a validated function with a non-assessment preamble; the preamble was ignored, not scored.`);
          else if (output.responseFormat && output.responseFormat !== 'function_call')
            console.warn(`Judge ${judge.name} returned ${output.responseFormat} instead of a function call; accepted after full assessment validation.`);
        } catch (error) {
          result.status = controller.signal.aborted ? 'cancelled' : 'failed';
          result.error = connection.redact(error);
          if (error instanceof JudgeAudioError) {
            result.audioDiagnostics = error.audioDiagnostics;
            for (const session of result.audioDiagnostics.sessions)
              if (session.error) session.error = connection.redact(new Error(session.error));
          }
          console.error(`Judge ${judge.name} failed for clip ${clip.id}: ${result.error}`);
        }
        if (!controller.signal.aborted) rate.record(performance.now());
        if (!batchCheckpoints) await saveEvaluation(job);
      }
      async function checkpointAfterWork(limit: number) {
        if (!batchCheckpoints) return;
        completedSinceSave++;
        if (!checkpoint && (completedSinceSave >= limit || Date.now() - lastSave >= 5000)) {
          completedSinceSave = 0;
          checkpoint = saveEvaluation(job).finally(() => { checkpoint = undefined; lastSave = Date.now(); });
        }
        if (checkpoint) await checkpoint;
      }
      async function guarded(work: () => Promise<void>) {
        try { await work(); }
        catch (error) { stopWorkers(error); }
      }
      if (options.clipConcurrency === 2) {
        // Share overlapping reads without retaining audio for clips that slower judges have not reached yet.
        const reads = new Map<string, Promise<Buffer>>();
        function readAudio(id: string) {
          let pcm = reads.get(id);
          if (!pcm) {
            pcm = store.pcm(id).finally(() => { reads.delete(id); });
            reads.set(id, pcm);
          }
          return pcm;
        }
        const checkpointLimit = LARGE_JOB_CHECKPOINT_BATCH_SIZE * job.judges.length;
        const totalSlots = 2 * job.judges.length;
        const maxSlotsPerJudge = 6;
        const lanes = job.judges.map(judge => ({
          judge, running: 0, next: 0,
          pending: job.clips.flatMap(clip => {
            const result = byClip.get(clip.id)?.get(judge.id);
            return result ? [{ clip, result }] : [];
          }),
        }));
        await new Promise<void>(resolve => {
          let running = 0;
          function fillSlots() {
            while (!controller.signal.aborted && running < totalSlots) {
              let lane: typeof lanes[number] | undefined;
              for (const candidate of lanes) {
                if (candidate.next < candidate.pending.length && candidate.running < maxSlotsPerJudge &&
                    (!lane || candidate.running < lane.running)) lane = candidate;
              }
              if (!lane) break;
              const assigned = lane;
              const { clip, result } = assigned.pending[assigned.next++];
              assigned.running++;
              running++;
              void guarded(async () => {
                await scoreJudge(clip, assigned.judge, result, await readAudio(clip.id));
                await checkpointAfterWork(checkpointLimit);
              }).then(() => {
                assigned.running--;
                running--;
                fillSlots();
              });
            }
            if (!running) resolve();
          }
          fillSlots();
        });
      } else {
        await guarded(async () => {
          for (const clip of job.clips) {
            if (controller.signal.aborted) break;
            const results = byClip.get(clip.id);
            if (!results) continue;
            const pcm = await store.pcm(clip.id);
            await Promise.all(job.judges.map(judge => guarded(async () => {
              const result = results.get(judge.id);
              if (result) await scoreJudge(clip, judge, result, pcm);
            })));
            if (!failure) await checkpointAfterWork(LARGE_JOB_CHECKPOINT_BATCH_SIZE);
          }
        });
      }
      if (failure) throw failure.error;
      const status = controller.signal.aborted ? 'cancelled' : 'completed';
      for (const r of selected) if (r.status === 'pending' || r.status === 'running') {
        r.status = 'cancelled'; r.error = 'Evaluation cancelled before completion.';
      }
      delete job.retrySelection;
      await saveEvaluation({ ...job, status });
      job.status = status;
      if (status === 'completed' && job.autoRetry) {
        const remaining = unassessedResults(job);
        if (remaining.length) {
          prepareRetry(job, remaining);
          job.autoRetryCount = (job.autoRetryCount ?? 0) + 1;
          job.status = 'queued';
          await enqueueEvaluation(job, true);
        }
      }
    } catch (error) {
      if (error instanceof EvaluationSaveError && job.autoRetry) {
        const remaining = job.status === 'queued' ? evaluationResults(job) : selected;
        const unfinished = remaining.filter(r => ['running', 'pending', 'cancelled'].includes(r.status));
        if (job.status !== 'queued') prepareRetry(job, unfinished);
        const held = { ...job, status: 'queued' as const, queueOrder: firstQueueOrder(queue) };
        let saved = true;
        try { await store.saveJob(held); }
        catch (saveError) {
          saved = false;
          console.error('Could not persist paused evaluation:', connection.redact(saveError));
        }
        if (job.autoRetry) {
          queue.waiting.push(held);
          queue.waiting.sort(queueOrderCompare);
          retryQueueSave(held, error, saved ? 'saved' : 'memory-only');
          return;
        }
        // A cancellation can arrive while the held checkpoint is being written.
        selected = unfinished;
      }
      const runtimeError = `Evaluation interrupted: ${connection.redact(error)}`;
      queue.runtimeError = runtimeError;
      console.error(runtimeError);
      for (const r of selected) if (r.status === 'pending' || r.status === 'running') {
        r.status = 'interrupted'; r.error = runtimeError;
      }
      try { await store.saveJob({ ...job, status: 'interrupted' }); }
      catch (saveError) { console.error('Could not persist interrupted state:', message(saveError)); }
      job.status = 'interrupted';
    } finally {
      queue.activeTiming = undefined;
      queue.active = undefined;
      void drainQueue(queue);
    }
  }
  app.post('/api/jobs', async (req, res) => {
    const input = jobRequest.parse(req.body);
    const queue = queues[input.arena ? 'arena' : 'scoring'];
    if (!input.enqueue && hasWork(queue)) {
      res.status(409).json({ error: 'Another evaluation is running or queued. Add this test to the queue instead.' }); return;
    }
    if (input.enqueue) queue.queuedWrites++;
    try {
      const credentials = connection.current();
      const settings = settingsSchema.parse(input.judges ? { judges: input.judges } : await store.settings());
      const overrides = new Map(input.clipOverrides?.map(override => [override.id, override]));
      const clips: StoredClip[] = [];
      for (let offset = 0; offset < input.clipIds.length; offset += CLIP_READ_BATCH_SIZE) {
        const batch = await Promise.all(input.clipIds.slice(offset, offset + CLIP_READ_BATCH_SIZE).map(async id => {
          const clip = await store.clip(id);
          const override = overrides.get(id);
          if (!await store.hasPcm(id)) throw new Error(`Saved audio is unavailable for ${clip.file}. Import the original recording again.`);
          return {
            ...clip, ...(override ? { voice: override.voice } : {}),
            language: resolveLanguageHint(override?.language ?? clip.language, input.profile.language),
          };
        }));
        clips.push(...batch);
      }
      validateScope(input.profile, clips);
      const arena = input.arena ? arenaImport.metadata(input.arena, clips) : undefined;
      if (arena && (input.profile.stage !== 'tts' || input.profile.scope !== 'single' ||
          input.profile.language !== arena.locale || input.profile.targetMarket !== arena.locale ||
          clips.some(clip => clip.language !== arena.locale)))
        throw new Error('Arena requires TTS single-speaker evaluation with the script locale as language/accent for all audio.');
      if (input.arena) {
        const references = arenaImport.referenceScripts(input.arena, clips);
        const ssmls = arenaImport.ssmls(input.arena, clips);
        for (const clip of clips) {
          const text = references.get(clip.id);
          if (text) clip.referenceScript = text; else delete clip.referenceScript;
          const ssml = ssmls.get(clip.id);
          if (ssml) clip.ssml = ssml; else delete clip.ssml;
        }
      }
      // Recheck after asynchronous reads so two requests cannot start concurrent runs.
      if (!input.enqueue && hasWork(queue)) {
        res.status(409).json({ error: 'Another evaluation is running or queued. Add this test to the queue instead.' }); return;
      }
      const job = newEvaluation({ name: input.name, profile: input.profile, judges: settings.judges, clips, autoRetry: input.autoRetry }, !!input.enqueue);
      if (arena) job.arena = arena;
      if (input.voiceLabels?.some(label => !clips.some(clip => clip.voice === label.voice)))
        throw new Error('Voice gender labels must refer to evaluated voices.');
      if (input.voiceLabels) job.voiceLabels = input.voiceLabels;
      else if (input.arena) job.voiceLabels = arenaImport.labels(input.arena);
      if (input.enqueue) {
        await enqueueEvaluation(job);
        res.status(201).json(job);
        return;
      }
      const controller = new AbortController();
      queue.active = { job, controller };
      try { await store.saveJob(job); }
      catch (error) { queue.active = undefined; throw error; }
      void run(job, controller, credentials);
      res.status(201).json(job);
    } finally {
      if (input.enqueue) queue.queuedWrites--;
      void drainQueue(queue);
    }
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (changingJobs.has(id)) { res.status(409).json({ error: 'This evaluation is being changed.' }); return; }
    const queue = findWaiting(id);
    if (queue) {
      const { waiting } = queue;
      const index = waiting.findIndex(job => job.id === id);
      const [job] = waiting.splice(index, 1);
      const original = structuredClone(job);
      changingJobs.add(id);
      queue.queuedWrites++;
      job.status = 'cancelled';
      job.autoRetry = false; delete job.retryAfter;
      for (const result of evaluationResults(job)) {
        result.status = 'cancelled'; result.error = 'Cancelled before the queued test started.';
      }
      try {
        await store.saveJob(job);
        if (queue.saveRecovery?.jobId === id) { queue.saveRecovery = undefined; clearSaveRetryTimer(queue); }
        res.json({ status: 'cancelled' });
      }
      catch (error) {
        waiting.push(original); waiting.sort(queueOrderCompare); queue.paused = true;
        queue.error = `Queue paused: cancellation could not be saved. ${connection.redact(error)}`;
        console.error(queue.error); throw error;
      } finally { changingJobs.delete(id); queue.queuedWrites--; void drainQueue(queue); }
      return;
    }
    const active = findActive(id);
    if (!active) { res.status(409).json({ error: 'This evaluation is not running.' }); return; }
    active.job.autoRetry = false;
    active.controller.abort(); res.json({ status: 'cancelling' });
  });
  app.post(['/api/jobs/:id/resume', '/api/jobs/:id/retry'], async (req, res) => {
    const enqueue = req.path.endsWith('/retry');
    const input = z.object({
      consent: z.literal(true), retryAudioIssues: z.boolean().optional(), retryUnassessed: z.boolean().optional(), singleSpeakerFallback: z.literal(true).optional(), file: z.string().min(1).optional(), autoRetry: z.boolean().optional(),
    }).strict().refine(value => !(value.retryAudioIssues && value.retryUnassessed), 'Choose one retry mode.')
      .refine(value => !value.file || value.retryUnassessed, 'A file can only be selected when retrying unassessed inputs.').parse(req.body);
    const { retryAudioIssues, singleSpeakerFallback, file } = input;
    const retryUnassessed = input.retryUnassessed ?? (enqueue && !retryAudioIssues);
    const credentials = connection.current();
    const id = uuid.parse(req.params.id);
    if (changingJobs.has(id) || findActive(id) || findWaiting(id)) {
      res.status(409).json({ error: 'This test already has a running or queued evaluation/retry. Retry again after it finishes.' }); return;
    }
    changingJobs.add(id);
    let queue: Queue | undefined;
    try {
      const job = await store.read<Job>(path.join('jobs', `${id}.json`));
      queue = queueForJob(job);
      if (enqueue) queue.queuedWrites++;
      if (job.status === 'queued' || (!enqueue && hasWork(queue))) { res.status(409).json({ error: 'An evaluation is running or queued in this workspace. Use the queue controls or wait for it to finish.' }); return; }
      if (job.rubric !== RUBRIC_VERSION) { res.status(409).json({ error: 'The rubric changed. Start a new evaluation instead of mixing rubric versions.' }); return; }
      if (file && !job.clips.some(clip => clip.file === file)) {
        res.status(404).json({ error: 'The selected file does not belong to this evaluation.' }); return;
      }
      const selected: JudgeResult[] = retryUnassessed
        ? unassessedResults(job, file)
        : job.results.filter(r => retryAudioIssues ? retryableAudioIssue(r) : r.status !== 'completed');
      if (!selected.length) {
        res.status(409).json({ error: retryUnassessed ? 'No unassessed inputs remain for this selection.' : retryAudioIssues ? 'No completed assessments report a retryable missing-audio claim.' : 'All judge assessments have already completed.' }); return;
      }
      for (const clip of job.clips.filter(c => selected.some(r => r.clipId === c.id)))
        if (!await store.hasPcm(clip.id)) {
          res.status(409).json({ error: `Saved audio is unavailable for ${clip.file}. Import the original recording again.` }); return;
        }
      if (!enqueue && hasWork(queue)) { res.status(409).json({ error: 'Another evaluation is running or queued in this workspace. Wait for the queue to finish.' }); return; }
      if (singleSpeakerFallback) job.profile = { ...job.profile, singleSpeakerFallback: true };
      job.autoRetry = input.autoRetry ?? true;
      delete job.retryAfter;
      prepareRetry(job, selected);
      if (enqueue) {
        job.status = 'queued';
        await enqueueEvaluation(job);
        res.status(202).json(job);
        return;
      }
      job.status = 'running';
      const controller = new AbortController(); queue.active = { job, controller };
      try { await store.saveJob(job); }
      catch (error) { queue.active = undefined; throw error; }
      void run(job, controller, credentials, selected); res.json(job);
    } finally {
      changingJobs.delete(id);
      if (queue) {
        if (enqueue) queue.queuedWrites--;
        void drainQueue(queue);
      }
    }
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      console.error('API request failed: Invalid JSON body.');
      res.status(400).json({ error: 'Invalid JSON request body.' }); return;
    }
    console.error('API request failed:', connection.redact(error));
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      res.status(404).json({ error: 'The requested local recording or evaluation was not found.' }); return;
    }
    if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Audio upload exceeds the supported excerpt size.' }); return;
    }
    res.status(400).json({ error: connection.redact(error) });
  };
  return { app, errors, store, cancelActive: () => {
    for (const queue of allQueues) {
      queue.paused = true; clearSaveRetryTimer(queue); queue.active?.controller.abort();
    }
  } };
}
