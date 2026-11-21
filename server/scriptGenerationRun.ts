import { randomUUID } from 'node:crypto';
import type { GeneratedScript, ScriptGenerationRequest, ScriptGenerationRun, ScriptLocaleOption } from '../shared/scriptGeneration.js';

const retryable = (result: ScriptGenerationRun['results'][number]) => 'error' in result && result.retryAfterMs !== undefined;
const localeOf = (result: ScriptGenerationRun['results'][number]) => 'script' in result ? result.script.locale : result.locale;

export class ScriptGenerationRuns {
  current?: ScriptGenerationRun;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private regeneration?: AbortController;

  constructor(
    private readonly prepare: (input: ScriptGenerationRequest) => Promise<{
      locales: ScriptLocaleOption[];
      generate: (locale: ScriptLocaleOption, signal: AbortSignal) => Promise<GeneratedScript>;
    }>,
    private readonly redact: (error: unknown) => string,
    private readonly retryDelay: (error: unknown) => number | undefined,
  ) {}

  get active() {
    return !!this.regeneration || this.current?.state === 'running' || this.current?.state === 'pausing';
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

  resume(run: ScriptGenerationRun) {
    run.state = 'running';
    run.error = undefined;
    this.launch(run);
  }

  canRegenerate(run: ScriptGenerationRun, locale: string) {
    if (this.regeneration || run.state === 'pausing') return false;
    const result = run.results.find(item => localeOf(item) === locale);
    return !!result && !(run.state === 'running' && retryable(result));
  }

  private record(run: ScriptGenerationRun, result: ScriptGenerationRun['results'][number]) {
    const byLocale = new Map(run.results.map(item => [localeOf(item).toLowerCase(), item]));
    byLocale.set(localeOf(result).toLowerCase(), result);
    run.results = run.input.locales.flatMap(locale => byLocale.get(locale.toLowerCase()) ?? []);
    if ('script' in result) run.firstLocale ??= result.script.locale;
  }

  private launch(run: ScriptGenerationRun, backoff = 1000) {
    void this.runWave(run, backoff).catch(error => {
      run.error = this.redact(error);
      run.activeLocales = [];
      run.state = 'failed';
    });
  }

  private async runWave(run: ScriptGenerationRun, backoff: number) {
    const { locales, generate } = await this.prepare(run.input);
    const settled = new Set(run.results.filter(result => !retryable(result)).map(result => localeOf(result).toLowerCase()));
    const pending = locales.filter(locale => !settled.has(locale.value.toLowerCase()));
    for (let index = 0; index < pending.length && run.state === 'running'; index += 3) {
      const group = pending.slice(index, index + 3);
      run.activeLocales = group.map(locale => locale.value);
      await Promise.all(group.map(async locale => {
        try {
          const script = await generate(locale, new AbortController().signal);
          this.record(run, { script });
        } catch (error) {
          const retryAfterMs = this.retryDelay(error);
          this.record(run, { locale: locale.value, error: this.redact(error), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
        } finally {
          run.activeLocales = run.activeLocales.filter(code => code !== locale.value);
        }
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
        this.launch(run, Math.min(backoff * 2, 30_000));
      }, delay);
      this.retryTimer.unref();
    }
  }

  regenerate(run: ScriptGenerationRun, locale: string) {
    const controller = new AbortController();
    this.regeneration = controller;
    run.regeneration = { locale, state: 'running', message: 'Regenerating…' };
    void (async () => {
      try {
        const { locales, generate } = await this.prepare({ ...run.input, locales: [locale] });
        controller.signal.throwIfAborted();
        const script = await generate(locales[0], controller.signal);
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

  stopRegeneration() { this.regeneration?.abort(); }
}
