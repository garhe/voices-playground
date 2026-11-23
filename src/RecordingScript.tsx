import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  assignRecordingIds, DEFAULT_RECORDING_ID_START, DEFAULT_RECORDING_ROLE, MAX_RECORDING_BRIEF_LENGTH,
  MAX_RECORDING_DOMAINS, MAX_RECORDING_DOMAIN_LENGTH, MAX_RECORDING_ROWS, MAX_RECORDING_TARGET_CHARACTERS, RECORDING_EXPORT_BATCH_SIZE,
  parseRecordingDomains, recordingAgentGenderSchema, recordingBatchResultSchema, recordingBatchRunSchema, recordingExportSchema, recordingGenerateSchema, recordingIdStartSchema, recordingScriptFileName, recordingScriptSchema, recordingScriptText,
  RECORDING_AGENT_ACKNOWLEDGMENTS, RECORDING_BATCH_CONCURRENCY, RECORDING_BATCH_START_CONCURRENCY, RECORDING_DATE_TIME_DETAILS, RECORDING_LOCAL_SPEECH,
  recordingToneHeader, recordingVariantKey, recordingVariants, type RecordingAgentGender, type RecordingExportResult,
  usesRecordingBatches, type RecordingBatchRun, type RecordingGenerateRequest, type RecordingScript as RecordingScriptData, type RecordingVariant,
} from '../shared/recordingScript';
import type { ScriptLocaleOption } from '../shared/scriptGeneration';
import type { AppRequest, AzureSettingsTarget } from './AzureSettings';
import { RecordingBatchScheduler } from './recordingBatchScheduler';

const BRIEF_STORAGE_KEY = 'voices-playground.recording-script-brief.v1';
const DOMAINS_STORAGE_KEY = 'voices-playground.recording-script-domains.v1';
const TOTAL_CHARACTERS_STORAGE_KEY = 'voices-playground.recording-script-total-characters.v1';
const AGENT_GENDER_STORAGE_KEY = 'voices-playground.recording-script-agent-gender.v1';
const BATCH_RUN_STORAGE_KEY = 'voices-playground.recording-script-batch-run.v1';
const DEFAULTS_STORAGE_KEY = 'voices-playground.recording-script-defaults.v1';
const DEFAULT_LOCALES = ['en-US'];
const DEFAULT_RECORDING_DOMAINS = 'Online Shopping, Food Delivery, Travel, Hospitality, Telecom, Banking, Financial Services, Insurance, Restaurant, Tour, Medical, Spa';
const GENDER_LABELS = { female: 'Female', male: 'Male' };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unexpected recording script error.';

export const DEFAULT_RECORDING_BRIEF = `Recording script: inbound customer-service phone calls

Scope and variety
- Use the selected locale, Domains field, and optional Agent characters per locale field. Start with 1 call per domain and 8 turns per call. To reach the minimum, add meaningful exchanges or distinct calls, keeping each call between 8 and 20 turns and balancing Agent dialogue across domains. Count only spoken Agent lines, including spaces and punctuation; keep natural Customer replies without counting them. Do not pad with repetition.
- Vary the incident, underlying cause, investigation, and resolution within each domain across calls, locales, and runs. When earlier cases are available, avoid them. Don't recycle a case by changing only names, dates, amounts, or routes. Use a short, descriptive scenario label for each call.

Call flow and service assurance
- The Customer speaks first, Customer and Agent alternate, and the Agent closes. Let the Customer's issue, impact, and emotion emerge naturally. Cover necessary verification, investigation, a concrete fix or actionable next step, and confirmation. Thank the caller before closing. Confirm that relevant details match without repeating their full name, address, or phone number; read back only what needs checking. Never promise an unverified outcome.
- ${RECORDING_AGENT_ACKNOWLEDGMENTS}
- Use at most 1 brief greeting across the calls for the locale. If either speaker asks a question, end their utterance with that question.

Spoken delivery
- ${RECORDING_LOCAL_SPEECH}
- Follow the locale's grammatical gender and forms of address. Keep the fictional Customer and Agent's genders consistent within each call when relevant. In every turn, use the correct agreement for the current speaker, the person being addressed, and anyone being referred to, as the language requires. Check pronouns, verb forms, adjectives, participles, and titles where applicable. When gender is unspecified and a natural neutral form exists, use it rather than guessing. Do not add gender labels or explanations to the spoken dialogue.
- Include at least 2 audible hesitations per 2 turns, using local fillers or brief pauses when someone is checking, thinking, or recalling a detail. Place at least half of the hesitations mid-sentence or between sentences inside an utterance, not at the start. Don't interrupt a clear explanation or add stage directions just to meet the count.
- Keep each turn concise. As a guide where word counts are natural, use 5–20 words for Customer turns and 5–30 for Agent turns. Match each Agent turn to an appropriate tone: Apologetic, Reassuring, Empathetic, Generous, Attentive, Confident, Patient, Grateful, or Cheerful. Vary tones naturally.

Synthetic details and formatting
- ${RECORDING_DATE_TIME_DETAILS}
- Use realistic but fictional localized names, dates, street addresses, and full phone numbers where relevant. Vary them across calls and use reserved fictional number ranges where available. Never use Juniper, 晴禾, or 10/15/2026.
- In the dialogue, write all numbers as digits for both speakers, including dates, addresses, phone numbers, durations, amounts, and flight numbers. Use local formatting and do not spell the digits out.
- Whenever reading back a flight route, give the specific airport name at both endpoints as spoken locally, including the city when natural, and follow each name with its matching uppercase 3-letter IATA code in parentheses. Format example only: Hanoi Noi Bai (HAN) to Tokyo Narita (NRT). Never use a city alone or a bare code, and vary the routes.`;

function loadValue(key: string, fallback: string): string {
  try { return window.localStorage.getItem(key) || fallback; }
  catch { return fallback; }
}

type LocaleResult = { script: RecordingScriptData } | { error: string };
type GenerationProgress = {
  total: number;
  completed: number;
  batches?: Record<string, { label: string; characters: number; batches: number; target: number }>;
};

export function RecordingGenerationProgress({ total, completed, batches }: GenerationProgress) {
  // The backend can still be filling a domain quota after the total character target is met.
  const activeBatches = Object.entries(batches ?? {});
  const partial = activeBatches.reduce((sum, [, batch]) => sum + Math.min(batch.characters / batch.target, 0.999), 0);
  const progress = (completed + partial) / total * 100;
  const percent = completed === total ? 100 : Math.min(Math.floor(progress * 10) / 10, 99.9);
  const counts = `${completed} of ${total} recording scripts generated.`;
  return <div className="recording-generation-progress">
    <div className="recording-progress-caption" role="status">
      <span>{counts}</span><strong>{percent}%</strong>
    </div>
    <div className="progress-track" role="progressbar" aria-label="Recording script generation"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%. ${counts}`}>
      <div style={{ width: `${progress}%` }} />
    </div>
    {activeBatches.sort(([, a], [, b]) => b.characters - a.characters).map(([key, batch]) => <p key={key} className="muted" role="status">
      {batch.label}: {batch.characters.toLocaleString()} / {batch.target.toLocaleString()} Agent characters · {batch.batches} batches saved
    </p>)}
  </div>;
}

const savedDefaultsSchema = z.object({
  prompt: z.string(), domainsText: z.string(), totalCharactersText: z.string(),
  agentGenders: z.array(recordingAgentGenderSchema), recordedRole: z.string(), idStart: z.string(),
  fileName: z.string(), localeSearch: z.string(), selection: z.array(z.string()), directory: z.string(),
});

function readSavedDefaults() {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(DEFAULTS_STORAGE_KEY);
    return stored === null ? {} : { values: savedDefaultsSchema.parse(JSON.parse(stored)) };
  } catch {
    return { error: 'Could not load saved Recording script defaults. Save the current fields to replace them.' };
  }
}

export function RecordingScript({ request, active, connected, speechConfigured, deployment, azureBusy, onConfigure }: {
  request: AppRequest;
  active: boolean;
  connected?: boolean;
  speechConfigured?: boolean;
  deployment?: string;
  azureBusy: boolean;
  onConfigure: (target: AzureSettingsTarget) => void;
}) {
  const [initialDefaults] = useState(readSavedDefaults);
  const defaults = initialDefaults.values;
  const [defaultsStatus, setDefaultsStatus] = useState<{ message: string; error?: boolean } | undefined>(
    () => initialDefaults.error ? { message: initialDefaults.error, error: true } : undefined,
  );
  const [prompt, setPrompt] = useState(() => defaults?.prompt ?? loadValue(BRIEF_STORAGE_KEY, DEFAULT_RECORDING_BRIEF));
  const [domainsText, setDomainsText] = useState(() => defaults?.domainsText ?? loadValue(DOMAINS_STORAGE_KEY, DEFAULT_RECORDING_DOMAINS));
  const [totalCharactersText, setTotalCharactersText] = useState(() => defaults?.totalCharactersText ?? loadValue(TOTAL_CHARACTERS_STORAGE_KEY, ''));
  const [agentGenders, setAgentGenders] = useState<RecordingAgentGender[]>(() => {
    if (defaults) return defaults.agentGenders;
    const stored = loadValue(AGENT_GENDER_STORAGE_KEY, '').split(',');
    return recordingAgentGenderSchema.options.filter(gender => stored.includes(gender));
  });
  const [recordedRole, setRecordedRole] = useState(defaults?.recordedRole ?? DEFAULT_RECORDING_ROLE);
  const [idStart, setIdStart] = useState(defaults?.idStart ?? DEFAULT_RECORDING_ID_START);
  const [fileName, setFileName] = useState(defaults?.fileName ?? 'Recording_script');
  const [catalog, setCatalog] = useState<ScriptLocaleOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [localeError, setLocaleError] = useState('');
  const [localeSearch, setLocaleSearch] = useState(defaults?.localeSearch ?? '');
  const [selection, setSelection] = useState<string[] | undefined>(defaults?.selection);
  const [results, setResults] = useState<{ order: RecordingVariant[]; byVariant: Record<string, LocaleResult>; recordedRole: string }>();
  const [generating, setGenerating] = useState<string[]>();
  const [batchScheduling, setBatchScheduling] = useState<{ limit: number; cooldownUntil: number }>();
  const [runProgress, setRunProgress] = useState<GenerationProgress>();
  const [savedRun, setSavedRun] = useState<RecordingBatchRun>();
  const [generationError, setGenerationError] = useState('');
  const [directory, setDirectory] = useState(defaults?.directory ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<RecordingExportResult>();
  const [saveError, setSaveError] = useState('');
  const [copied, setCopied] = useState<string>();
  const generation = useRef<AbortController>(undefined);
  const catalogRequest = useRef<AbortController>(undefined);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(BATCH_RUN_STORAGE_KEY);
      if (saved) setSavedRun(recordingBatchRunSchema.parse(JSON.parse(saved)));
    } catch { setGenerationError('Could not read the saved recording batch run. Start a new run to replace it.'); }
  }, []);

  useEffect(() => {
    try {
      if (prompt === DEFAULT_RECORDING_BRIEF) window.localStorage.removeItem(BRIEF_STORAGE_KEY);
      else window.localStorage.setItem(BRIEF_STORAGE_KEY, prompt);
    } catch { /* Brief drafts are a convenience; generation still works without browser storage. */ }
  }, [prompt]);

  useEffect(() => {
    try {
      if (domainsText === DEFAULT_RECORDING_DOMAINS) window.localStorage.removeItem(DOMAINS_STORAGE_KEY);
      else window.localStorage.setItem(DOMAINS_STORAGE_KEY, domainsText);
      if (!totalCharactersText) window.localStorage.removeItem(TOTAL_CHARACTERS_STORAGE_KEY);
      else window.localStorage.setItem(TOTAL_CHARACTERS_STORAGE_KEY, totalCharactersText);
      if (agentGenders.length) window.localStorage.setItem(AGENT_GENDER_STORAGE_KEY, agentGenders.join(','));
      else window.localStorage.removeItem(AGENT_GENDER_STORAGE_KEY);
    } catch { /* These inputs are conveniences; generation still works without browser storage. */ }
  }, [domainsText, totalCharactersText, agentGenders]);

  const loadLocales = useCallback(async (refresh: boolean) => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogLoading(true); setLocaleError('');
    try {
      const options = await request<ScriptLocaleOption[]>(`/api/script-generation/locales${refresh ? '?refresh=1' : ''}`, undefined, 'GET', controller.signal);
      if (controller.signal.aborted) return;
      const available = new Set(options.map(option => option.value));
      setCatalog(options);
      setSelection(previous => (previous ?? DEFAULT_LOCALES).filter(code => available.has(code)));
    } catch (error) {
      if (!controller.signal.aborted) { setCatalog([]); setLocaleError(errorText(error)); }
    } finally { if (!controller.signal.aborted) setCatalogLoading(false); }
  }, [request]);

  useEffect(() => {
    if (!active) return;
    if (!speechConfigured) { setCatalog([]); setCatalogLoading(false); setLocaleError(''); return; }
    void loadLocales(false);
    return () => catalogRequest.current?.abort();
  }, [active, loadLocales, speechConfigured]);

  useEffect(() => () => generation.current?.abort(), []);

  const locales = selection ?? [];
  const labels = useMemo(() => new Map(catalog.map(option => [option.value, option.label])), [catalog]);
  const options = catalog.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(localeSearch.trim().toLowerCase()));
  const idStartCheck = recordingIdStartSchema.safeParse(idStart);
  const numbered = useMemo(() => {
    if (!results || !idStartCheck.success) return [];
    const scripts = results.order.flatMap(target => {
      const result = results.byVariant[recordingVariantKey(target)];
      return result && 'script' in result ? [result.script] : [];
    });
    return assignRecordingIds(scripts, idStartCheck.data, results.recordedRole);
  }, [results, idStartCheck.success, idStartCheck.data]);
  const numberedByVariant = new Map(numbered.map(script => [recordingVariantKey(script), script]));
  const targets = recordingVariants(locales, agentGenders);
  const ready = !!connected && !!deployment && !!speechConfigured;
  const busy = !!generating || saving;

  function saveDefaults() {
    try {
      window.localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify({
        prompt, domainsText, totalCharactersText, agentGenders, recordedRole, idStart, fileName, localeSearch,
        selection: selection ?? DEFAULT_LOCALES, directory,
      }));
      setDefaultsStatus({ message: 'Current fields saved as defaults in this browser.' });
    } catch {
      setDefaultsStatus({ message: 'Could not save defaults. Check that browser storage is enabled.', error: true });
    }
  }

  function generationInput(target: RecordingVariant, role: string) {
    return recordingGenerateSchema.safeParse({
      ...target, prompt, recordedRole: role, domains: parseRecordingDomains(domainsText),
      totalCharacters: totalCharactersText.trim() ? Number(totalCharactersText) : undefined, consent: true,
    });
  }

  async function generateLocale(input: RecordingGenerateRequest, signal: AbortSignal, runId: string | undefined,
    scheduler: RecordingBatchScheduler | undefined, isPaused: () => boolean, paired?: true): Promise<LocaleResult | undefined> {
    try {
      let script: RecordingScriptData;
      if (runId && scheduler && usesRecordingBatches(input)) {
        const key = recordingVariantKey(input);
        while (true) {
          signal.throwIfAborted();
          const progress = await scheduler.request(async () => {
            signal.throwIfAborted();
            setGenerating(current => [...(current ?? []), key]);
            try {
              return recordingBatchResultSchema.parse(await request<unknown>('/api/recording-script/batch', { runId, input, paired }, 'POST', signal));
            } finally { setGenerating(current => current?.filter(activeKey => activeKey !== key)); }
          });
          signal.throwIfAborted();
          if (progress.done) { script = progress.script; break; }
          const batch = { label: variantLabel(input), characters: progress.characters, batches: progress.batches, target: input.totalCharacters };
          setRunProgress(current => current && { ...current, batches: { ...current.batches, [key]: batch } });
          if (isPaused()) return;
        }
      } else {
        script = recordingScriptSchema.parse(await request<unknown>('/api/recording-script/generate', input, 'POST', signal));
      }
      if (recordingVariantKey(script) !== recordingVariantKey(input)) throw new Error('The server returned a script for a different locale or Agent gender.');
      return { script };
    } catch (error) {
      signal.throwIfAborted();
      if (isPaused()) return;
      return { error: errorText(error) };
    }
  }

  async function run(targets: RecordingVariant[], input: RecordingGenerateRequest, replace: boolean, runId?: string) {
    if (generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    setGenerating([]);
    setGenerationError(''); setSaved(undefined); setSaveError('');
    setRunProgress({ total: targets.length, completed: 0 });
    const byVariant: Record<string, LocaleResult> = replace ? {} : { ...results?.byVariant };
    if (replace) setResults({ order: targets, byVariant: {}, recordedRole: input.recordedRole });
    const targetKeys = new Set(targets.map(recordingVariantKey));
    let paused = false;
    const concurrency = runId ? Math.min(targets.length, RECORDING_BATCH_CONCURRENCY) : 1;
    const scheduler = runId ? new RecordingBatchScheduler(concurrency,
      (limit, cooldownUntil) => setBatchScheduling({ limit, cooldownUntil })) : undefined;
    const stopScheduling = () => scheduler?.close();
    controller.signal.addEventListener('abort', stopScheduling, { once: true });
    const queue = targets.values();
    async function worker() {
      for (const target of queue) {
        if (paused) return;
        controller.signal.throwIfAborted();
        const key = recordingVariantKey(target);
        const siblingKey = target.agentGender && recordingVariantKey({
          locale: target.locale, agentGender: target.agentGender === 'female' ? 'male' : 'female',
        });
        const paired = scheduler && siblingKey && targetKeys.has(siblingKey) ? true : undefined;
        const other = !paired && siblingKey && byVariant[siblingKey];
        const previousScenarios = other && 'script' in other ? [...new Set(other.script.rows.map(row => row.scenario))] : input.previousScenarios;
        if (!scheduler) setGenerating(current => [...(current ?? []), key]);
        const result = await generateLocale({ ...input, locale: target.locale, agentGender: target.agentGender, previousScenarios },
          controller.signal, runId, scheduler, () => paused, paired);
        if (!scheduler) setGenerating(current => current?.filter(activeKey => activeKey !== key));
        if (!result) return;
        byVariant[key] = result;
        setResults(previous => previous && { ...previous, byVariant: { ...previous.byVariant, [key]: result } });
        if ('script' in result) setRunProgress(current => {
          if (!current) return current;
          const batches = { ...current.batches };
          delete batches[key];
          return { ...current, completed: current.completed + 1, batches };
        });
        if (runId && 'error' in result) {
          paused = true;
          scheduler?.close();
          setGenerationError('Batch run paused. Resume the saved run to retry without losing completed batches.');
          return;
        }
      }
    }
    try {
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    } catch (error) {
      if (!controller.signal.aborted) setGenerationError(errorText(error));
    } finally {
      controller.signal.removeEventListener('abort', stopScheduling);
      scheduler?.close();
      setBatchScheduling(undefined);
      if (generation.current === controller) generation.current = undefined;
      setGenerating(undefined);
    }
  }

  function startRun(targets: RecordingVariant[], input: RecordingGenerateRequest, replace: boolean) {
    if (!usesRecordingBatches(input)) { void run(targets, input, replace); return; }
    if (savedRun && !window.confirm('Start a new batch run? It will replace the previous run in the Resume batch run button.')) return;
    try {
      const next = { runId: crypto.randomUUID(), targets, input };
      window.localStorage.setItem(BATCH_RUN_STORAGE_KEY, JSON.stringify(next));
      setSavedRun(next);
      void run(targets, input, replace, next.runId);
    } catch { setGenerationError('Could not save this batch run in your browser. Enable local storage before starting a large script.'); }
  }

  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || azureBusy) return;
    const check = generationInput(targets[0] ?? { locale: 'en-US' }, recordedRole);
    if (!check.success) { setGenerationError(check.error.issues[0].message); return; }
    if (!idStartCheck.success) { setGenerationError(idStartCheck.error.issues[0].message); return; }
    if (!locales.length) { setGenerationError('Select at least one locale.'); return; }
    startRun(targets, check.data, true);
  }

  function regenerateVariant(target: RecordingVariant, role: string) {
    const check = generationInput(target, role);
    if (!check.success) { setGenerationError(check.error.issues[0].message); return; }
    const other = target.agentGender && results?.byVariant[recordingVariantKey({
      locale: target.locale, agentGender: target.agentGender === 'female' ? 'male' : 'female',
    })];
    const previousScenarios = other && 'script' in other ? [...new Set(other.script.rows.map(row => row.scenario))] : undefined;
    startRun([target], { ...check.data, previousScenarios }, false);
  }

  function variantLabel({ locale, agentGender }: RecordingVariant) {
    const label = labels.get(locale) ?? locale;
    return agentGender ? `${label} · ${GENDER_LABELS[agentGender]} Agent` : label;
  }

  async function copy(script: RecordingScriptData) {
    try {
      await navigator.clipboard.writeText(recordingScriptText(script, results?.recordedRole ?? ''));
      setCopied(recordingVariantKey(script));
    } catch { setCopied(undefined); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!results || !numbered.length || busy) return;
    setSaving(true); setSaved(undefined); setSaveError('');
    const savedResults: RecordingExportResult = [];
    try {
      for (let index = 0; index < numbered.length;) {
        const limit = numbered[index].rows.length > MAX_RECORDING_ROWS ? 1 : RECORDING_EXPORT_BATCH_SIZE;
        const scripts = [numbered[index++]];
        while (scripts.length < limit && index < numbered.length && numbered[index].rows.length <= MAX_RECORDING_ROWS)
          scripts.push(numbered[index++]);
        const input = recordingExportSchema.parse({
          directory: directory.trim().replace(/^"(.*)"$/, '$1'), name: fileName, recordedRole: results.recordedRole,
          scripts,
        });
        savedResults.push(...await request<RecordingExportResult>('/api/recording-script/save', input));
        setSaved([...savedResults]);
      }
    } catch (error) { setSaveError(errorText(error)); }
    finally { setSaving(false); }
  }

  const toneHeader = recordingToneHeader(results?.recordedRole ?? recordedRole);
  return <div className="recording-script">
    {!ready && <div className="callout azure-settings-prompt">
      <span>Complete these Azure settings to generate recording scripts.</span>
      <div className="settings-shortcuts">
        {!connected && <button type="button" className="secondary" onClick={() => onConfigure('azure-openai')}>Configure Azure OpenAI</button>}
        {!deployment && <button type="button" className="secondary" onClick={() => onConfigure('azure-text')}>Configure text deployment</button>}
        {!speechConfigured && <button type="button" className="secondary" onClick={() => onConfigure('azure-speech')}>Configure Azure Speech</button>}
      </div>
    </div>}
    <form onSubmit={generate}>
      <section className="card script-generation-card">
        <h2>01 · Recording script brief</h2>
        <p className="muted">Describe the domains, scenarios, roles, number of conversations and turns, and the tone vocabulary. Each script gets its own Excel workbook (<code>.xlsx</code>) with the columns <code>ID · Scenario · Turn · Role · Content · {toneHeader} · Wordcount</code>. The app assigns IDs, turn numbers and word counts; don't ask for them in the brief.</p>
        <fieldset disabled={busy}>
          <div className="filter-bar script-brief-controls recording-script-controls">
            <label>Recorded role<input value={recordedRole} maxLength={60} onChange={event => setRecordedRole(event.target.value)} placeholder="e.g. Agent" />
              <small>Gets IDs and an emotional tone. Leave blank for every row.</small></label>
            <div className="recording-gender-control" role="group" aria-labelledby="recording-agent-gender" aria-describedby="recording-agent-gender-help">
              <span id="recording-agent-gender">Agent gender</span>
              <div className="recording-gender-options">
                {recordingAgentGenderSchema.options.map(gender => <label className="checkbox-label" key={gender}>
                  <input type="checkbox" checked={agentGenders.includes(gender)} onChange={event => {
                    const checked = event.target.checked;
                    setAgentGenders(previous => recordingAgentGenderSchema.options.filter(option => option === gender ? checked : previous.includes(option)));
                  }} />{GENDER_LABELS[gender]}</label>)}
              </div>
              <small id="recording-agent-gender-help">One script per selection, with the opposite Customer gender. Leave both unchecked for Unspecified.</small>
            </div>
            <label>First ID<input value={idStart} inputMode="numeric" maxLength={18} onChange={event => setIdStart(event.target.value)} />
              <small>IDs restart at this value in each file.</small></label>
            <label>File name<input value={fileName} maxLength={200} onChange={event => setFileName(event.target.value)} />
              <small>Saved as {recordingVariants([locales[0] ?? 'en-US'], agentGenders).map(target =>
                <code className="recording-file-example" key={recordingVariantKey(target)}>{recordingScriptFileName(target.locale, fileName || 'script', target.agentGender)}</code>)}</small></label>
            <label>Agent characters per locale (optional)<input type="number" min={1} max={MAX_RECORDING_TARGET_CHARACTERS}
              step={1} value={totalCharactersText} onChange={event => setTotalCharactersText(event.target.value)}
              placeholder="e.g. 10000" />
              <small>Minimum for each script's Agent dialogue only, including spaces and punctuation. Customer replies do not count.</small></label>
          </div>
          {!idStartCheck.success && <p className="error-text" role="alert">{idStartCheck.error.issues[0].message}</p>}
          <label>Domains<input value={domainsText} maxLength={MAX_RECORDING_DOMAINS * (MAX_RECORDING_DOMAIN_LENGTH + 1)}
            onChange={event => setDomainsText(event.target.value)} placeholder="telecom, banking, e-commerce" />
            <small>Comma-, semicolon-, or line-separated. The model covers each domain evenly.</small></label>
          <label>Content brief<textarea required rows={12} maxLength={MAX_RECORDING_BRIEF_LENGTH} value={prompt}
            onChange={event => setPrompt(event.target.value)} /></label>
          <div className="button-row">
            <button type="button" className="text-button"
              disabled={prompt === DEFAULT_RECORDING_BRIEF && domainsText === DEFAULT_RECORDING_DOMAINS && !totalCharactersText && !agentGenders.length}
              onClick={() => {
                if (window.confirm('Replace the brief and generation conditions with the sample values?')) {
                  setPrompt(DEFAULT_RECORDING_BRIEF); setDomainsText(DEFAULT_RECORDING_DOMAINS); setTotalCharactersText(''); setAgentGenders([]);
                }
              }}>Reset to sample brief</button>
            <button type="button" className="secondary" onClick={saveDefaults}>Save current fields as defaults</button>
            <small className="muted">Saved defaults are loaded when you reopen or refresh this page.</small>
          </div>
          {defaultsStatus && <p className={defaultsStatus.error ? 'error-text' : 'muted'}
            role={defaultsStatus.error ? 'alert' : 'status'}>{defaultsStatus.message}</p>}
        </fieldset>
      </section>
      <section className="card script-generation-card">
        <h2>02 · Languages / Accents</h2>
        <fieldset disabled={busy}>
          <p className="muted">Locales come from the Azure TTS voice catalog for your configured Azure Speech resource.</p>
          <div className="button-row">
            <button className="secondary" type="button" disabled={catalogLoading || !catalog.length || locales.length === catalog.length}
              onClick={() => setSelection(catalog.map(option => option.value))}>Select all</button>
            <button className="secondary" type="button" disabled={catalogLoading || !locales.length} onClick={() => setSelection([])}>Clear all</button>
            <button className="secondary" type="button" disabled={catalogLoading || !speechConfigured} onClick={() => void loadLocales(true)}>Refresh locales</button>
            {!!catalog.length && <span role="status">{locales.length} of {catalog.length} selected</span>}
          </div>
          {catalogLoading && <p role="status">Loading Azure TTS locales…</p>}
          {localeError && <p className="error-text" role="alert">{localeError}</p>}
          {!!catalog.length && <><div className="filter-bar filter-bar--single"><label>Search Azure TTS locales<input value={localeSearch}
            onChange={event => setLocaleSearch(event.target.value)} placeholder="e.g. English, French, en-GB" /></label></div>
            <div className="script-locale-options" role="group" aria-label="Recording script locales">
              {options.length ? <div className="script-locale-columns">
                {options.map(({ value, label }) => <label key={value}><input type="checkbox" checked={locales.includes(value)}
                  onChange={event => setSelection(event.target.checked ? [...locales, value] : locales.filter(locale => locale !== value))} />{label}</label>)}
              </div> : <p className="muted">No matching Azure TTS locales.</p>}
            </div></>}
        </fieldset>
        {deployment && <p className="muted">Text deployment: <strong>{deployment}</strong></p>}
        <div className="button-row">
          <button className="primary" type="submit" disabled={!ready || busy || azureBusy || !locales.length || !prompt.trim()}>Generate recording scripts</button>
          {generating && <button className="secondary danger" type="button" onClick={() => generation.current?.abort()}>Stop</button>}
          {savedRun && <button className="secondary" type="button" disabled={!ready || busy || azureBusy}
            onClick={() => void run(savedRun.targets, savedRun.input, true, savedRun.runId)}>Resume batch run</button>}
          <small>{targets.length} scripts selected. Large runs start with up to {RECORDING_BATCH_START_CONCURRENCY} workbooks in parallel and adapt up to {RECORDING_BATCH_CONCURRENCY}. Charges may apply.</small>
        </div>
        {azureBusy && !generating && <p className="muted" role="status">Another Azure text request is running in Script Generation. Try again when it finishes.</p>}
        {!!generating?.length && <p role="status">Generating {results?.order.filter(target => generating.includes(recordingVariantKey(target))).map(variantLabel).join('; ')}…</p>}
        {batchScheduling && <p role="status">{batchScheduling.cooldownUntil
          ? `Backing off after Azure throttling or timeout. Retrying after ${new Date(batchScheduling.cooldownUntil).toLocaleTimeString()} at up to ${batchScheduling.limit} workbooks in parallel.`
          : `Current parallel workbook limit: ${batchScheduling.limit}.`}</p>}
        {generationError && <p className="error-text" role="alert">{generationError}</p>}
      </section>
    </form>
    {results && <form className="card script-generation-card" onSubmit={save}>
      <h2>03 · Preview and save</h2>
      {runProgress && <RecordingGenerationProgress {...runProgress} />}
      {results.order.map((target, index) => {
        const key = recordingVariantKey(target);
        const result = results.byVariant[key];
        const label = variantLabel(target);
        const regenerate = <button className="secondary" type="button" disabled={!ready || busy || azureBusy} aria-label={`Regenerate ${label}`}
          onClick={() => regenerateVariant(target, results.recordedRole)}>Regenerate</button>;
        if (!result) return <div className="script-preview" key={key}><p><strong>{label}</strong> · {generating?.includes(key) ? 'Generating…' : 'Waiting'}</p>{!generating && <div className="button-row">{regenerate}</div>}</div>;
        if ('error' in result) return <div className="script-preview script-locale-issue" key={key}>
          <p><strong>{label}</strong> · Not generated</p><p className="error-text">{result.error}</p>
          <div className="button-row">{regenerate}</div>
        </div>;
        const script = numberedByVariant.get(key) ?? result.script;
        return <details className="script-preview" key={key} open={index === 0}>
          <summary>{recordingScriptFileName(script.locale, fileName || 'script', script.agentGender)} · {script.rows.length} rows</summary>
          {script.rows.length > MAX_RECORDING_ROWS && <p className="muted">Preview shows the first {MAX_RECORDING_ROWS} rows. Copy and Excel export include all rows.</p>}
          <div className="table-scroll recording-script-table">
            <table>
              <thead><tr><th>ID</th><th>Scenario</th><th>Turn</th><th>Role</th><th>Content</th><th>{recordingToneHeader(results.recordedRole)}</th><th>Wordcount</th></tr></thead>
              <tbody>{script.rows.slice(0, MAX_RECORDING_ROWS).map((row, index) => <tr key={index}>
                <td>{row.id}</td><td>{row.scenario}</td><td className="numeric">{row.turn}</td><td>{row.role}</td>
                <td>{row.content}</td><td>{row.tone}</td><td className="numeric">{row.wordCount}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="button-row">
            <button className="secondary" type="button" onClick={() => void copy(script)}>Copy as text</button>
            {regenerate}
            {copied === key && <span role="status">Copied.</span>}
          </div>
        </details>;
      })}
      <label>Destination folder<input value={directory} disabled={busy} maxLength={2048} required
        onChange={event => { setDirectory(event.target.value); setSaved(undefined); setSaveError(''); }}
        placeholder="C:\Users\You\Documents\Scripts" /></label>
      <p className="muted">Paste an existing local folder path. Each script is saved as a separate Excel workbook with a header row. Existing files are not overwritten.</p>
      <button className="primary" type="submit" disabled={busy || !numbered.length || !directory.trim() || !fileName.trim()}>
        {numbered.length === 1 ? 'Save 1 recording script' : `Save ${numbered.length} recording scripts`}
      </button>
      {saving && <p role="status">Saving recording scripts…</p>}
      {saveError && <p className="error-text" role="alert">{saveError}</p>}
      {saved && <ul className="script-save-results" aria-live="polite">{saved.map(result => <li key={result.file}>
        {result.path && <span>Saved: {result.path}</span>}
        {result.error && <span className="error-text"> {result.file}: {result.error}</span>}
      </li>)}</ul>}
    </form>}
  </div>;
}
