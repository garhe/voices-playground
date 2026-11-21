import {
  SCRIPT_PROGRESS_CONTENT_TYPE, scriptGenerationResultSchema, scriptLocaleResultSchema,
  type ScriptGenerationRequest, type ScriptGenerationResult,
} from '../shared/scriptGeneration';

type LocaleResult = ScriptGenerationResult[number];
export const resultLocale = (result: LocaleResult) => 'script' in result ? result.script.locale : result.locale;
const canRetry = (result: LocaleResult) => 'error' in result && result.retryAfterMs !== undefined;

export async function generateScriptPreview(
  input: ScriptGenerationRequest,
  onProgress: (progress: { generated: number; failed: number }, results: ScriptGenerationResult) => void,
  signal?: AbortSignal,
): Promise<ScriptGenerationResult> {
  const response = await fetch('/api/script-generation/generate', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: SCRIPT_PROGRESS_CONTENT_TYPE },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(typeof body?.error === 'string' ? body.error : `Script generation failed (HTTP ${response.status}).`);
  }
  const byLocale = new Map<string, ScriptGenerationResult[number]>();
  const requested = new Set(input.locales.map(locale => locale.toLowerCase()));
  let generated = 0;
  const record = (result: ScriptGenerationResult[number]) => {
    const locale = resultLocale(result).toLowerCase();
    if (!requested.has(locale) || byLocale.has(locale)) throw new Error('The server returned an unexpected script locale.');
    byLocale.set(locale, result);
    if ('script' in result) generated++;
  };
  if (response.headers.get('Content-Type')?.startsWith(SCRIPT_PROGRESS_CONTENT_TYPE)) {
    if (!response.body) throw new Error('Script generation returned no progress stream.');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = (pending + value).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) record(scriptLocaleResultSchema.parse(JSON.parse(line)));
        if (lines.length) onProgress({ generated, failed: byLocale.size - generated }, [...byLocale.values()]);
      }
      if (pending) throw new Error('The script generation response ended in the middle of a result.');
    } finally {
      await reader.cancel();
    }
  } else {
    // Older servers return the full batch as JSON.
    for (const result of scriptGenerationResultSchema.parse(await response.json())) record(result);
  }
  return input.locales.map(locale => {
    const result = byLocale.get(locale.toLowerCase());
    if (!result) throw new Error('The script generation response ended before every locale reported a result.');
    return result;
  });
}

export type ScriptRetryProgress = { generated: number; failed: number; retrying: number; nextRetryMs?: number };

export async function regenerateLocalePreview(
  input: ScriptGenerationRequest, locale: string, signal: AbortSignal,
): Promise<Extract<LocaleResult, { script: unknown }>> {
  if (!input.locales.some(code => code.toLowerCase() === locale.toLowerCase())) throw new Error('That locale is not in the preview.');
  signal.throwIfAborted();
  const [replacement] = await generateScriptPreview({ ...input, locales: [locale] }, () => {}, signal);
  signal.throwIfAborted();
  if ('error' in replacement) throw new Error(replacement.error);
  return replacement;
}

export function mergeBatchResults(current: ScriptGenerationResult, batch: ScriptGenerationResult): ScriptGenerationResult {
  // Completed locales are never retried by the batch; keep any newer manual replacements.
  const completed = new Map(current.filter(result => 'script' in result).map(result => [resultLocale(result), result]));
  return batch.map(result => completed.get(resultLocale(result)) ?? result);
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function generateScriptsWithRetry(
  input: ScriptGenerationRequest,
  signal: AbortSignal,
  onUpdate: (progress: ScriptRetryProgress, results: ScriptGenerationResult) => void,
): Promise<void> {
  const latest = new Map<string, LocaleResult>();
  const update = (results: ScriptGenerationResult, nextRetryMs?: number) => {
    for (const result of results) latest.set(resultLocale(result).toLowerCase(), result);
    const ordered = input.locales.flatMap(locale => latest.get(locale.toLowerCase()) ?? []);
    const generated = ordered.filter(result => 'script' in result).length;
    const retrying = ordered.filter(canRetry).length;
    onUpdate({ generated, retrying, failed: ordered.length - generated - retrying, nextRetryMs }, ordered);
  };
  let locales = input.locales;
  let backoff = 1000;
  while (locales.length) {
    signal.throwIfAborted();
    const batch = await generateScriptPreview({ ...input, locales }, (_progress, results) => update(results), signal);
    const retryable = batch.filter(canRetry);
    locales = retryable.map(resultLocale);
    if (!locales.length) { update(batch); return; }
    const delay = Math.max(backoff, ...retryable.map(result => 'error' in result ? result.retryAfterMs ?? 0 : 0));
    update(batch, delay);
    await waitForRetry(delay, signal);
    backoff = Math.min(backoff * 2, 30_000);
    update([]);
  }
}
