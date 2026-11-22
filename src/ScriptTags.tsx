import { useEffect, useRef, useState } from 'react';
import { DEFAULT_EXPRESSION_TAG_LISTS, type ExpressionTagLists } from '../shared/scriptExpressionTags';
import { decodeStudioText, MAX_SCRIPT_FILE_BYTES, scriptInputs, scriptPaths, type ScriptInput } from '../shared/scriptSources';
import {
  MAX_TAG_SCRIPT_FILES, scriptHasExpressionTags, scriptTagInspectionSchema, scriptTagRequestSchema,
  type ScriptTagInspection, type ScriptTagRequest, type ScriptTagResult,
} from '../shared/scriptTags';
import type { AppRequest } from './AzureSettings';

type TagState = 'empty' | 'unchecked' | 'checking' | 'tagged' | 'untagged' | 'mixed' | 'error';

function inspectionState(items?: ScriptTagInspection[]): TagState {
  if (!items) return 'unchecked';
  if (!items.length || items.some(item => item.error || item.tagged === undefined)) return 'error';
  const tagged = items.map(item => item.tagged);
  if (tagged.some(Boolean) && tagged.some(value => !value)) return 'mixed';
  return tagged[0] ? 'tagged' : 'untagged';
}

export function ScriptTags({
  request, tagLists, styleTags, soundTags, tagListsError,
  onStyleTagsChange, onSoundTagsChange, onResetTagLists,
  canAdd, azureBusy, onConfigure,
}: {
  request: AppRequest;
  tagLists?: ExpressionTagLists;
  styleTags: string;
  soundTags: string;
  tagListsError?: string;
  onStyleTagsChange: (value: string) => void;
  onSoundTagsChange: (value: string) => void;
  onResetTagLists: () => void;
  canAdd: boolean;
  azureBusy: boolean;
  onConfigure: () => void;
}) {
  const [mode, setMode] = useState<ScriptInput>('text');
  const [name, setName] = useState('script_001');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState('');
  const [paths, setPaths] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<ScriptTagRequest['action']>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<ScriptTagResult[]>([]);
  const [uploadInspection, setUploadInspection] = useState<ScriptTagInspection[]>();
  const [uploadChecking, setUploadChecking] = useState(false);
  const [pathInspection, setPathInspection] = useState<ScriptTagInspection[]>();
  const [pathChecking, setPathChecking] = useState(false);
  const running = useRef<AbortController>(undefined);
  const pathInspectionVersion = useRef(0);
  const pathList = mode === 'folder' ? folder.trim() ? [folder] : [] : scriptPaths(paths);
  const ready = mode === 'text' ? Boolean(name.trim() && text.trim()) : mode === 'upload' ? files.length > 0 : pathList.length > 0;
  const describeError = (error: unknown) => error instanceof Error ? error.message : 'Could not process the script.';

  useEffect(() => {
    let cancelled = false;
    if (mode !== 'upload' || !files.length) {
      setUploadInspection(undefined);
      setUploadChecking(false);
      return () => { cancelled = true; };
    }
    setUploadInspection(undefined);
    setUploadChecking(true);
    void (async () => {
      const inspected: ScriptTagInspection[] = [];
      if (files.length > MAX_TAG_SCRIPT_FILES) {
        inspected.push({ source: 'Selected files', error: `Choose at most ${MAX_TAG_SCRIPT_FILES} files.` });
      } else {
        for (const file of files) {
          try {
            if (!/\.txt$/i.test(file.name) || file.size > MAX_SCRIPT_FILE_BYTES)
              throw new Error('Choose a .txt file of at most 2 MB.');
            const content = decodeStudioText(new Uint8Array(await file.arrayBuffer()));
            inspected.push({ source: file.name, tagged: scriptHasExpressionTags(content, tagLists ?? DEFAULT_EXPRESSION_TAG_LISTS) });
          } catch (problem) {
            inspected.push({ source: file.name, error: describeError(problem) });
          }
        }
      }
      if (!cancelled) {
        setUploadInspection(inspected);
        setUploadChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [files, mode, styleTags, soundTags]);

  useEffect(() => {
    pathInspectionVersion.current++;
    setPathInspection(undefined);
    setPathChecking(false);
    setConsent(false);
  }, [styleTags, soundTags]);

  const inputTagState: TagState = tagListsError ? 'error' : mode === 'text'
    ? !text.trim() ? 'empty' : scriptHasExpressionTags(text, tagLists ?? DEFAULT_EXPRESSION_TAG_LISTS) ? 'tagged' : 'untagged'
    : mode === 'upload'
      ? !files.length ? 'empty' : uploadChecking ? 'checking' : inspectionState(uploadInspection)
      : !pathList.length ? 'empty' : pathChecking ? 'checking' : inspectionState(pathInspection);
  const availableAction: ScriptTagRequest['action'] | undefined = inputTagState === 'tagged' ? 'remove'
    : inputTagState === 'untagged' ? 'add' : undefined;
  const inspectionItems = mode === 'upload' ? uploadInspection : pathInspection;
  const inspectionError = inspectionItems?.find(item => item.error)?.error;
  const tagStateMessage = inputTagState === 'tagged' ? 'Expression tags found. Only Remove tags is available.'
    : inputTagState === 'untagged' ? 'No existing expression tags found. Add tags with AI is available; spoken text is preserved.'
    : inputTagState === 'mixed' ? 'This selection contains both tagged and untagged scripts. Separate them so only the matching action is available.'
    : inputTagState === 'checking' ? 'Checking scripts for existing expression tags…'
    : inputTagState === 'unchecked' ? 'Check the selected paths to find out which action is available.'
    : inputTagState === 'error' ? tagListsError ?? inspectionError ?? 'Could not check the selected scripts.'
    : undefined;

  async function inspectPaths() {
    if (!pathList.length || pathChecking || busy || tagListsError) return;
    const input = scriptTagInspectionSchema.safeParse({
      source: { type: 'paths', paths: pathList },
      tagLists,
    });
    if (!input.success) {
      setPathInspection([{ source: 'Paths', error: input.error.issues.map(issue => issue.message).join(' ') }]);
      return;
    }
    const version = ++pathInspectionVersion.current;
    setPathChecking(true);
    setPathInspection(undefined);
    try {
      const inspected = await request<ScriptTagInspection[]>('/api/script-generation/tags/inspect', input.data, 'POST');
      if (version === pathInspectionVersion.current) setPathInspection(inspected);
    } catch (problem) {
      if (version === pathInspectionVersion.current)
        setPathInspection([{ source: 'Paths', error: describeError(problem) }]);
    } finally {
      if (version === pathInspectionVersion.current) setPathChecking(false);
    }
  }

  async function apply(action: ScriptTagRequest['action']) {
    if (!ready || action !== availableAction || running.current ||
      (action === 'add' && (!canAdd || azureBusy || !consent || !tagLists))) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(action); setError(''); setResults([]); setStatus(action === 'add' ? 'Adding tags…' : 'Removing tags…');
    const process = async (source: ScriptTagRequest['source']) => {
      controller.signal.throwIfAborted();
      const input = scriptTagRequestSchema.safeParse({ action, source, tagLists, consent });
      if (!input.success) throw new Error(input.error.issues.map(issue => issue.message).join(' '));
      const batch = await request<ScriptTagResult[]>('/api/script-generation/tags', input.data, 'POST', controller.signal);
      setResults(previous => [...previous, ...batch]);
      return batch;
    };
    try {
      let results: ScriptTagResult[];
      if (mode === 'upload') {
        if (files.length > MAX_TAG_SCRIPT_FILES) throw new Error(`Choose at most ${MAX_TAG_SCRIPT_FILES} files.`);
        results = [];
        for (const file of files) {
          try {
            if (!/\.txt$/i.test(file.name) || file.size > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a .txt file of at most 2 MB.');
            results.push(...await process({ type: 'text', name: file.name, text: decodeStudioText(new Uint8Array(await file.arrayBuffer())) }));
          } catch (problem) {
            controller.signal.throwIfAborted();
            const failure = { source: file.name, name: file.name, error: describeError(problem) };
            results.push(failure); setResults(previous => [...previous, failure]);
          }
        }
      } else {
        results = await process(mode === 'text' ? { type: 'text', name, text } : { type: 'paths', paths: pathList });
      }
      const failed = results.filter(result => result.error).length;
      setStatus(`${results.length - failed} processed${failed ? `, ${failed} failed` : ''}.`);
    } catch (problem) {
      if (controller.signal.aborted) setStatus('Stopped. Any outputs already saved to disk were kept.');
      else { setError(describeError(problem)); setStatus(''); }
    } finally { running.current = undefined; setBusy(undefined); }
  }

  function download(result: ScriptTagResult) {
    const url = URL.createObjectURL(new Blob([result.text ?? ''], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <section className="card script-generation-card">
      <h2>01 · Scripts</h2>
      <p className="muted">Untagged scripts can have tags added without changing their spoken text. Tagged scripts can only have their tags removed.</p>
      <div className="button-row studio-input-modes" role="group" aria-label="Script input method">
        {scriptInputs.map(input => <button key={input.id} type="button" className={mode === input.id ? 'primary' : 'secondary'}
          aria-pressed={mode === input.id} disabled={!!busy || pathChecking} onClick={() => {
            setMode(input.id); setConsent(false); pathInspectionVersion.current++; setPathInspection(undefined);
          }}>{input.label}</button>)}
      </div>
      <div className="studio-source-panel">
        {mode === 'text' && <>
          <label>Script name<input value={name} disabled={!!busy} onChange={event => setName(event.target.value)} /></label>
          <label>Paste script text<textarea rows={5} value={text} disabled={!!busy} onChange={event => { setText(event.target.value); setConsent(false); }} /></label>
        </>}
        {mode === 'upload' && <label>Choose .txt files<input type="file" accept=".txt,text/plain" multiple disabled={!!busy}
          onChange={event => { setFiles(Array.from(event.target.files ?? [])); setConsent(false); }} /></label>}
        {mode === 'folder' && <label>Absolute folder path<input value={folder} disabled={!!busy || pathChecking}
          placeholder={'C:\\Scripts\\Greetings'} onChange={event => {
            pathInspectionVersion.current++; setFolder(event.target.value); setPathInspection(undefined); setConsent(false);
          }} /></label>}
        {mode === 'paths' && <label>Absolute .txt file or folder paths, one per line<textarea rows={4} value={paths} disabled={!!busy || pathChecking}
          placeholder={'"C:\\Scripts\\greeting.txt"\n"C:\\Scripts\\Closings"'} onChange={event => {
            pathInspectionVersion.current++; setPaths(event.target.value); setPathInspection(undefined); setConsent(false);
          }} /></label>}
        {(mode === 'folder' || mode === 'paths') && <p className="hint">Only .txt files directly in each folder are included. Windows “Copy as path” quotes are accepted.</p>}
      </div>
    </section>
    <section className="card script-generation-card">
      <h2>02 · Expression tags</h2>
      <details className="script-tag-list-settings">
        <summary>Edit tag lists</summary>
        <div className="script-tag-editor">
          <small className="muted">Separate names with commas or line breaks. Changes apply to both Script tags and Generate scripts in this session.</small>
          <label>Allowed style tags<textarea rows={3} maxLength={4200} value={styleTags} onChange={event => onStyleTagsChange(event.target.value)} /></label>
          <label>Optional sound tags<textarea rows={2} maxLength={4200} value={soundTags} onChange={event => onSoundTagsChange(event.target.value)} /></label>
          <button className="text-button" type="button"
            disabled={styleTags === DEFAULT_EXPRESSION_TAG_LISTS.styles.join(', ') && soundTags === DEFAULT_EXPRESSION_TAG_LISTS.sounds.join(', ')}
            onClick={onResetTagLists}>Reset tag lists</button>
        </div>
      </details>
      {tagListsError && <p className="error-text" role="alert">{tagListsError}</p>}
      {availableAction === 'add' && canAdd && <label className="checkbox-line"><input type="checkbox" checked={consent} disabled={!!busy}
          onChange={event => setConsent(event.target.checked)} /> Send spoken script text to the configured Azure text deployment to add tags. Charges may apply. Only use scripts approved for that service.</label>}
      {tagStateMessage && <p className={inputTagState === 'error' ? 'error-text' : 'hint'} role={inputTagState === 'error' ? 'alert' : 'status'}>{tagStateMessage}</p>}
      <div className="button-row" role="group" aria-label="Script tag controls">
        {(mode === 'folder' || mode === 'paths') && inputTagState === 'unchecked' &&
          <button type="button" className="secondary" disabled={!ready || pathChecking || !!busy || !!tagListsError}
            onClick={() => void inspectPaths()}>{pathChecking ? 'Checking scripts…' : 'Check scripts'}</button>}
        {availableAction === 'add' && !canAdd &&
          <button className="secondary" type="button" onClick={onConfigure}>Configure text deployment</button>}
        {availableAction === 'add' &&
          <button type="button" className="primary" disabled={!ready || !!busy || !canAdd || azureBusy || !consent || !tagLists}
            onClick={() => void apply('add')}>Add tags with AI</button>}
        {availableAction === 'remove' &&
          <button type="button" className="secondary" disabled={!ready || !!busy}
            onClick={() => void apply('remove')}>Remove tags</button>}
        {busy && <button type="button" className="secondary" onClick={() => running.current?.abort()}>Stop</button>}
      </div>
      {azureBusy && !busy && <p className="hint" role="status">Another Azure text request is running.</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </section>
    {results.length > 0 && <section className="card script-generation-card">
      <h2>03 · Results</h2>
      {results.map((result, index) => <div className="script-preview script-tag-result" key={`${index}-${result.source}`}>
        <strong>{result.name}</strong>
        {result.error ? <p className="error-text">{result.source}: {result.error}</p> : result.path ? <p className="muted">{result.path}</p> : <>
          <button type="button" className="secondary" onClick={() => download(result)}>Download</button>
          <details><summary>Preview</summary><pre>{result.text}</pre></details>
        </>}
      </div>)}
    </section>}
  </>;
}
