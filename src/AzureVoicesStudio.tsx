import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_STUDIO_VOICES, STUDIO_SYNTHESIS_BATCH_SIZE, type StudioCell, type StudioPlan, type StudioRun, type StudioScript, type StudioSpeechStatus, type StudioVoice } from '../shared/studio';
import { sortStudioVoices, studioLocaleLabel, studioLocaleOptions, studioVoiceLocales, studioVoiceMatches, studioVoiceModel, type StudioVoiceSort } from '../shared/studioVoices';
import { studioExpressionMarkup, studioSsml } from '../shared/studioSsml';
import { useTableSort } from './TableSort';
import { MultiFilter } from './MultiFilter';
import { decodeStudioText, MAX_SCRIPT_FILE_BYTES, scriptInputs, scriptPaths, type ScriptInput } from '../shared/scriptSources';

type ParseResult = { script: StudioScript; warnings: string[] };
type PathResult = { name: string; script?: StudioScript; warnings?: string[]; error?: string };
const catalogColumns: { key: StudioVoiceSort['key']; label: string }[] = [
  { key: 'voice', label: 'Voice' },
  { key: 'language', label: 'Primary language' },
  { key: 'gender', label: 'Gender' },
  { key: 'model', label: 'Model' },
  { key: 'localeCount', label: 'Supported languages' },
];

function StudioCellPages({ cells, mode, language, children }: {
  cells: StudioCell[]; mode: 'preview' | 'results'; language: (cell: StudioCell) => string;
  children: (visible: readonly StudioCell[], headings: ReactNode) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const sorting = useTableSort();
  const reset = () => setPage(0);
  const action = (cell: StudioCell) => cell.status === 'skipped' ? 'Skip existing' : 'Synthesize';
  const sorted = sorting.rows(cells, {
    clip: cell => `${cell.script} / ${cell.clip}`, voice: cell => cell.voice.ShortName, language,
    status: cell => mode === 'preview' ? action(cell) : cell.status, path: cell => cell.error || cell.path,
  });
  const headings = <>
    {sorting.header('clip', 'Clip', 'ascending', reset)}{sorting.header('voice', 'Voice', 'ascending', reset)}
    {sorting.header('language', 'Language', 'ascending', reset)}{sorting.header('status', mode === 'preview' ? 'Action' : 'Status', 'ascending', reset)}
    {mode === 'results' && <th scope="col">Audio</th>}
    {mode === 'preview' && <th scope="col">SSML</th>}
    {sorting.header('path', mode === 'preview' ? 'Output path' : 'Path / error', 'ascending', reset)}
  </>;
  const pageSize = 100;
  const pages = Math.ceil(cells.length / pageSize);
  const offset = page * pageSize;
  return <>
    {children(sorted.slice(offset, offset + pageSize), headings)}
    {pages > 1 && <div className="button-row">
      <button className="secondary" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous clips</button>
      <span role="status">{offset + 1}–{Math.min(offset + pageSize, cells.length)} of {cells.length.toLocaleString()} pairs</span>
      <button className="secondary" type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next clips</button>
    </div>}
  </>;
}

function StudioSsmlPreview({ cell }: { cell: StudioCell }) {
  const [open, setOpen] = useState(false);
  const conversion = open ? studioExpressionMarkup(cell.voice, cell.text) : undefined;
  return <details className="studio-ssml-preview" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Show SSML</summary>
    {conversion?.unlistedStyles.length ? <p className="hint">
      These styles are not advertised by this voice but are included in the SSML: {conversion.unlistedStyles.join(', ')}. Azure may ignore unsupported styles.
    </p> : null}
    {conversion?.soundTags.length ? <p className="hint">
      Sound-effect tags are omitted and do not produce audio effects: {conversion.soundTags.join(', ')}.
    </p> : null}
    {open && <pre><code>{studioSsml(cell.voice, cell.text, cell.locale, 0, 0)}</code></pre>}
  </details>;
}

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const data: { error?: string } = await response.json();
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

export function AzureVoicesStudio({ status, onConfigure, onError: setError }: {
  status?: StudioSpeechStatus; onConfigure: () => void; onError: (message: string) => void;
}) {
  const [voices, setVoices] = useState<StudioVoice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef(selected);
  const selectAllRef = useRef<HTMLInputElement>(null);
  selectedRef.current = selected;
  const [language, setLanguage] = useState<string[]>([]);
  const [gender, setGender] = useState<string[]>([]);
  const [model, setModel] = useState<string[]>([]);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [voiceSort, setVoiceSort] = useState<StudioVoiceSort>();
  const [ssmlLocale, setSsmlLocale] = useState('');
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [voicesError, setVoicesError] = useState('');
  const [voicesNotice, setVoicesNotice] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [scripts, setScripts] = useState<StudioScript[]>([]);
  const [scriptInput, setScriptInput] = useState<ScriptInput>('text');
  const scriptFileInput = useRef<HTMLInputElement>(null);
  const [scriptName, setScriptName] = useState('script_001');
  const [text, setText] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [paths, setPaths] = useState('');
  const [scriptErrors, setScriptErrors] = useState<string[]>([]);
  const [scriptNotes, setScriptNotes] = useState<string[]>([]);
  const [parent, setParent] = useState('');
  const [plan, setPlan] = useState<StudioPlan>();
  const [run, setRun] = useState<StudioRun>();
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const running = run?.status === 'running';
  const pausing = run?.status === 'pausing';
  const locked = busy || running || pausing;
  const remaining = run?.cells.filter(cell => cell.status === 'queued').length ?? 0;
  const resumable = remaining > 0 && run?.status === 'paused';
  const resultCells = useMemo(() => {
    if (!run?.missingAudioIds?.length) return run?.cells ?? [];
    const missing = new Set(run.missingAudioIds);
    return run.cells.filter(cell => !missing.has(cell.id));
  }, [run]);
  const updateRun = useCallback((next: StudioRun) => setRun(previous => next.id === previous?.id && next.missingAudioIds === undefined
    ? { ...next, missingAudioIds: previous.missingAudioIds }
    : next), []);
  const voiceControlsLocked = locked || voicesLoading;
  const selectedNames = useMemo(() => new Set(selected), [selected]);
  const chosen = useMemo(() => voices.filter(voice => selectedNames.has(voice.ShortName)), [voices, selectedNames]);
  const locales = useMemo(() => {
    if (!chosen.length) return [];
    return studioVoiceLocales(chosen[0])
      .filter(locale => chosen.every(voice => studioVoiceLocales(voice).some(item => item.toLowerCase() === locale.toLowerCase())))
      .sort((a, b) => a.localeCompare(b));
  }, [chosen]);
  const localeOptions = useMemo(() => studioLocaleOptions(voices), [voices]);
  const localeLabels = useMemo(() => new Map(localeOptions.map(option => [option.value.toLowerCase(), option.label])), [localeOptions]);
  const localeLabel = useCallback((locale: string) => localeLabels.get(locale.toLowerCase()) ?? studioLocaleLabel(locale), [localeLabels]);
  const genderOptions = [...new Set(voices.map(voice => voice.Gender))].sort();
  const modelOptions = useMemo(() => [...new Set(voices.map(studioVoiceModel))].sort((a, b) => a.localeCompare(b)), [voices]);
  const filtered = useMemo(() => voices.filter(voice => studioVoiceMatches(voice,
    { search: voiceSearch, locales: language, gender, model, styles: 'any' })), [voices, voiceSearch, language, gender, model]);
  const sortedVoices = useMemo(() => voiceSort ? sortStudioVoices(filtered, voiceSort, localeLabel) : filtered, [filtered, voiceSort, localeLabel]);
  const localeFromFilename = ssmlLocale === 'filename';
  const ssmlSupported = localeFromFilename || !ssmlLocale || locales.some(locale => locale.toLowerCase() === ssmlLocale.toLowerCase());
  const cellLanguage = ({ locale, languageFallback }: StudioCell) => languageFallback?.reason === 'unsupported-locale'
    ? `Default (${languageFallback.requestedLocale} unsupported)`
    : languageFallback ? 'Default (no recognized filename locale)' : locale || 'Auto';
  const filteredNames = useMemo(() => new Set(filtered.map(voice => voice.ShortName)), [filtered]);
  const selectedInResults = filtered.filter(voice => selectedNames.has(voice.ShortName)).length;
  const allResultsSelected = filtered.length > 0 && selectedInResults === filtered.length;
  const someResultsSelected = selectedInResults > 0 && !allResultsSelected;
  const selectionTooLarge = selected.length > MAX_STUDIO_VOICES;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someResultsSelected;
  }, [someResultsSelected]);
  const invalidate = () => setPlan(undefined);
  const perform = async (fn: () => Promise<void>, reportError: (message: string) => void = setError) => {
    setBusy(true); setError(''); setMessages([]);
    try { await fn(); } catch (problem) { reportError(problem instanceof Error ? problem.message : 'Unexpected error.'); }
    finally { setBusy(false); }
  };
  const performScript = (fn: () => Promise<void>) => {
    setScriptErrors([]); setScriptNotes([]);
    return perform(fn, message => setScriptErrors([message]));
  };
  useEffect(() => {
    let active = true;
    request<StudioRun[]>('/api/studio/runs').then(async runs => {
      if (!active) return;
      const latest = runs.find(item => item.status === 'running' || item.status === 'pausing') ?? runs[0];
      if (!latest) return;
      const current = await request<StudioRun>(`/api/studio/runs/${latest.id}?checkAudio=1`);
      if (!active) return;
      setRun(previous => previous ?? current);
    }).catch(problem => {
      if (!active) return;
      setError(problem instanceof Error ? problem.message : 'Could not load synthesis runs.');
    });
    return () => { active = false; };
  }, []);
  const runOutput = run?.byLocale;
  useEffect(() => {
    if (runOutput) { setParent(runOutput); setPlan(undefined); }
  }, [run?.id, runOutput]);
  const initializedOutput = useRef(false);
  useEffect(() => {
    if (!status || initializedOutput.current) return;
    initializedOutput.current = true;
    setParent(previous => previous || status.defaultOutput);
  }, [status]);
  useEffect(() => {
    if (!run || busy) return;
    const activeRun = running || pausing;
    let active = true;
    let checking = false;
    let timer: number | undefined;
    const poll = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await request<StudioRun>(`/api/studio/runs/${run.id}`);
        if (active) updateRun(next);
      } catch (problem) {
        if (active) setError(problem instanceof Error ? problem.message : 'Could not refresh run.');
      } finally {
        checking = false;
        if (active && activeRun) timer = window.setTimeout(poll, 1000);
      }
    };
    if (activeRun) timer = window.setTimeout(poll, 1000);
    else window.addEventListener('focus', poll);
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener('focus', poll); };
  }, [run?.id, running, pausing, busy, updateRun]);
  useEffect(() => {
    invalidate();
    if (!status?.configured) {
      setVoices([]); setSelected([]); setVoicesLoaded(false); setVoicesLoading(false); setVoicesError(''); setVoicesNotice('');
      return;
    }
    let active = true;
    setVoicesLoading(true); setVoicesError('');
    request<StudioVoice[]>(`/api/studio/voices${catalogRevision ? '?refresh=1' : ''}`).then(list => {
      if (!active) return;
      const available = new Set(list.map(voice => voice.ShortName));
      const previous = selectedRef.current;
      const retained = previous.filter(name => available.has(name));
      setSelected(retained); setVoices(list); setVoicesLoaded(true); invalidate();
      const removed = previous.length - retained.length;
      setVoicesNotice(removed ? `${removed} previously selected ${removed === 1 ? 'voice is' : 'voices are'} no longer available and ${removed === 1 ? 'was' : 'were'} removed.` : '');
    }).catch(problem => {
      if (active) setVoicesError(problem instanceof Error ? problem.message : 'Could not load the Azure voice catalog.');
    }).finally(() => { if (active) setVoicesLoading(false); });
    return () => { active = false; };
  }, [status, catalogRevision]);
  const addParsed = (results: ParseResult[]) => {
    setScripts(previous => [...previous, ...results.map(result => result.script)]);
    setScriptNotes([
      ...(results.length ? [`Added ${results.length} ${results.length === 1 ? 'script' : 'scripts'} to the set.`] : []),
      ...results.flatMap(result => result.warnings),
    ]);
    if (results.length) invalidate();
  };
  const addPaths = async (input: string[]) => {
    const results = await request<PathResult[]>('/api/studio/paths', 'POST', { paths: input });
    addParsed(results.filter((item): item is PathResult & { script: StudioScript } => !!item.script).map(item => ({ script: item.script, warnings: item.warnings ?? [] })));
    setScriptErrors(results.filter(item => item.error).map(item => `${item.name}: ${item.error}`));
  };
  const refreshVoices = () => { invalidate(); setCatalogRevision(previous => previous + 1); };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessages(['Path copied.']); }
    catch { setError('Could not copy the path. Select and copy the displayed path instead.'); }
  };

  return <section className="azure-voices-studio" aria-label="Azure Voices Studio">
    <div className="page-title"><h1>Azure Voices Studio</h1></div>
    {messages.map((message, index) => <p key={`${index}-${message}`} className="hint" role="status">{message}</p>)}
    {!status?.configured && <div className="callout azure-settings-prompt">
      <span>Azure Speech is required to load voices and synthesize audio.</span>
      <button type="button" className="secondary" onClick={onConfigure}>Configure Azure Speech</button>
    </div>}
    <section className="card studio-card">
      <h2>01 · Scripts</h2>
      <div className="button-row studio-input-modes" role="group" aria-label="Script input method">
        {scriptInputs.map(input => <button key={input.id} type="button" className={scriptInput === input.id ? 'primary' : 'secondary'}
          aria-pressed={scriptInput === input.id} disabled={locked} onClick={() => setScriptInput(input.id)}>{input.label}</button>)}
      </div>
      {scriptInput === 'text' && <div className="studio-source-panel">
        <label>Script name<input value={scriptName} disabled={locked} onChange={event => setScriptName(event.target.value)} /></label>
        <label>Paste script text<textarea rows={5} value={text} disabled={locked} placeholder={'Thank you for calling.\nHow can I help you today?'} onChange={event => setText(event.target.value)} /></label>
        <button className="secondary" disabled={locked || !scriptName.trim() || !text.trim()} onClick={() => void performScript(async () => {
          const result = await request<ParseResult>('/api/studio/scripts', 'POST', { name: scriptName, text });
          addParsed([result]); setText(''); setScriptName(`script_${String(scripts.length + 2).padStart(3, '0')}`);
        })}>Add script</button>
      </div>}
      {scriptInput === 'upload' && <div className="studio-source-panel">
        <p className="hint">Choose one or more .txt files. Their filenames become script names.</p>
        <input ref={scriptFileInput} type="file" accept=".txt,text/plain" multiple hidden disabled={locked} onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = '';
          if (!files.length) return;
          void performScript(async () => {
            const results: ParseResult[] = []; const failures: string[] = [];
            for (const file of files) {
              try {
                if (!/\.txt$/i.test(file.name) || file.size > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a .txt file of at most 2 MB.');
                results.push(await request<ParseResult>('/api/studio/scripts', 'POST', { name: file.name, text: decodeStudioText(new Uint8Array(await file.arrayBuffer())) }));
              } catch (problem) { failures.push(`${file.name}: ${problem instanceof Error ? problem.message : 'Could not read file.'}`); }
            }
            addParsed(results); setScriptErrors(failures);
          });
        }} />
        <button type="button" className="secondary" disabled={locked} onClick={() => {
          if (!scriptFileInput.current) {
            setScriptErrors(['The file picker is unavailable. Reload the workbench and try again.']);
            return;
          }
          scriptFileInput.current.click();
        }}>Choose .txt files</button>
      </div>}
      {scriptInput === 'folder' && <div className="studio-source-panel">
        <label>Absolute folder path<input value={folderPath} disabled={locked} placeholder={'C:\\Scripts\\Greetings'} onChange={event => setFolderPath(event.target.value)} /></label>
        <p className="hint">Adds every .txt file directly in this folder, not files in subfolders. Windows “Copy as path” quotes are accepted.</p>
        <button className="secondary" disabled={locked || !folderPath.trim()} onClick={() => void performScript(() => addPaths([folderPath]))}>Add folder scripts</button>
      </div>}
      {scriptInput === 'paths' && <div className="studio-source-panel">
        <label>Absolute .txt file paths, one per line<textarea rows={4} value={paths} disabled={locked}
          placeholder={'"C:\\Scripts\\greeting.txt"\n"C:\\Scripts\\closing.txt"'} onChange={event => setPaths(event.target.value)} /></label>
        <p className="hint">Paste one path per line, with or without Windows “Copy as path” quotes. Folder paths are also accepted.</p>
        <button className="secondary" disabled={locked || !paths.trim()} onClick={() => void performScript(() =>
          addPaths(scriptPaths(paths)))}>Add file paths</button>
      </div>}
      {scriptNotes.map((note, index) => <p className="hint" role="status" key={`${index}-${note}`}>{note}</p>)}
      {!!scriptErrors.length && <ul className="studio-source-errors error-text" role="alert">{scriptErrors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>}
      {!!scripts.length && <h3>Script set · {scripts.length}</h3>}
      {scripts.map((script, index) => <article className="studio-entry" key={`${script.name}-${index}`}>
        <div className="section-with-action"><strong>{script.name} · {script.clips.length} clips · {script.clips.reduce((sum, clip) => sum + clip.text.length, 0).toLocaleString()} characters</strong>
          <button className="text-button" disabled={locked} onClick={() => { setScripts(previous => previous.filter((_, i) => i !== index)); invalidate(); }}>Remove</button></div>
        <details><summary>Show clips and filenames</summary><ul>{script.clips.map(clip => <li key={`${clip.line}-${clip.name}`}><strong>{clip.name}.wav</strong> · {clip.text}</li>)}</ul></details>
      </article>)}
    </section>
    <section className="card studio-card">
      <h2>02 · Voice catalog</h2>
      <div className="field-row filter-bar studio-catalog-filters">
        <MultiFilter label="Language" all="All languages" options={localeOptions} value={language} disabled={voiceControlsLocked || !voicesLoaded} onChange={setLanguage} searchable />
        <MultiFilter label="Gender" all="All genders" options={genderOptions} value={gender} disabled={voiceControlsLocked || !voicesLoaded} onChange={setGender} />
        <MultiFilter label="Model type" all="All model types" options={modelOptions} value={model} disabled={voiceControlsLocked || !voicesLoaded} onChange={setModel} />
        <label>Search voices<input type="search" value={voiceSearch} disabled={voiceControlsLocked || !voicesLoaded}
          placeholder="Voice name, locale or model" onChange={event => setVoiceSearch(event.target.value)} /></label>
      </div>
      <div className="button-row studio-catalog-status">
        <strong role="status">{voicesLoading ? 'Loading voices…' : voicesLoaded ? `${filtered.length} results · ${voices.length} available · ${selected.length} selected` : 'Voice list not loaded'}</strong>
        <button className="text-button" disabled={voiceControlsLocked || !selected.length} onClick={() => { setSelected([]); invalidate(); }}>Clear selection</button>
        <button className="text-button" disabled={voiceControlsLocked || !status?.configured} onClick={refreshVoices}>Refresh voice list</button>
      </div>
      {voicesNotice && <p className="hint" role="status">{voicesNotice}</p>}
      {voicesError && <p className="error-text" role="alert">Could not load the voice catalog: {voicesError}{voicesLoaded ? ' The previous list is still shown; refresh before previewing.' : ''}</p>}
      {selectionTooLarge && <p className="hint" role="status">{selected.length} voices selected. Deselect {selected.length - MAX_STUDIO_VOICES} or more to preview a run (maximum {MAX_STUDIO_VOICES}).</p>}
      <div className="table-scroll table-scroll--with-selection studio-voices" tabIndex={0} role="region" aria-label="Voice catalog"><table><thead><tr><th scope="col">
        <input ref={selectAllRef} type="checkbox" aria-label="Select all matching voices" title="Select all matching voices"
          checked={allResultsSelected} disabled={voiceControlsLocked || !filtered.length} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => checked
              ? [...new Set([...previous, ...filteredNames])]
              : previous.filter(name => !filteredNames.has(name)));
            invalidate();
          }} />
        </th>{catalogColumns.map(({ key, label }) => {
          const direction = voiceSort?.key === key ? voiceSort.direction : undefined;
          return <th key={key} scope="col" aria-sort={direction}>
            <button className="studio-voice-sort" type="button" onClick={() => setVoiceSort({
              key, direction: direction === 'ascending' || (!direction && key === 'localeCount') ? 'descending' : 'ascending',
            })}>{label}<span aria-hidden="true">{direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '↕'}</span></button>
          </th>;
        })}</tr></thead>
        <tbody>{sortedVoices.map(voice => <tr key={voice.ShortName}><td><input type="checkbox" aria-label={`Select ${voice.ShortName}`} checked={selectedNames.has(voice.ShortName)}
          disabled={voiceControlsLocked} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => checked ? [...previous, voice.ShortName] : previous.filter(item => item !== voice.ShortName)); invalidate();
          }} /></td><td>{voice.DisplayName}<small>{voice.ShortName}</small></td><td>{voice.LocaleName || localeLabel(voice.Locale)}</td><td>{voice.Gender}</td>
          <td>{studioVoiceModel(voice)}</td><td title={studioVoiceLocales(voice).join(', ')}>{studioVoiceLocales(voice).length}</td></tr>)}</tbody></table></div>
      {voicesLoaded && !voicesLoading && !filtered.length && <p className="hint">{voices.length ? 'No voices match these filters.' : 'Azure returned no voices for this resource.'}</p>}
      <label>Supported language for SSML &lt;lang&gt; (optional)<select value={ssmlLocale} disabled={locked} onChange={event => { setSsmlLocale(event.target.value); invalidate(); }}>
        <option value="">None · default (no &lt;lang&gt; tag)</option>
        <option value="filename">From script filename</option>
        {!ssmlSupported && <option value={ssmlLocale}>{localeLabel(ssmlLocale)} (not supported by all selected voices)</option>}
        {locales.map(locale => <option key={locale} value={locale}>{localeLabel(locale)}</option>)}</select></label>
      <p className={ssmlSupported ? 'hint' : 'error-text'}>{!ssmlSupported ? 'This language is not supported by every selected voice. Choose another or None.'
        : localeFromFilename ? 'Use the leading locale in each script name (e.g. zh-HK_appointments). Missing or unsupported locales use the voice default without a <lang> tag; Preview and Results show which clips fall back.'
        : !chosen.length ? 'Select voices to see the languages they all support.'
        : ssmlLocale ? `Every line is wrapped in <lang xml:lang="${ssmlLocale}">.` : 'No <lang> tag is added; each voice uses its default language.'}</p>    </section>
    <section className="card studio-card">
      <h2>03 · Review &amp; synthesize</h2>
      <div className="field-row">
        <label>Output folder<input value={parent} disabled={locked} onChange={event => { setParent(event.target.value); invalidate(); }} /></label>
      </div>
      <button className="secondary" disabled={voiceControlsLocked || !!voicesError || !scripts.length || !selected.length || selectionTooLarge || !ssmlSupported} onClick={() => void perform(async () => {
        invalidate(); setPlan(await request<StudioPlan>('/api/studio/plan', 'POST', { scripts: scripts.map(script => ({ ...script, locale: localeFromFilename ? '' : ssmlLocale })), ...(localeFromFilename && { localeFromFilename }), voices: selected, outputParent: parent.trim().replace(/^"(.*)"$/, '$1'), useExisting: false, rate: 0, pitch: 0, concurrency: 4 }));
      })}>Preview run</button>
      {plan && <div className="studio-plan">
        <h3>Preview · {plan.calls} synthesis calls · {plan.characters.toLocaleString()} text units</h3>
        <p>Output folder: <strong>{plan.byLocale}</strong></p>
        {plan.calls > STUDIO_SYNTHESIS_BATCH_SIZE && <p className="hint">Studio will process {Math.ceil(plan.calls / STUDIO_SYNTHESIS_BATCH_SIZE).toLocaleString()} batches automatically without creating numbered folders.</p>}
        {plan.warnings.map(warning => <p className="error-text" key={warning}>{warning}</p>)}
        <p className="hint">Each row is one script-line × voice cell. Expand <strong>Show SSML</strong> in a row to inspect what will be sent to Azure. Preview expires at {new Date(plan.expiresAt).toLocaleTimeString()}.</p>
        <StudioCellPages key={plan.token} cells={plan.cells} mode="preview" language={cellLanguage}>{(cells, headings) =>
          <div className="table-scroll studio-matrix" tabIndex={0} role="region" aria-label="Synthesis preview"><table><thead><tr>{headings}</tr></thead>
           <tbody>{cells.map(cell => <tr key={cell.id}><td>{cell.script} / {cell.clip}</td><td>{cell.voice.ShortName}</td><td>{cellLanguage(cell)}</td>
             <td>{cell.status === 'skipped' ? 'Skip existing' : 'Synthesize'}</td><td><StudioSsmlPreview cell={cell} /></td><td>{cell.path}</td></tr>)}</tbody></table></div>}
        </StudioCellPages>
      </div>}
      <div className="button-row" role="group" aria-label="Synthesis controls">
        <button className="primary" disabled={locked || !plan || Date.parse(plan.expiresAt) <= Date.now()} onClick={() => {
          if (!plan) return;
          const ok = window.confirm(`Start this run? ${plan.calls} Azure synthesis calls will send ${plan.characters.toLocaleString()} text units, plus SSML markup. Retries may incur additional charges.`);
          if (!ok) return;
          void perform(async () => {
            const token = plan.token; invalidate();
            setRun(await request<StudioRun>('/api/studio/runs', 'POST', { token, consent: true }));
          });
        }}>Start</button>
        <button className="secondary" disabled={busy || !running} onClick={() => {
          if (!run) return;
          void perform(async () => { updateRun(await request<StudioRun>(`/api/studio/runs/${run.id}/pause`, 'POST', {})); });
        }}>Stop</button>
        <button className="secondary" disabled={locked || !resumable || !status?.configured} onClick={() => {
          if (!run || !resumable) return;
          if (!window.confirm(`Resume up to ${remaining.toLocaleString()} pending synthesis requests in ${run.byLocale}? Azure charges may apply. Completed, skipped and failed clips will not be rerun.`)) return;
          void perform(async () => {
            const resumed = await request<StudioRun>(`/api/studio/runs/${run.id}/resume`, 'POST', { consent: true });
            updateRun(resumed);
            setParent(resumed.byLocale);
            invalidate();
          });
        }}>Resume</button>
        <button className="secondary danger" disabled={busy || !running} onClick={() => {
          if (!run || !window.confirm('Cancel this run? In-flight clips can finish and saved audio will be kept.')) return;
          void perform(async () => { updateRun(await request<StudioRun>(`/api/studio/runs/${run.id}/cancel`, 'POST', {})); });
        }}>Cancel</button>
      </div>
    </section>
    {run && <section className="card studio-card">
      <h2>04 · Results</h2>
      <p role="status">{run.status} · {resultCells.filter(cell => cell.status === 'done').length} done · {resultCells.filter(cell => cell.status === 'skipped').length} skipped · {resultCells.filter(cell => cell.status === 'failed').length} failed · {resultCells.length} total{run.missingAudioIds?.length ? ` · ${run.missingAudioIds.length.toLocaleString()} missing audio files hidden` : ''}</p>
      {resultCells.length > 0 && <progress max={resultCells.length} value={resultCells.filter(cell => ['done', 'skipped', 'failed'].includes(cell.status)).length} />}
      {run.error && <p className="error-text" role="alert">{run.error}</p>}
      <p>Output folder: <strong>{run.byLocale}</strong></p>
      <div className="button-row"><button className="secondary" onClick={() => void copy(run.byLocale)}>Copy output path</button>
        {run.reportPath && <button className="secondary" onClick={() => void copy(run.reportPath!)}>Copy run report path</button>}
      </div>
      {pausing && <p className="hint">Finishing in-flight clips and saving progress. No new clips will start.</p>}
      {resultCells.length > 0 && <StudioCellPages key={run.id} cells={resultCells} mode="results" language={cellLanguage}>{(cells, headings) =>
        <div className="table-scroll studio-matrix" tabIndex={0} role="region" aria-label="Synthesis results"><table><thead><tr>{headings}</tr></thead><tbody>
          {cells.map(cell => <tr key={cell.id}><td>{cell.script} / {cell.clip}</td><td>{cell.voice.ShortName}</td><td>{cellLanguage(cell)}</td><td>{cell.status}</td><td>{['done', 'skipped'].includes(cell.status) && <audio controls preload="none" src={`/api/studio/runs/${run.id}/audio/${cell.id}`} />}</td><td>{cell.error || cell.path}</td></tr>)}
        </tbody></table></div>}
      </StudioCellPages>}
    </section>}
  </section>;
}
