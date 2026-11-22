import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GeneratedScript, ScriptGenerationRequest, ScriptGenerationRun, ScriptLocaleOption } from '../shared/scriptGeneration.js';

const retryable = (result: ScriptGenerationRun['results'][number]) => 'error' in result && result.retryAfterMs !== undefined;
const localeOf = (result: ScriptGenerationRun['results'][number]) => 'script' in result ? result.script.locale : result.locale;
const initialBackoff = 1000;
const nextBackoff = (backoff: number) => Math.min(backoff * 2, 30_000);
type GenerateLocale = (locale: ScriptLocaleOption, signal: AbortSignal, previousError?: string, previousScript?: GeneratedScript) => Promise<GeneratedScript>;
export const batchIsActive = (state: ScriptGenerationRun['state']) =>
  state === 'running' || state === 'pausing' || state === 'stopping' || state === 'cancelling';

export class ScriptGenerationRuns {
  current?: ScriptGenerationRun;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private wave?: AbortController;
  private regeneration?: AbortController;

  constructor(
    private readonly prepare: (input: ScriptGenerationRequest) => Promise<{
      locales: ScriptLocaleOption[];
      generate: GenerateLocale;
    }>,
    private readonly redact: (error: unknown) => string,
    private readonly retryDelay: (error: unknown) => number | undefined,
  ) {}

  get active() {
    return !!this.regeneration || (this.current !== undefined && batchIsActive(this.current.state));
  }

  start(input: ScriptGenerationRequest) {
    const run: ScriptGenerationRun = { id: randomUUID(), input, state: 'running', results: [], activeLocales: [] };
    this.current = run;
    this.launch(run);
  }

  pause(run: ScriptGenerationRun) {
    run.state = 'pausing';
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      run.retryAt = undefined;
      run.state = 'paused';
    }
  }

  stop(run: ScriptGenerationRun, cancel: boolean) {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      run.retryAt = undefined;
    }
    if (cancel) this.stopRegeneration();
    run.state = this.wave ? (cancel ? 'cancelling' : 'stopping') : (cancel ? 'cancelled' : 'paused');
    this.wave?.abort();
  }

  resume(run: ScriptGenerationRun) {
    run.state = 'running';
    run.error = undefined;
    this.launch(run);
  }

  canRegenerate(run: ScriptGenerationRun, locale: string) {
    if (this.regeneration || (batchIsActive(run.state) && run.state !== 'running')) return false;
    const result = run.results.find(item => localeOf(item) === locale);
    return !!result && !(run.state === 'running' && retryable(result));
  }

  private record(run: ScriptGenerationRun, result: ScriptGenerationRun['results'][number]) {
    const byLocale = new Map(run.results.map(item => [localeOf(item).toLowerCase(), item]));
    byLocale.set(localeOf(result).toLowerCase(), result);
    run.results = run.input.locales.flatMap(locale => byLocale.get(locale.toLowerCase()) ?? []);
    if ('script' in result) run.firstLocale ??= result.script.locale;
  }

  private launch(run: ScriptGenerationRun, backoff = initialBackoff) {
    const controller = new AbortController();
    this.wave = controller;
    void this.runWave(run, backoff, controller.signal).catch(error => {
      if (!controller.signal.aborted) {
        run.error = this.redact(error);
        run.activeLocales = [];
        run.state = 'failed';
      }
    }).finally(() => {
      this.wave = undefined;
      if (controller.signal.aborted) run.state = run.state === 'cancelling' ? 'cancelled' : 'paused';
    });
  }

  private async runWave(run: ScriptGenerationRun, backoff: number, signal: AbortSignal) {
    const { locales, generate } = await this.prepare(run.input);
    signal.throwIfAborted();
    const byLocale = new Map(run.results.map(result => [localeOf(result).toLowerCase(), result]));
    const pending = locales.filter(locale => {
      const result = byLocale.get(locale.value.toLowerCase());
      return !result || retryable(result);
    });
    for (let index = 0; index < pending.length && run.state === 'running'; index += 3) {
      const group = pending.slice(index, index + 3);
      run.activeLocales = group.map(locale => locale.value);
      await Promise.all(group.map(async locale => {
        try {
          const previous = byLocale.get(locale.value.toLowerCase());
          const script = await generate(locale, signal, previous && 'error' in previous ? previous.error : undefined);
          if (!signal.aborted) this.record(run, { script });
        } catch (error) {
          if (signal.aborted) return;
          const retryAfterMs = this.retryDelay(error);
          this.record(run, { locale: locale.value, error: this.redact(error), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
        } finally {
          run.activeLocales = run.activeLocales.filter(code => code !== locale.value);
        }
        if (signal.aborted) return;
      }));
    }
    const retries = run.results.flatMap(result => 'error' in result && result.retryAfterMs !== undefined ? [result.retryAfterMs] : []);
    if (run.results.length === run.input.locales.length && !retries.length) run.state = 'completed';
    else if (run.state === 'pausing') run.state = 'paused';
    else {
      const delay = Math.max(backoff, ...retries);
      run.retryAt = Date.now() + delay;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        run.retryAt = undefined;
        this.launch(run, nextBackoff(backoff));
      }, delay);
      this.retryTimer.unref();
    }
  }

  regenerate(run: ScriptGenerationRun, locale: string) {
    const previous = run.results.find(item => localeOf(item) === locale);
    const previousScript = previous && 'script' in previous ? previous.script : undefined;
    const controller = new AbortController();
    this.regeneration = controller;
    run.regeneration = { locale, state: 'running', message: 'Regenerating…' };
    void (async () => {
      try {
        const { locales, generate } = await this.prepare({ ...run.input, locales: [locale] });
        const script = await this.regenerateWithRetry(locales[0], generate, controller.signal, previousScript, message => {
          run.regeneration = { locale, state: 'running', message };
        });
        controller.signal.throwIfAborted();
        this.record(run, { script });
        run.regeneration = { locale, state: 'done', message: 'Preview regenerated.' };
      } catch (error) {
        run.regeneration = controller.signal.aborted
          ? { locale, state: 'done', message: 'Regeneration stopped. Preview unchanged.' }
          : { locale, state: 'error', message: `Could not regenerate: ${this.redact(error)} Preview unchanged.` };
      } finally {
        this.regeneration = undefined;
      }
    })();
  }

  private async regenerateWithRetry(
    locale: ScriptLocaleOption,
    generate: GenerateLocale,
    signal: AbortSignal,
    previousScript: GeneratedScript | undefined,
    update: (message: string) => void,
  ): Promise<GeneratedScript> {
    let backoff = initialBackoff;
    let previousError: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      update('Regenerating…');
      try {
        const script = await generate(locale, signal, previousError, previousScript);
        signal.throwIfAborted();
        return script;
      } catch (error) {
        signal.throwIfAborted();
        const retryAfterMs = this.retryDelay(error);
        if (retryAfterMs === undefined) throw error;
        previousError = this.redact(error);
        const delay = Math.max(backoff, retryAfterMs);
        update(`${previousError} Retrying in ${Math.ceil(delay / 1000)} s.`);
        await sleep(delay, undefined, { signal });
        backoff = nextBackoff(backoff);
      }
    }
  }

  stopRegeneration() { this.regeneration?.abort(); }
}
