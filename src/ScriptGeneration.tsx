import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_EXPRESSION_TAG_LISTS, expressionTagListsSchema, expressionTagRules } from '../shared/scriptExpressionTags';
import {
  MAX_SCRIPT_BRIEF_LENGTH, MAX_SCRIPT_STYLE_LENGTH, MAX_SCRIPT_UTTERANCES, SCRIPT_EXPORT_BATCH_SIZE,
  scriptBriefImprovementSchema, scriptBriefSuggestionSchema, scriptExportSchema,
  scriptFileName, scriptFileText, scriptGenerationSchema, type ScriptExportResult,
  type ScriptGenerationRequest, type ScriptGenerationStatus, type ScriptLocaleOption,
} from '../shared/scriptGeneration';
import { studioLocaleLabel } from '../shared/studioVoices';
import type { AppRequest, AzureSettingsTarget } from './AzureSettings';
import { resultLocale } from './scriptGenerationProgress';
import { loadBriefTemplates, loadDefaultBrief, saveBriefTemplate, saveDefaultBrief, MAX_TEMPLATE_NAME_LENGTH, type BriefTemplate } from './scriptBriefTemplates';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unexpected script generation error.';
const defaultStyleTags = DEFAULT_EXPRESSION_TAG_LISTS.styles.join(', ');
const defaultSoundTags = DEFAULT_EXPRESSION_TAG_LISTS.sounds.join(', ');
const parseTagNames = (draft: string) => draft.split(/[,\n]/).map(name => name.trim()).filter(Boolean)
  .map(name => name.replace(/^\[([^\[\]]+)\]$/, '$1'));
export const DEFAULT_SCRIPT_LOCALES = ['en-US', 'fr-FR', 'zh-HK', 'zh-CN', 'vi-VN'] as const;
const CUSTOMER_SERVICE_SCENARIOS = `### Task
Write realistic agent-only calls in the target language.

### 4 Domains — 16 Utterances Total
Write 4 agent utterances per call, in this order:
* **Utterances 00001–00004 (Call 1 — Telecom):** Mobile roaming issue, eSIM activation, or home fiber outage. Verify **Customer Name** + **Billing/Service Address**.
* **Utterances 00005–00008 (Call 2 — Banking & Finance):** Blocked card abroad, unrecognized charge dispute, or wire transfer delay. Verify **Full Phone Number** + **Transaction Date**.
* **Utterances 00009–00012 (Call 3 — Delivery & Logistics):** Delayed/misdelivered parcel or delivery time-slot reschedule. Verify **Customer Name** + **Delivery Street Address** + **Delivery Date**.
* **Utterances 00013–00016 (Call 4 — Flight & Hotel Travel):** Rebook a flight or adjust a hotel booking after a flight change. Whenever reading back the route, give each endpoint's specific airport name as spoken locally, including the city when natural, then its matching uppercase 3-letter IATA code in parentheses: Hanoi Noi Bai (HAN) to Tokyo Narita (NRT). Do not use a city alone, such as Tokyo (NRT), or a bare code. Vary the route. Verify **Customer Name** + **Travel/Check-in Date** + **Phone Number**.
  In both scenarios, read back the revised itinerary in natural speech: the airline name, a plausible flight number with that airline's designator, and the departure and arrival dates and times in each airport's local time. Make the timing plausible for the route and say the arrival date explicitly, especially if it changes overnight. Keep the dates consistent with any hotel change. Present a proposed option before asking for approval and confirm the change only in a later utterance.

For each locale and run, vary the incident, cause, and resolution within each domain. Don't recycle a case by just swapping names, dates, or routes.

Cover the issue, verification, a concrete fix, and confirmation. Thank the caller and confirm the details match without reciting their full name, address, or phone number back. Read back only what needs checking. End any utterance at the question. Use at most 1 brief greeting across the calls; focus on solving the problem.
**Service Assurance:** Start EVERY agent reply by acknowledging the customer's request, details, or response before answering, verifying, proposing a fix, or confirming it. A few natural words are enough. Use each opener at most twice, never in a row. Don't promise unverified outcomes.

### Output Rules`;
const FORMAT = '1. **Format:** Return 16 utterances; no IDs, line numbers, headers, speaker labels, or stage directions. Write spoken words and punctuation without asterisks; parentheses only for airport codes.';
const DELIVERY_RULES = `2. **Spoken hesitations:** Use local fillers or pauses when the agent is checking something or thinking. Don't interrupt a clear explanation just to insert a filler.
   - Include **at least 2 hesitations per mini-call** (at least 8 total).
   - **Positional Distribution Rule:** Do NOT put them all at the start of lines—place at least half **in the middle of a sentence** or **between two sentences** inside the same utterance.
3. **Synthetic PII & Digit Formatting:** Use realistic localized dummy names, dates, street addresses, and full phone numbers; vary them across calls and never use \`Juniper\`, \`晴禾\`, or \`10/15/2026\`. Write ALL numbers, including dates, addresses, phone numbers, and durations, as **digits**.
4. **Colloquial Delivery:** Use short clauses and natural softeners. Keep the target language primary. In every locale, use what a local agent would actually say on the phone, not a formal translation. Mix in English words or acronyms where locals naturally do, e.g., email, booking, WhatsApp, invoice, meeting, package, ID, ATM, SMS, or QR. Prefer local equivalents when they sound more natural. No term is mandatory.`;

export const DEFAULT_SCRIPT_BRIEF = `Script style: Customer_Services\n\n${CUSTOMER_SERVICE_SCENARIOS}\n${FORMAT}\n${DELIVERY_RULES}`;
export const BUILT_IN_BRIEF_TEMPLATES = [
  { name: 'customer_services', prompt: DEFAULT_SCRIPT_BRIEF },
] as const satisfies readonly BriefTemplate[];

export function extractScriptStyle(brief: string): string {
  const explicit = brief.match(/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:script style|style|tone)(?:\*\*)?:[ \t]*(?:\*\*)?([^\r\n]+)/im)?.[1];
  const description = brief.split(/\r?\n/).map(line => line.trim())
    .find(line => line && !line.startsWith('#'));
  const candidate = (explicit ?? description ?? '').replace(/[*`]/g, '').trim();
  const style = explicit ? candidate : candidate.replace(/^(?:write|generate|create|draft)\s+(?:(?:a|an)\s+)?/i, '')
    .split(/[.!?。！？](?:\s|$)|[。！？]/u, 1)[0];
  return style.slice(0, MAX_SCRIPT_STYLE_LENGTH).replace(/[\uD800-\uDBFF]$/, '').trim();
}
const runPath = '/api/script-generation/run';

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
  const [expressionTags, setExpressionTags] = useState(true);
  const [styleTags, setStyleTags] = useState(defaultStyleTags);
  const [soundTags, setSoundTags] = useState(defaultSoundTags);
  const tagLists = expressionTagListsSchema.safeParse({ styles: parseTagNames(styleTags), sounds: parseTagNames(soundTags) });
  const [prompt, setPrompt] = useState(DEFAULT_SCRIPT_BRIEF);
  const [defaultBrief, setDefaultBrief] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<string>(BUILT_IN_BRIEF_TEMPLATES[0].name);
  const [customTemplates, setCustomTemplates] = useState<BriefTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const templateSaveHintId = useId();
  const localesHeadingId = useId();
  const [templateStatus, setTemplateStatus] = useState('');
  const [templateError, setTemplateError] = useState('');
  useEffect(() => {
    const errors: string[] = [];
    try { setCustomTemplates(loadBriefTemplates(window.localStorage)); }
    catch { errors.push('Saved templates could not be loaded. Built-in templates are still available.'); }
    try {
      const savedBrief = loadDefaultBrief(window.localStorage);
      if (savedBrief !== null) {
        setDefaultBrief(savedBrief);
        setSelectedTemplate('');
        setPrompt(savedBrief);
      }
    } catch { errors.push('Your default brief could not be loaded. The built-in brief is shown instead.'); }
    if (errors.length) setTemplateError(errors.join(' '));
  }, []);
  const templates = [...BUILT_IN_BRIEF_TEMPLATES, ...customTemplates];
  const selectedBrief = selectedTemplate === '' ? defaultBrief : templates.find(template => template.name === selectedTemplate)?.prompt;
  const briefEdited = selectedBrief !== prompt;
  const extractedStyle = extractScriptStyle(prompt);
  const style = styleOverride?.trim() || extractedStyle;
  const [suggestion, setSuggestion] = useState('');
  const [improvementError, setImprovementError] = useState('');
  const [directory, setDirectory] = useState('');
  const [runStatus, setRunStatus] = useState<ScriptGenerationStatus>();
  const [statusError, setStatusError] = useState('');
  const [commandPending, setCommandPending] = useState(false);
  const command = useRef({ pending: false, revision: 0 });
  const preview = runStatus?.run;
  const [saved, setSaved] = useState<ScriptExportResult>();
  const [generationError, setGenerationError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState<'improve' | 'save'>();
  const regeneration = preview?.regeneration;
  const isRegenerating = regeneration?.state === 'running';
  const scripts = preview?.results.flatMap(result => 'script' in result ? [result.script] : []) ?? [];
  const previewIsGenerating = preview?.state === 'running' || preview?.state === 'pausing' ||
    preview?.state === 'stopping' || preview?.state === 'cancelling';
  const textRequest = runStatus?.textRequest;
  const failedLocales = preview?.results.filter(result => 'error' in result && result.retryAfterMs === undefined).length ?? 0;
  const options = catalog.filter(option => option.label.toLowerCase().includes(localeSearch.trim().toLowerCase()));
  const locales = selection ?? [];
  const readyToImprove = !!connected && !!deployment && !!prompt.trim();
  const readyToGenerate = !!connected && !!deployment && !!speechConfigured && !catalogLoading && !localeError;
  const unavailable = !runStatus || !!statusError || runStatus.textBusy || !!busy || commandPending;
  const canRegenerate = !unavailable && readyToGenerate && !isRegenerating && (!previewIsGenerating || preview?.state === 'running');
  const controlsDisabled = unavailable || previewIsGenerating || isRegenerating;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!command.current.pending) {
        const revision = command.current.revision;
        try {
          const status = await request<ScriptGenerationStatus>(runPath, undefined, 'GET', controller.signal);
          if (!controller.signal.aborted && revision === command.current.revision) {
            setRunStatus(status);
            setStatusError('');
          }
        } catch (error) {
          if (!controller.signal.aborted && revision === command.current.revision) setStatusError(errorText(error));
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, request]);

  useEffect(() => {
    setSaved(undefined); setSaveError('');
  }, [preview?.id, regeneration?.state]);

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

  function chooseTemplate(name: string) {
    const brief = name === '' ? defaultBrief : templates.find(item => item.name === name)?.prompt;
    if (brief == null) return;
    if (briefEdited && !window.confirm('Switch templates and discard the unsaved changes to this brief?')) return;
    setSelectedTemplate(name); setPrompt(brief);
    setTemplateStatus(''); setTemplateError('');
    clearImprovement();
  }

  function saveAsDefault() {
    setTemplateStatus(''); setTemplateError('');
    try {
      saveDefaultBrief(window.localStorage, prompt);
      setDefaultBrief(prompt);
      setSelectedTemplate('');
      setTemplateStatus('Saved as your default brief in this browser.');
    } catch (error) { setTemplateError(errorText(error)); }
  }

  function saveTemplate() {
    setTemplateStatus(''); setTemplateError('');
    try {
      const { template, templates: savedTemplates } = saveBriefTemplate(
        window.localStorage, { name: templateName, prompt }, BUILT_IN_BRIEF_TEMPLATES,
      );
      setCustomTemplates(savedTemplates);
      setSelectedTemplate(template.name);
      setTemplateName('');
      setTemplateStatus(`Saved template "${template.name}" in this browser.`);
    } catch (error) { setTemplateError(errorText(error)); }
  }

  async function improveBrief() {
    if (!readyToImprove || controlsDisabled) return;
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

  async function runCommand(url: string, payload: unknown) {
    if (command.current.pending) return;
    command.current.pending = true;
    command.current.revision++;
    setCommandPending(true);
    setGenerationError('');
    try { setRunStatus(await request<ScriptGenerationStatus>(url, payload)); }
    catch (error) { setGenerationError(errorText(error)); }
    finally {
      command.current.pending = false;
      setCommandPending(false);
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!readyToGenerate || controlsDisabled) return;
    setGenerationError('');
    if (expressionTags && !tagLists.success) {
      setGenerationError('Fix the tag lists before generating.');
      return;
    }
    const input = scriptGenerationSchema.safeParse({
      locales, style, speakers, utteranceCount: Number(utteranceCount),
      prompt, expressionTags, consent: true,
      ...(expressionTags && tagLists.success ? { expressionTagLists: tagLists.data } : {}),
    });
    if (!input.success) { setGenerationError(input.error.issues[0].message); return; }
    if (preview?.state === 'paused' && !window.confirm('Replace the paused run and its previews with a new run using the current settings?')) return;
    await runCommand(runPath, input.data);
  }

  function runAction(action: 'pause' | 'stop' | 'cancel' | 'resume' | 'restart' | 'regenerate' | 'stop-regeneration', locale?: string) {
    if (!preview || unavailable) return;
    if (action === 'cancel' && !window.confirm('Cancel this run? Completed previews will be kept.')) return;
    if (action === 'restart' && !window.confirm('Restart with the same settings? This replaces the current previews and makes new Azure requests.')) return;
    void runCommand(`${runPath}/action`, { id: preview.id, action, ...(locale === undefined ? {} : { locale }) });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || controlsDisabled) return;
    setSaveError(''); setSaved(undefined);
    setBusy('save');
    const results: ScriptExportResult = [];
    try {
      for (let index = 0; index < scripts.length; index += SCRIPT_EXPORT_BATCH_SIZE) {
        const input = scriptExportSchema.parse({
          directory: directory.trim().replace(/^"(.*)"$/, '$1'), style: preview.input.style, speakers: preview.input.speakers,
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
    <form onSubmit={generate}>
      <section className="card script-generation-card">
        <h2>01 · Script brief</h2>
        <p className="muted">Generate an original script for each selected language and accent. The app adds utterance IDs such as <code>en-US_00001</code> in the preview and export; don't request IDs in the brief.</p>
        <fieldset disabled={!!busy || previewIsGenerating || isRegenerating}>
          <div className="filter-bar script-brief-controls">
            <label>Content brief template<select value={selectedTemplate} onChange={event => chooseTemplate(event.target.value)}>
              {defaultBrief !== null && <option value="">My default brief</option>}
              <optgroup label="Built-in templates">
                {BUILT_IN_BRIEF_TEMPLATES.map(({ name }) => <option key={name} value={name}>{name}</option>)}
              </optgroup>
              {!!customTemplates.length && <optgroup label="Saved templates">
                {customTemplates.map(({ name }) => <option key={name} value={name}>{name}</option>)}
              </optgroup>}
            </select></label>
            <label className="script-brief-style">Script style<input value={styleOverride ?? extractedStyle}
              onChange={event => { setStyleOverride(event.target.value); clearImprovement(); }}
              onBlur={event => { if (!event.target.value.trim()) setStyleOverride(undefined); }}
              maxLength={MAX_SCRIPT_STYLE_LENGTH} placeholder="e.g. Warm documentary narration" /></label>
            <label>Speakers<select value={speakers} onChange={event => { setSpeakers(event.target.value === '2' ? 2 : 1); clearImprovement(); }}>
              <option value={1}>One speaker</option><option value={2}>Two speakers</option></select></label>
            <label>Utterances per locale<input required type="number" min={speakers} max={MAX_SCRIPT_UTTERANCES} value={utteranceCount}
              onChange={event => setUtteranceCount(event.target.value)} /></label>
            <label>Expression tags<select value={expressionTags ? 'on' : 'off'} onChange={event => setExpressionTags(event.target.value === 'on')}>
              <option value="on">On</option><option value="off">Off</option>
            </select></label>
          </div>
          {briefEdited && <small>Unsaved brief edits. Save them as your default or as a named template to reuse them later.</small>}
          <label>Content brief<textarea required rows={4} maxLength={MAX_SCRIPT_BRIEF_LENGTH} value={prompt}
            onChange={event => { setPrompt(event.target.value); clearImprovement(); }}
            placeholder="Describe the scenario, tone and topics. For example: A customer calls to reschedule a delivery. Confirm the new date and explain the next steps." /></label>
          {expressionTags && <details className="script-preview">
            <summary>Expression tags applied: one style tag per sentence</summary>
            <div className="script-tag-editor">
              <small className="muted">Separate names with commas or line breaks. Leave sound tags blank to omit them. Edits apply to this session, not to saved briefs.</small>
              <label>Allowed style tags<textarea rows={3} maxLength={4200} value={styleTags} onChange={event => setStyleTags(event.target.value)} /></label>
              <label>Optional sound tags<textarea rows={2} maxLength={4200} value={soundTags} onChange={event => setSoundTags(event.target.value)} /></label>
              <button className="text-button" type="button" disabled={styleTags === defaultStyleTags && soundTags === defaultSoundTags}
                onClick={() => { setStyleTags(defaultStyleTags); setSoundTags(defaultSoundTags); }}>Reset tag lists</button>
              {tagLists.success ? <ul className="script-tag-rules">{expressionTagRules(tagLists.data).map(rule => <li key={rule}>{rule}</li>)}</ul>
                : <p className="error-text" role="alert">{tagLists.error.issues[0].message}</p>}
            </div>
          </details>}
          <div className="button-row">
            <button className="secondary" type="button" disabled={!readyToImprove || controlsDisabled} onClick={() => void improveBrief()}>Improve with AI</button>
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
          <div className="script-template-save-group">
            <div className="button-row script-template-save">
              <label>New template name<input value={templateName} maxLength={MAX_TEMPLATE_NAME_LENGTH} aria-describedby={templateSaveHintId}
                onChange={event => setTemplateName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing) saveTemplate(); } }} /></label>
              <button className="secondary" type="button" disabled={!templateName.trim() || !prompt.trim()} onClick={saveTemplate}>Save as template</button>
              <button className="secondary" type="button" disabled={!prompt.trim() || prompt === defaultBrief} onClick={saveAsDefault}>Save as default</button>
            </div>
            <small id={templateSaveHintId} className="muted">Saved in this browser. Your default loads on startup. The original template is unchanged.</small>
            {templateStatus && <p role="status">{templateStatus}</p>}
            {templateError && <p className="error-text" role="alert">{templateError}</p>}
          </div>
        </fieldset>
      </section>
      <section className="card script-generation-card" aria-labelledby={localesHeadingId}>
        <h2 id={localesHeadingId}>02 · Languages / Accents</h2>
        <fieldset disabled={!!busy || previewIsGenerating || isRegenerating} aria-labelledby={localesHeadingId}>
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
              {options.length ? <div className="script-locale-columns">
                {options.map(({ value, label }) => <label key={value}><input type="checkbox" checked={locales.includes(value)} disabled={catalogLoading}
                  onChange={event => setSelection(event.target.checked ? [...locales, value] : locales.filter(locale => locale !== value))} />{label}</label>)}
              </div> : <p className="muted">No matching Azure TTS locales.</p>}
            </div></>}
        </fieldset>
        {deployment && <p className="muted">Text deployment: <strong>{deployment}</strong></p>}
        <div className="button-row">
          <button className="primary" disabled={controlsDisabled || !readyToGenerate || !locales.length} type="submit">Generate preview</button>
          {preview?.state === 'running' && <button className="secondary" type="button" disabled={unavailable} onClick={() => runAction('pause')}>Pause</button>}
          {(preview?.state === 'running' || preview?.state === 'pausing') &&
            <button className="secondary" type="button" disabled={unavailable} onClick={() => runAction('stop')}>Stop</button>}
          {(preview?.state === 'running' || preview?.state === 'pausing' || preview?.state === 'stopping' || preview?.state === 'paused') &&
            <button className="secondary danger" type="button" disabled={unavailable} onClick={() => runAction('cancel')}>Cancel</button>}
          {(preview?.state === 'paused' || preview?.state === 'failed') &&
            <button className="secondary" type="button" disabled={controlsDisabled} onClick={() => runAction('resume')}>Resume</button>}
          {preview && !previewIsGenerating &&
            <button className="secondary" type="button" disabled={controlsDisabled} onClick={() => runAction('restart')}>Restart</button>}
          {isRegenerating &&
            <button className="secondary" type="button" disabled={unavailable} onClick={() => runAction('stop-regeneration')}>Stop regeneration</button>}
          {textRequest && <button className="secondary" type="button" disabled={commandPending || textRequest.cancelling}
            onClick={() => void runCommand(`${runPath}/cancel-text`, { id: textRequest.id })}>Cancel text request</button>}
        </div>
        <small>Generation continues across browser refreshes. Each Azure OpenAI attempt may incur charges.</small>
        {!runStatus && !statusError && <p role="status">Checking generation status…</p>}
        {runStatus?.textBusy && <p role="status">{textRequest?.cancelling ? 'Cancelling Azure text request…' :
          textRequest?.kind === 'improve-brief' ? 'Improving the brief with Azure…' : 'Another Azure text request is running.'}</p>}
        {preview && <p role="status">{{
          running: preview.retryAt ? 'Waiting to retry' : 'Generating scripts',
          pausing: 'Pausing after the current requests finish',
          stopping: 'Stopping active requests',
          cancelling: 'Cancelling the run',
          paused: 'Paused',
          cancelled: 'Run cancelled',
          completed: 'Run finished',
          failed: 'Run interrupted',
        }[preview.state]} · {scripts.length}/{preview.input.locales.length} generated
          {failedLocales > 0 && ` · ${failedLocales} failed`}
          {preview.activeLocales.length > 0 && ` · ${preview.activeLocales.map(locale => studioLocaleLabel(locale)).join(', ')}`}
        </p>}
        {statusError && <p className="error-text" role="alert">Could not check generation status: {statusError}</p>}
        {preview?.error && <p className="error-text" role="alert">{preview.error}</p>}
        {generationError && <p className="error-text" role="alert">{generationError}</p>}
      </section>
    </form>

    <form className="card script-generation-card" onSubmit={save}>
      <h2>03 · Preview and save</h2>
      {!preview && <p className="muted">Generate a successful preview before saving. The destination folder only controls where the files are written.</p>}
      {preview && <p role="status">{scripts.length} of {preview.input.locales.length} scripts generated.
        {failedLocales > 0 && ` ${failedLocales} failed.`}
        {scripts.length + failedLocales < preview.input.locales.length && ` ${preview.input.locales.length - scripts.length - failedLocales} ${previewIsGenerating ? 'pending' : 'unfinished'}.`}</p>}
      {preview && <small>Expression tags: {preview.input.expressionTags ? 'On' : 'Off'}. Regenerate retries recoverable errors until it succeeds or you stop it. It uses the original brief and settings and replaces only that locale on success. Azure OpenAI charges may apply to each attempt.</small>}
      {preview?.results.map(result => {
        const locale = resultLocale(result);
        const label = studioLocaleLabel(locale);
        const needsRetry = 'error' in result && result.retryAfterMs !== undefined;
        const isRetrying = previewIsGenerating && needsRetry;
        const feedback = regeneration?.locale === locale ? regeneration : undefined;
        const actions = !isRetrying && <div className="script-locale-actions">
          <div className="button-row">
            {feedback?.state !== 'running' && <button className="secondary" type="button" disabled={!canRegenerate}
                aria-label={`Regenerate ${label}`} onClick={() => runAction('regenerate', locale)}>Regenerate</button>}
          </div>
          {feedback && <p className={feedback.state === 'error' ? 'error-text' : 'muted'}
            role={feedback.state === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
        </div>;
        const key = `${preview.id}:${locale}`;
        return 'script' in result
          ? <details className="script-preview" key={key} open={locale === preview.firstLocale}>
            <summary>{scriptFileName(locale, preview.input.style)} · {result.script.utterances.length} utterances</summary>
            <pre>{scriptFileText(result.script, preview.input.speakers)}</pre>
            {actions}
          </details>
          : <div className="script-preview script-locale-issue" key={key}>
            <p><strong>{label}</strong> · <span role={isRetrying ? 'status' : undefined}>{isRetrying ? 'Retrying' : needsRetry ? 'Retry pending' : 'Not generated'}</span></p>
            <p className={isRetrying ? 'muted' : 'error-text'}>{result.error}</p>
            {actions}
          </div>;
      })}
      <label>Destination folder<input value={directory} disabled={controlsDisabled} maxLength={2048}
        onChange={event => { setDirectory(event.target.value); setSaved(undefined); setSaveError(''); }}
        placeholder="C:\Users\You\Documents\Scripts" required /></label>
      <p className="muted">Paste an existing local folder path. Filenames use the locale and script style, for example <code>en-US_Warm_documentary_narration.txt</code>. Each UTF-8 line contains an utterance filename, a tab, and spoken text. Existing files are not overwritten.</p>
      <button className="primary" disabled={controlsDisabled || !scripts.length || !directory.trim()} type="submit">
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
