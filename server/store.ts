import { access, appendFile, mkdir, readFile, rename, stat, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type Job, type Settings, type StoredClip } from '../shared/domain.js';

const SAVE_LOG_LIMIT = 1024 * 1024;
const errorCode = (error: unknown) => {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};
type SaveDiagnostic = { jobId: string } & (
  | { event: 'save-blocked' | 'save-recovered' | 'save-failed'; operation: 'write-temp' | 'rename'; code: string; attempt: number; elapsedMs: number }
  | ({ event: 'queue-paused' | 'queue-save-retry' } & QueueSaveState)
);
type QueueSaveState = { phase: 'starting' } | { phase: 'running'; checkpoint: 'saved' | 'memory-only' };

export class Store {
  private writes: Promise<void> = Promise.resolve();
  private diagnosticWrites: Promise<void> = Promise.resolve();
  constructor(readonly root: string, private readonly renameFile: typeof rename = rename) {}
  async init() {
    await mkdir(path.join(this.root, 'jobs'), { recursive: true });
    await mkdir(path.join(this.root, 'clips'), { recursive: true });
  }
  async read<T>(relative: string): Promise<T> {
    return JSON.parse(await readFile(path.join(this.root, relative), 'utf8')) as T;
  }
  async exists(relative: string) {
    try { await readFile(path.join(this.root, relative)); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  private logSaveDiagnostic(entry: SaveDiagnostic) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...entry });
    const file = path.join(this.root, 'save-diagnostics.jsonl');
    this.diagnosticWrites = this.diagnosticWrites.then(async () => {
      try {
        const info = await stat(file).catch(error => {
          if (errorCode(error) !== 'ENOENT') throw error;
          return undefined;
        });
        if (info && info.size >= SAVE_LOG_LIMIT) await rename(file, `${file}.1`);
        await appendFile(file, `${line}\n`, { mode: 0o600 });
      } catch (error) {
        console.error(`Could not write save diagnostics (${errorCode(error)}): ${line}`);
      }
    });
    return this.diagnosticWrites;
  }
  recordSavePause(jobId: string, state: QueueSaveState) {
    return this.logSaveDiagnostic({ event: 'queue-paused', jobId, ...state });
  }
  recordQueueSaveRetry(jobId: string, state: QueueSaveState) {
    return this.logSaveDiagnostic({ event: 'queue-save-retry', jobId, ...state });
  }
  async save(relative: string, value: unknown, jobId?: string) {
    const json = JSON.stringify(value, null, 2);
    const renameRetries = jobId ? 14 : 6;
    const write = this.writes.then(async () => {
      const destination = path.join(this.root, relative);
      const temporary = `${destination}.tmp`;
      const start = performance.now();
      const report = async (event: 'save-blocked' | 'save-recovered' | 'save-failed', operation: 'write-temp' | 'rename', code: string, attempt: number) => {
        if (jobId) await this.logSaveDiagnostic({ event, jobId, operation, code, attempt, elapsedMs: Math.round(performance.now() - start) });
      };
      try { await writeFile(temporary, json, { mode: 0o600 }); }
      catch (error) {
        await report('save-failed', 'write-temp', errorCode(error), 1);
        throw error;
      }
      let blockedCode = '';
      for (let attempt = 0; ; attempt++) {
        try { await this.renameFile(temporary, destination); }
        catch (error) {
          const code = errorCode(error);
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= renameRetries) {
            await report('save-failed', 'rename', code, attempt + 1);
            throw error;
          }
          if (!blockedCode) await report('save-blocked', 'rename', code, attempt + 1);
          blockedCode = code;
          console.warn(`Atomic save temporarily blocked (${code}); retrying local rename ${attempt + 1}/${renameRetries}.`);
          await delay(Math.min(50 * 2 ** attempt, 1000));
          continue;
        }
        if (blockedCode) await report('save-recovered', 'rename', blockedCode, attempt + 1);
        break;
      }
    });
    this.writes = write.catch(error => { console.error('Persistence write failed:', error.message); });
    return write;
  }
  async jobs(): Promise<Job[]> {
    const names = (await readdir(path.join(this.root, 'jobs'))).filter(n => n.endsWith('.json'));
    const jobs = await Promise.all(names.map(n => this.read<Job>(path.join('jobs', n))));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  jobProjections<T>(project: (job: Job) => T) {
    type Entry = { fingerprint: string; value: T };
    let cached = new Map<string, Entry>();
    let pending: Promise<T[]> | undefined;
    const scan = async () => {
      const next = new Map<string, Entry>();
      const names = await readdir(path.join(this.root, 'jobs'));
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const relative = path.join('jobs', name);
        try {
          const info = await stat(path.join(this.root, relative), { bigint: true });
          // On Windows a read can change ctime, even when the file contents did not change.
          const changeTime = process.platform === 'win32' ? info.birthtimeNs : info.ctimeNs;
          const fingerprint = `${info.ino}:${info.size}:${info.mtimeNs}:${changeTime}`;
          const previous = cached.get(name);
          next.set(name, previous?.fingerprint === fingerprint ? previous : {
            fingerprint, value: project(await this.read<Job>(relative)),
          });
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          // A report may be deleted between listing and reading the file.
        }
      }
      cached = next;
      return [...next.values()].map(entry => entry.value);
    };
    return () => pending ??= scan().finally(() => { pending = undefined; });
  }
  saveJob(job: Job) { return this.save(path.join('jobs', `${job.id}.json`), job, job.id); }
  settings() { return this.read<Settings>('settings.json'); }
  remove(relative: string) { return unlink(path.join(this.root, relative)); }
  clip(id: string) { return this.read<StoredClip>(path.join('clips', `${id}.json`)); }
  pcm(id: string) { return readFile(path.join(this.root, 'clips', `${id}.pcm`)); }
  async hasPcm(id: string) {
    try { await access(path.join(this.root, 'clips', `${id}.pcm`)); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async saveClip(clip: StoredClip, pcm: Buffer) {
    await writeFile(path.join(this.root, 'clips', `${clip.id}.pcm`), pcm, { flag: 'wx', mode: 0o600 });
    await this.save(path.join('clips', `${clip.id}.json`), clip);
  }
}
