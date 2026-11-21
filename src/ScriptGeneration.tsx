import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MAX_SCRIPT_BRIEF_LENGTH, MAX_SCRIPT_STYLE_LENGTH, MAX_SCRIPT_UTTERANCES, SCRIPT_EXPORT_BATCH_SIZE,
  scriptBriefImprovementSchema, scriptBriefSuggestionSchema, scriptExportSchema,
  scriptFileName, scriptFileText, scriptGenerationSchema, type ScriptExportResult,
  type ScriptGenerationRequest, type ScriptGenerationResult, type ScriptLocaleOption,
} from '../shared/scriptGeneration';
import { studioLocaleLabel } from '../shared/studioVoices';
import type { AppRequest, AzureSettingsTarget } from './AzureSettings';
import { generateScriptsWithRetry, type ScriptRetryProgress } from './scriptGenerationProgress';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unexpected script generation error.';
export const DEFAULT_SCRIPT_LOCALES = ['en-US', 'fr-FR', 'zh-HK', 'zh-CN', 'vi-VN'] as const;
export const DEFAULT_SCRIPT_BRIEF = `Script style: Customer_Services_Tag

### Task
Generate realistic customer service calls in the target language, with **only the Agent's side**, covering all 4 domains evenly.

### 4 Domains — 16 Utterances Total
Write 4 agent utterances per call, in this order:
* **Utterances 00001–00004 (Call 1 — Telecom):** Mobile roaming issue, eSIM activation, or home fiber outage. Verify **Customer Name** + **Billing/Service Address**.
* **Utterances 00005–00008 (Call 2 — Banking & Finance):** Blocked card abroad, unrecognized charge dispute, or wire transfer delay. Verify **Full Phone Number** + **Transaction Date**.
* **Utterances 00009–00012 (Call 3 — Delivery & Logistics):** Delayed/misdelivered parcel or delivery time-slot reschedule. Verify **Customer Name** + **Delivery Street Address** + **Delivery Date**.
* **Utterances 00013–00016 (Call 4 — Flight & Hotel Travel):** Rebook a flight or adjust a hotel booking after a flight change. State both endpoints with the localized city or airport name first, then its uppercase 3-letter code: Da Nang DAD to Incheon ICN. Never say a bare code. Vary the route. Verify **Customer Name** + **Travel/Check-in Date** + **Phone Number**.

Each call covers the issue, PII verification, a specific troubleshooting step or solution, and confirmation. Use at most 1 brief greeting across all calls; prioritize problem solving over greetings and pleasantries.

### Output Rules
1. **Format and expression tags:** Return 16 utterances; no IDs, line numbers, headers, speaker labels, or stage directions. Prefix every spoken sentence with exactly 1 emotion/style tag in square brackets, for example: [concerned] Is the eSIM inactive? [determined] Let's check the settings. Tag each sentence in a multi-sentence utterance. Tags are non-spoken; otherwise use only spoken words and punctuation, without parentheses or asterisks. Use [calm] at most 4 times per locale. Vary other appropriate styles naturally.
   - Use only these style names: amazed, amused, angry, annoyed, anxious, appreciative, calm, cautious, concerned, confident, confused, curious, defeated, defensive, defiant, determined, disappointed, disgusted, doubtful, ecstatic, encouraging, excited, fast, fearful, frustrated, happy, hesitant, hurt, impatient, impressed, intrigued, joking, laughing, optimistic, painful, panicked, panting, pleading, proud, quiet, reassuring, reflective, relieved, remorseful, resigned, sad, sarcastic, secretive, serious, shocked, shouting, shy, skeptical, slow, struggling, surprised, suspicious, sympathetic, terrified, upset, urgent, whispering.
   - Optional sound tags: [laughter], [coughing], [throat_clearing], [breathing], [sighing], [yawning]. Use sparingly where the sound occurs, separate from the style tag.
2. **Spoken hesitations:** Use local fillers, such as \`um...\` in English, \`嗯...\` in Mandarin, \`即係...\` in Cantonese, \`euh...\` in French, or \`ừm...\` in Vietnamese.
   - Include **at least 2 hesitations per mini-call** (at least 8 total).
   - **Positional Distribution Rule:** Do NOT put them all at the start of lines—place at least half **in the middle of a sentence** or **between two sentences** inside the same utterance.
3. **Synthetic PII & Digit Formatting:** Use realistic localized dummy names, dates, street addresses, and full phone numbers; vary them across calls and never use \`Juniper\`, \`晴禾\`, or \`10/15/2026\`. Write ALL numbers, including dates, addresses, phone numbers, and durations, as **digits**.
4. **Colloquial Delivery:** Use short clauses and natural softeners. Keep the target language primary. In every locale, use what a local agent would actually say on the phone, not a formal translation. Mix in English words or acronyms where locals naturally do, e.g., email, booking, WhatsApp, invoice, meeting, package, ID, ATM, SMS, or QR. Prefer local equivalents when they sound more natural. No term is mandatory.`;

export function extractScriptStyle(brief: string): string {
  const explicit = brief.match(/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:script style|style|tone)(?:\*\*)?:[ \t]*(?:\*\*)?([^\r\n]+)/im)?.[1];
  const description = brief.split(/\r?\n/).map(line => line.trim())
    .find(line => line && !line.startsWith('#'));
  const candidate = (explicit ?? description ?? '').replace(/[*`]/g, '').trim();
  const style = explicit ? candidate : candidate.replace(/^(?:write|generate|create|draft)\s+(?:(?:a|an)\s+)?/i, '')
    .split(/[.!?。！？](?:\s|$)|[。！？]/u, 1)[0];
  return style.slice(0, MAX_SCRIPT_STYLE_LENGTH).replace(/[\uD800-\uDBFF]$/, '').trim();
}
type Preview = {
  revision: number; style: string; speakers: ScriptGenerationRequest['speakers']; results: ScriptGenerationResult; total: number;
};

export function ScriptGeneration({ request, active, connected, speechConfigured, deployment, onConfigure }: {
  request: AppRequest;
  active: boolean;
  connected?: boolean;
  speechConfigured?: boolean;
  deployment?: string;
  onConfigure: (target: AzureSettingsTarget) => void;
}) {
  const [selection, setSelection] = useState<string[]>();
  const [catalog, setCatalog] = useState<ScriptLocaleOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogRequest = useRef<AbortController>(undefined);
  const [localeSearch, setLocaleSearch] = useState('');
  const [localeError, setLocaleError] = useState('');
  const [styleOverride, setStyleOverride] = useState<string>();
  const [speakers, setSpeakers] = useState<ScriptGenerationRequest['speakers']>(1);
  const [utteranceCount, setUtteranceCount] = useState('16');
  const [prompt, setPrompt] = useState(DEFAULT_SCRIPT_BRIEF);
  const extractedStyle = extractScriptStyle(prompt);
  const style = styleOverride ?? extractedStyle;
  const [suggestion, setSuggestion] = useState('');
  const [improvementError, setImprovementError] = useState('');
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [saved, setSaved] = useState<ScriptExportResult>();
  const [generationError, setGenerationError] = useState('');
  const generationRequest = useRef<AbortController>(undefined);
  const [generationProgress, setGenerationProgress] = useState<ScriptRetryProgress & { total: number }>(
    { total: 0, generated: 0, failed: 0, retrying: 0 },
  );
  const [generationStopped, setGenerationStopped] = useState('');
  useEffect(() => () => generationRequest.current?.abort(), []);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState<'improve' | 'generate' | 'save'>();
  const scripts = preview?.results.flatMap(result => 'script' in result ? [result.script] : []) ?? [];
  const options = catalog.filter(option => option.label.toLowerCase().includes(localeSearch.trim().toLowerCase()));
  const locales = selection ?? [];
  const readyToImprove = !!connected && !!deployment && !!prompt.trim();
  const readyToGenerate = !!connected && !!deployment && !!speechConfigured && !catalogLoading && !localeError;

  const loadLocales = useCallback(async (refresh: boolean) => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const { signal } = controller;
    setCatalogLoading(true); setLocaleError('');
    try {
      const options = await request<ScriptLocaleOption[]>(`/api/script-generation/locales${refresh ? '?refresh=1' : ''}`, undefined, 'GET', signal);
      if (signal.aborted) return;
      const available = new Set(options.map(option => option.value));
      setCatalog(options);
      setSelection(previous => (previous ?? DEFAULT_SCRIPT_LOCALES).filter(code => available.has(code)));
    } catch (error) {
      if (!signal.aborted) { setCatalog([]); setLocaleError(errorText(error)); }
    } finally { if (!signal.aborted) setCatalogLoading(false); }
  }, [request]);

  useEffect(() => {
    if (!active) return;
    if (!speechConfigured) { setCatalog([]); setCatalogLoading(false); setLocaleError(''); return; }
    void loadLocales(false);
    return () => catalogRequest.current?.abort();
  }, [active, loadLocales, speechConfigured]);

  function clearImprovement() {
    setSuggestion(''); setImprovementError('');
  }

  async function improveBrief() {
    if (!readyToImprove || busy) return;
    clearImprovement();
    const input = scriptBriefImprovementSchema.safeParse({ prompt, style, speakers, consent: true });
    if (!input.success) { setImprovementError(input.error.issues[0].message); return; }
    setBusy('improve');
    try {
      const response = await request<unknown>('/api/script-generation/improve-brief', input.data);
      const result = scriptBriefSuggestionSchema.safeParse(response);
      if (!result.success) throw new Error('The server did not return a usable brief suggestion.');
      setSuggestion(result.data.suggestion);
    } catch (error) { setImprovementError(errorText(error)); }
    finally { setBusy(undefined); }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!readyToGenerate || busy || generationRequest.current) return;
    setGenerationError('');
    setGenerationStopped('');
    const input = scriptGenerationSchema.safeParse({
      locales, style, speakers, utteranceCount: Number(utteranceCount),
      prompt, consent: true,
    });
    if (!input.success) { setGenerationError(input.error.issues[0].message); return; }
    const total = input.data.locales.length;
    const controller = new AbortController();
    generationRequest.current = controller;
    let results: ScriptGenerationResult = [];
    setGenerationProgress({ total, generated: 0, failed: 0, retrying: 0 });
    setBusy('generate');
    try {
      await generateScriptsWithRetry(input.data, controller.signal, (progress, latest) => {
        results = latest;
        setGenerationProgress({ total, ...progress });
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const generated = results.filter(result => 'script' in result).length;
        setGenerationStopped(`Generation stopped. ${generated}/${total} scripts generated.`);
      } else setGenerationError(errorText(error));
    } finally {
      if (results.length) {
        setPreview(previous => ({ revision: (previous?.revision ?? 0) + 1, style: input.data.style, speakers: input.data.speakers, results, total }));
        setSaved(undefined); setSaveError('');
      }
      generationRequest.current = undefined;
      setBusy(undefined);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || busy) return;
    setSaveError(''); setSaved(undefined);
    setBusy('save');
    const results: ScriptExportResult = [];
    try {
      for (let index = 0; index < scripts.length; index += SCRIPT_EXPORT_BATCH_SIZE) {
        const input = scriptExportSchema.parse({
          directory: directory.trim().replace(/^"(.*)"$/, '$1'), style: preview.style, speakers: preview.speakers,
          scripts: scripts.slice(index, index + SCRIPT_EXPORT_BATCH_SIZE),
        });
        results.push(...await request<ScriptExportResult>('/api/script-generation/save', input));
        setSaved([...results]);
      }
    } catch (error) { setSaveError(errorText(error)); }
    finally { setBusy(undefined); }
  }

  return <section className="script-generation" aria-label="Script Generation">
    <div className="page-title"><h1>Script Generation</h1></div>
    {(!connected || !deployment || !speechConfigured) && <div className="callout azure-settings-prompt">
      <span>Complete these Azure settings to generate scripts.</span>
      <div className="settings-shortcuts">
        {!connected && <button type="button" className="secondary" onClick={() => onConfigure('azure-openai')}>Configure Azure OpenAI</button>}
        {!deployment && <button type="button" className="secondary" onClick={() => onConfigure('azure-text')}>Configure text deployment</button>}
        {!speechConfigured && <button type="button" className="secondary" onClick={() => onConfigure('azure-speech')}>Configure Azure Speech</button>}
      </div>
    </div>}
    <form className="card script-generation-card" onSubmit={generate}>
      <h2>01 · Script brief</h2>
      <p className="muted">Generate an original script for each selected language and accent. The app adds utterance IDs such as <code>en-US_00001</code> in the preview and export; don't request IDs in the brief.</p>
      <fieldset disabled={!!busy}>
        <div className="field-row">
          <div>
            <label>Script style<input required value={style} onChange={event => { setStyleOverride(event.target.value); clearImprovement(); }}
              maxLength={MAX_SCRIPT_STYLE_LENGTH} placeholder="e.g. Warm documentary narration" /></label>
            {styleOverride === undefined ? <small>Filled from the content brief.</small>
              : <button type="button" className="text-button" onClick={() => { setStyleOverride(undefined); clearImprovement(); }}>Use style from brief</button>}
          </div>
          <label>Speakers<select value={speakers} onChange={event => { setSpeakers(event.target.value === '2' ? 2 : 1); clearImprovement(); }}>
            <option value={1}>One speaker</option><option value={2}>Two speakers</option></select></label>
          <label>Utterances per locale<input required type="number" min={speakers} max={MAX_SCRIPT_UTTERANCES} value={utteranceCount}
            onChange={event => setUtteranceCount(event.target.value)} /></label>
        </div>
        <label>Content brief<textarea required rows={4} maxLength={MAX_SCRIPT_BRIEF_LENGTH} value={prompt}
          onChange={event => { setPrompt(event.target.value); clearImprovement(); }}
          placeholder="Describe the scenario, tone and topics. For example: A customer calls to reschedule a delivery. Confirm the new date and explain the next steps." /></label>
        <div className="button-row">
          <button className="secondary" type="button" disabled={!readyToImprove || !!busy} onClick={() => void improveBrief()}>Improve with AI</button>
          <small>Sends the brief, style and speaker count to Azure OpenAI in one request. Charges may apply.</small>
        </div>
        {busy === 'improve' && <p role="status">Improving your brief…</p>}
        {improvementError && <p className="error-text" role="alert">{improvementError}</p>}
        {suggestion && <div className="script-preview script-brief-suggestion">
          <p role="status">Suggestion ready. Your original brief is unchanged.</p>
          <label>Suggested brief<textarea readOnly rows={5} value={suggestion} /></label>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => { setPrompt(suggestion); clearImprovement(); }}>Use suggestion</button>
            <button type="button" className="text-button" onClick={clearImprovement}>Keep original</button>
          </div>
        </div>}
      </fieldset>
      <fieldset disabled={!!busy}>
        <legend>Languages / accents</legend>
        <p className="muted">Locales come from the Azure TTS voice catalog for your configured Azure Speech resource.</p>
        <div className="button-row">
          <button className="secondary" type="button" disabled={catalogLoading || !catalog.length || locales.length === catalog.length}
            onClick={() => setSelection(catalog.map(option => option.value))}>Select all</button>
          <button className="secondary" type="button" disabled={catalogLoading || !catalog.length || !locales.length} onClick={() => setSelection([])}>Clear all</button>
          <button className="secondary" type="button" disabled={catalogLoading || !speechConfigured} onClick={() => void loadLocales(true)}>Refresh locales</button>
          {!!catalog.length && <span role="status">{locales.length} of {catalog.length} selected</span>}
        </div>
        {catalogLoading && <p role="status">Loading Azure TTS locales…</p>}
        {localeError && <p className="error-text" role="alert">{localeError}</p>}
        {!!catalog.length && <><div className="filter-bar filter-bar--single"><label>Search Azure TTS locales<input value={localeSearch} onChange={event => setLocaleSearch(event.target.value)} placeholder="e.g. English, French, en-GB" /></label></div>
          <div className="script-locale-options" role="group" aria-label="Azure TTS locales">
            {options.map(({ value, label }) => <label key={value}><input type="checkbox" checked={locales.includes(value)} disabled={catalogLoading}
              onChange={event => setSelection(event.target.checked ? [...locales, value] : locales.filter(locale => locale !== value))} />{label}</label>)}
            {!options.length && <p className="muted">No matching Azure TTS locales.</p>}
          </div></>}
      </fieldset>
      {deployment && <p className="muted">Text deployment: <strong>{deployment}</strong></p>}
      <div className="button-row">
        <button className="primary" disabled={!!busy || !readyToGenerate || !locales.length} type="submit">Generate preview</button>
        {busy === 'generate' && <button className="secondary" type="button" onClick={() => generationRequest.current?.abort()}>Stop generation</button>}
        <small>Retryable locales run until they succeed or you stop generation. Each Azure OpenAI attempt may incur charges.</small>
      </div>
      {busy === 'generate' && <p role="status">Generating scripts… {generationProgress.generated}/{generationProgress.total} generated
        {generationProgress.failed > 0 && ` · ${generationProgress.failed} failed`}
        {generationProgress.retrying > 0 && (generationProgress.nextRetryMs === undefined
          ? ` · ${generationProgress.retrying} retrying`
          : ` · Retrying ${generationProgress.retrying} in ${Math.ceil(generationProgress.nextRetryMs / 1000)}s`)}</p>}
      {generationStopped && <p role="status">{generationStopped}</p>}
      {generationError && <p className="error-text" role="alert">{generationError}</p>}
    </form>

    <form className="card script-generation-card" onSubmit={save}>
      <h2>02 · Preview and save</h2>
      {!preview && <p className="muted">Generate a successful preview before saving. The destination folder only controls where the files are written.</p>}
      {preview && <p role="status">{scripts.length} of {preview.total} scripts generated.
        {scripts.length < preview.results.length && ` ${preview.results.length - scripts.length} failed.`}
        {preview.results.length < preview.total && ` ${preview.total - preview.results.length} unfinished.`}</p>}
      {preview?.results.map(result => 'script' in result
        ? <details className="script-preview" key={`${preview.revision}:${result.script.locale}`} open={result.script.locale === scripts[0]?.locale}>
          <summary>{scriptFileName(result.script.locale, preview.style)} · {result.script.utterances.length} utterances</summary>
          <pre>{scriptFileText(result.script, preview.speakers)}</pre>
        </details>
        : <p className="error-text" key={result.locale}>{studioLocaleLabel(result.locale)}: {result.error}</p>)}
      <label>Destination folder<input value={directory} disabled={!!busy} maxLength={2048}
        onChange={event => { setDirectory(event.target.value); setSaved(undefined); setSaveError(''); }}
        placeholder="C:\Users\You\Documents\Scripts" required /></label>
      <p className="muted">Paste an existing local folder path. Filenames use the locale and script style, for example <code>en-US_Warm_documentary_narration.txt</code>. Each UTF-8 line contains an utterance filename, a tab, and spoken text. Existing files are not overwritten.</p>
      <button className="primary" disabled={!!busy || !scripts.length || !directory.trim()} type="submit">
        {scripts.length === 1 ? 'Save 1 script' : scripts.length ? `Save ${scripts.length} scripts` : 'Save scripts'}
      </button>
      {busy === 'save' && <p role="status">Saving scripts…</p>}
      {saveError && <p className="error-text" role="alert">{saveError}</p>}
      {saved && <ul className="script-save-results" aria-live="polite">{saved.map(result => <li key={result.file}>
        {result.path && <span>Saved: {result.path}</span>}
        {result.error && <span className="error-text"> {result.file}: {result.error}</span>}
      </li>)}</ul>}
    </form>
  </section>;
}
