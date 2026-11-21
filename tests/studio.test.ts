import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.js';
import { wav } from '../server/audio.js';
import { BatchImport } from '../server/batch.js';
import { decodeStudioText, parseStudioScript } from '../server/studioScripts.js';
import { AzureVoicesStudio, studioSsml } from '../server/studio.js';
import { Store } from '../server/store.js';
import { AzureVoicesStudio as Studio } from '../src/AzureVoicesStudio.js';
import type { StudioPlan, StudioRun, StudioScript, StudioVoice } from '../shared/studio.js';
import { sortStudioVoices, studioLocaleOptions, studioVoiceLocales, studioVoiceMatches, studioVoiceModel, type StudioVoiceFilters } from '../shared/studioVoices.js';

const voices: StudioVoice[] = [
  { ShortName: 'en-US-Ava:DragonHDLatestNeural', DisplayName: 'Ava', Locale: 'en-US', Gender: 'Female', SecondaryLocaleList: ['fr-FR', 'es-MX'] },
  { ShortName: 'en-US-AndrewMultilingualNeural', DisplayName: 'Andrew', Locale: 'en-US', Gender: 'Male', SecondaryLocaleList: ['fr-FR', 'es-MX'] },
];
const standardVoice: StudioVoice = {
  ShortName: 'fr-FR-DeniseNeural', DisplayName: 'Denise', Locale: 'fr-FR', LocaleName: 'French (France)',
  Gender: 'Female', VoiceType: 'Neural', StyleList: ['cheerful'], SecondaryLocaleList: [],
};
const StudioView = () => createElement(Studio, { onConfigure() {}, onError() {} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('studio parses line formats and BOMs without silently speaking metadata', () => {
  const parsed = parseStudioScript('Greeting.txt', '---\r\nlocale: fr-FR\r\n---\r\nname\ttext\r\n// comment\r\none.wav\t"Bonjour ""ami"""\r\n\r\nPlain line\r\n\tempty name');
  assert.equal(parsed.script.locale, 'fr-FR');
  assert.deepEqual(parsed.script.clips.map(c => [c.name, c.text, c.line, c.source]), [
    ['one', 'Bonjour "ami"', 6, 'tab'], ['Greeting_L002', 'Plain line', 8, 'auto'], ['Greeting_L003', 'empty name', 9, 'auto'],
  ]);
  assert.equal(parsed.warnings.length, 2);
  assert.equal(decodeStudioText(Buffer.from([0xff, 0xfe, 0x48, 0, 0x69, 0])), 'Hi');
  assert.equal(decodeStudioText(Buffer.from([0xfe, 0xff, 0, 0x48, 0, 0x69])), 'Hi');
  assert.throws(() => decodeStudioText(Buffer.from([0xff])), /UTF-8/);
  assert.throws(() => parseStudioScript('CON', 'hello'), /Invalid script name/);
  assert.throws(() => parseStudioScript('script', 'named\t'), /empty/);
  assert.throws(() => parseStudioScript('script', '---\nvoices: example\n---\nHi'), /supports only a locale/);
  assert.throws(() => parseStudioScript('script', 'x'.repeat(3001)), /3,000/);
});

test('studio script input offers all four methods with paste selected by default', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  assert.match(html, /aria-label="Script input method"/);
  for (const label of ['Paste text', 'Upload .txt', 'Folder of .txt files', 'List of file paths']) assert.ok(html.includes(label));
  assert.match(html, /aria-pressed="true"[^>]*>Paste text/);
  assert.match(html, /Paste script text/);
  assert.match(html, /placeholder="Thank you for calling\.\nHow can I help you today\?"/);
  assert.doesNotMatch(html, /Use plain text, one clip per line|Choose an input method|No scripts added yet/);
});

test('studio page title has no badge or subtitle', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  assert.match(html, /<div class="page-title"><h1>Azure Voices Studio<\/h1><\/div>/);
});

test('voice catalog offers language, gender, model type, live search and an optional SSML language', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  for (const label of ['Language', 'Gender', 'Model type'])
    assert.match(html, new RegExp(`class="multi-filter"><span[^>]*>${label}</span>`));
  assert.match(html, /aria-label="Search language options"/);
  assert.match(html, /<label>Search voices<input[^>]+type="search"/);
  assert.match(html, /<th scope="col"><input[^>]+aria-label="Select all matching voices"[^>]+disabled=""/);
  for (const label of ['Voice', 'Primary language', 'Gender', 'Model', 'Supported languages'])
    assert.ok(html.includes(`<button class="studio-voice-sort" type="button">${label}<span aria-hidden="true">`));
  assert.match(html, /Supported language for SSML &lt;lang&gt; \(optional\)<select><option value="" selected="">None · default \(no &lt;lang&gt; tag\)/);
  assert.match(html, /<option value="filename">From script filename<\/option>/);
  assert.doesNotMatch(html, />Search<\/button>|Styles<select/);
});

test('voice catalog sorts counts numerically without changing the source order', () => {
  const broad = { ...voices[0], SecondaryLocaleList: ['EN-us', ...Array.from({ length: 10 }, (_, index) => `en-x-${index}`)] };
  const source = [voices[1], standardVoice, broad];
  assert.deepEqual(sortStudioVoices(source, { key: 'localeCount', direction: 'descending' }), [broad, voices[1], standardVoice]);
  assert.deepEqual(sortStudioVoices(source, { key: 'localeCount', direction: 'ascending' }), [standardVoice, voices[1], broad]);
  assert.deepEqual(sortStudioVoices(source, { key: 'voice', direction: 'ascending' }), [voices[1], broad, standardVoice]);
  assert.deepEqual(source, [voices[1], standardVoice, broad]);
});

test('studio prompts for shared Speech settings without rendering a credential form', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  assert.match(html, />Configure Azure Speech<\/button>/);
  assert.doesNotMatch(html, /type="password"|Save Speech connection/);
  const configured = renderToStaticMarkup(createElement(Studio, {
    status: { configured: true, region: 'eastus', endpoint: '', source: 'saved', defaultOutput: 'C:\\Scripts' },
    onConfigure() {},
    onError() {},
  }));
  assert.doesNotMatch(configured, /Configure Azure Speech|type="password"/);
});

test('studio review keeps output controls without rate, pitch or parallel request inputs', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  assert.match(html, /<label>Output folder<input/);
  assert.doesNotMatch(html, /Run folder name/);
  assert.doesNotMatch(html, /Skip valid existing WAV files|Preview is required before any billed synthesis/);
  assert.doesNotMatch(html, /Each script goes to every selected voice|creating one is not part of this draft/);
  assert.match(html, />Preview run<\/button>/);
  assert.doesNotMatch(html, /Rate \(%\)|Pitch \(%\)|Parallel requests/);
});

test('studio shows four synthesis controls without an empty results card or saved-run form', () => {
  const html = renderToStaticMarkup(createElement(StudioView));
  const controls = html.match(/aria-label="Synthesis controls">([^]*?)<\/div>/)?.[1] ?? '';
  assert.deepEqual([...controls.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ['Start', 'Stop', 'Resume', 'Cancel']);
  assert.match(controls, /<button[^>]* disabled=""[^>]*>Resume<\/button>/);
  assert.doesNotMatch(html, /04 · Results|Saved run report path|Open saved run|Recover saved run/);
});

test('language options use Azure names and keep distinct regions and secondary-only locales', () => {
  const options = studioLocaleOptions([
    ...voices, { ...standardVoice, LocaleName: 'French (France, catalog name)' },
    { ...standardVoice, Locale: 'fr-CA', LocaleName: 'French (Canada)', SecondaryLocaleList: ['FR-fr'] },
  ]);
  assert.deepEqual(options, [
    { value: 'en-US', label: 'English (United States) (en-US)' },
    { value: 'fr-CA', label: 'French (Canada) (fr-CA)' },
    { value: 'fr-FR', label: 'French (France, catalog name) (fr-FR)' },
    { value: 'es-MX', label: 'Spanish (Mexico) (es-MX)' },
  ]);
});

test('voice filters match primary and secondary locales, gender, model, styles and search', () => {
  const filters: StudioVoiceFilters = { search: '', locales: [], gender: '', model: '', styles: 'any' };
  assert.equal(studioVoiceModel(voices[0]), 'DragonHDLatestNeural');
  assert.equal(studioVoiceModel(voices[1]), 'MultilingualNeural');
  assert.equal(studioVoiceModel(standardVoice), 'Neural');
  assert.deepEqual(studioVoiceLocales({ ...voices[0], SecondaryLocaleList: ['en-us', 'fr-FR', 'FR-fr'] }), ['en-US', 'fr-FR']);
  const all = [...voices, standardVoice];
  assert.equal(all.filter(voice => studioVoiceMatches(voice, { ...filters, locales: ['fr-FR'] })).length, 3);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, locales: ['fr-FR'], gender: 'Female', model: 'Neural' })), [standardVoice]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, locales: ['fr-FR'], gender: ['Female', 'Other'], model: ['Neural', 'DragonHDLatestNeural'] })), [voices[0], standardVoice]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, locales: ['de-DE', 'ES-mx'], gender: 'Male' })), [voices[1]]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, styles: 'with' })), [standardVoice]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, search: 'dragonhdlatest' })), [voices[0]]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, search: 'french' })), [standardVoice]);
  assert.deepEqual(all.filter(voice => studioVoiceMatches(voice, { ...filters, search: ' aVa ', locales: ['fr-FR'], gender: 'Female' })), [voices[0]]);
});

test('voice catalog retains every Azure voice and its filter metadata, and refresh bypasses cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-voice-catalog-'));
  const previous = { region: process.env.AZURE_SPEECH_REGION, key: process.env.AZURE_SPEECH_KEY, endpoint: process.env.AZURE_SPEECH_ENDPOINT };
  process.env.AZURE_SPEECH_REGION = 'eastus'; process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key'; delete process.env.AZURE_SPEECH_ENDPOINT;
  const store = new Store(root); await store.init();
  let calls = 0;
  const speechFetch: typeof fetch = async () => { calls++; return Response.json([...voices, standardVoice]); };
  try {
    const studio = new AzureVoicesStudio(store, speechFetch);
    const first = await studio.voices();
    assert.equal(first.length, 3);
    assert.deepEqual(first.find(voice => voice.ShortName === standardVoice.ShortName), standardVoice);
    assert.equal((await studio.voices()).length, 3);
    assert.equal(calls, 1, 'An unexpired catalog should be reused.');
    assert.equal((await studio.voices(true)).length, 3);
    assert.equal(calls, 2, 'An explicit refresh should request Azure again.');
  } finally {
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = previous.region;
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.endpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT; else process.env.AZURE_SPEECH_ENDPOINT = previous.endpoint;
    await rm(root, { recursive: true, force: true });
  }
});

test('a cleared connection cannot cache a voice response still being read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-voice-clear-'));
  const previous = { region: process.env.AZURE_SPEECH_REGION, key: process.env.AZURE_SPEECH_KEY, endpoint: process.env.AZURE_SPEECH_ENDPOINT };
  process.env.AZURE_SPEECH_REGION = 'eastus'; process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key'; delete process.env.AZURE_SPEECH_ENDPOINT;
  const bodyStarted = deferred<void>(), releaseBody = deferred<void>();
  const response = Response.json([voices[0]]);
  response.json = async () => { bodyStarted.resolve(undefined); await releaseBody.promise; return [voices[0]]; };
  const requests: string[] = [];
  const speechFetch: typeof fetch = async input => {
    requests.push(String(input));
    return requests.length === 1 ? response : Response.json([standardVoice]);
  };
  try {
    const studio = new AzureVoicesStudio(new Store(root), speechFetch);
    const fetching = studio.voices(true);
    const rejected = assert.rejects(fetching, /Speech connection changed while loading voices/);
    await bodyStarted.promise;
    process.env.AZURE_SPEECH_REGION = 'westus';
    await studio.clear();
    releaseBody.resolve(undefined);
    await rejected;
    assert.deepEqual(await studio.voices(), [standardVoice]);
    assert.equal(requests.length, 2);
    assert.match(requests[0], /^https:\/\/eastus\./);
    assert.match(requests[1], /^https:\/\/westus\./);
  } finally {
    releaseBody.resolve(undefined);
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = previous.region;
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.endpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT; else process.env.AZURE_SPEECH_ENDPOINT = previous.endpoint;
    await rm(root, { recursive: true, force: true });
  }
});

test('saving a connection rejects an in-flight catalog from the previous resource', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-voice-save-'));
  const previous = { region: process.env.AZURE_SPEECH_REGION, key: process.env.AZURE_SPEECH_KEY, endpoint: process.env.AZURE_SPEECH_ENDPOINT };
  process.env.AZURE_SPEECH_REGION = 'eastus'; process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key'; delete process.env.AZURE_SPEECH_ENDPOINT;
  const started = deferred<void>(), response = deferred<Response>();
  const requests: string[] = [];
  const speechFetch: typeof fetch = async input => {
    requests.push(String(input));
    if (requests.length === 1) { started.resolve(undefined); return response.promise; }
    return Response.json([standardVoice]);
  };
  try {
    const studio = new AzureVoicesStudio(new Store(root), speechFetch);
    const fetching = studio.voices(true);
    const rejected = assert.rejects(fetching, /Speech connection changed while loading voices/);
    await started.promise;
    await studio.save({ region: 'westus', endpoint: '', apiKey: 'synthetic-new-speech-key' });
    response.resolve(Response.json(voices));
    await rejected;
    assert.deepEqual(await studio.voices(), [standardVoice]);
    assert.equal(requests.length, 2);
    assert.match(requests[0], /^https:\/\/eastus\./);
    assert.match(requests[1], /^https:\/\/westus\./);
  } finally {
    response.resolve(Response.json(voices));
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = previous.region;
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.endpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT; else process.env.AZURE_SPEECH_ENDPOINT = previous.endpoint;
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshing the catalog invalidates an in-progress preview', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-preview-refresh-'));
  const previous = { region: process.env.AZURE_SPEECH_REGION, key: process.env.AZURE_SPEECH_KEY, endpoint: process.env.AZURE_SPEECH_ENDPOINT };
  process.env.AZURE_SPEECH_REGION = 'eastus'; process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key'; delete process.env.AZURE_SPEECH_ENDPOINT;
  try {
    const studio = new AzureVoicesStudio(new Store(root), async () => Response.json(voices));
    await studio.voices();
    const input = {
      scripts: [parseStudioScript('greeting', 'Hello').script], voices: [voices[0].ShortName],
      outputParent: root, runName: 'preview', useExisting: false, rate: 0, pitch: 0, concurrency: 1,
    };
    const rejected = assert.rejects(studio.plan(input), /voice catalog or connection changed while preparing the preview/i);
    await studio.voices(true);
    await rejected;
    assert.equal((await studio.plan(input)).calls, 1);
  } finally {
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = previous.region;
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.endpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT; else process.env.AZURE_SPEECH_ENDPOINT = previous.endpoint;
    await rm(root, { recursive: true, force: true });
  }
});

test('script API accepts pasted text, individual files and non-recursive folders with per-file errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-script-inputs-'));
  const data = path.join(root, 'data'), folder = path.join(root, 'scripts'), nested = path.join(folder, 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(folder, 'first.txt'), 'First line\r\n// comment\r\nSecond line');
  await writeFile(path.join(folder, 'second.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello UTF-16', 'utf16le')]));
  await writeFile(path.join(folder, 'bad.txt'), Buffer.from([0xff]));
  await writeFile(path.join(folder, 'ignore.md'), 'Not a script');
  await writeFile(path.join(nested, 'nested.txt'), 'Not included');
  const file = path.join(root, 'separate file.txt');
  await writeFile(file, 'From a file path');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = await createApp({ dataDir: data, port: address.port });
  backend.app.use(backend.errors); server.on('request', backend.app);
  const api = (route: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  type InputResult = { name: string; script?: StudioScript; error?: string };
  try {
    const paste = await api('/api/studio/scripts', { name: 'typed', text: 'Pasted line one\nPasted line two' });
    assert.equal(paste.status, 200);
    assert.equal(((await paste.json()) as { script: StudioScript }).script.clips.length, 2);

    const folderResponse = await api('/api/studio/paths', { paths: [`"${folder}"`] });
    assert.equal(folderResponse.status, 200);
    const folderResults: InputResult[] = await folderResponse.json();
    assert.deepEqual(folderResults.filter(item => item.script).map(item => item.script!.name).sort(), ['first', 'second']);
    assert.equal(folderResults.find(item => item.script?.name === 'first')?.script?.clips.length, 2);
    assert.equal(folderResults.find(item => item.script?.name === 'second')?.script?.clips[0].text, 'Hello UTF-16');
    assert.match(folderResults.find(item => item.name.endsWith('bad.txt'))?.error ?? '', /Save the file as UTF-8/);
    assert.equal(folderResults.length, 3, 'Subfolders and non-text files are not included.');

    const listResponse = await api('/api/studio/paths', { paths: [`"${file}"`, path.join(root, 'missing.txt'), 'relative.txt'] });
    assert.equal(listResponse.status, 200);
    const listResults: InputResult[] = await listResponse.json();
    assert.equal(listResults[0].script?.name, 'separate file');
    assert.equal(listResults[0].script?.clips[0].text, 'From a file path');
    assert.ok(listResults[1].error);
    assert.match(listResults[2].error ?? '', /absolute/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('SSML escapes text and voice names, and only wraps explicitly selected languages', () => {
  const manual = studioSsml(voices[0], `A & <B> "quoted"`, 'fr-FR', -5, 2);
  assert.match(manual, /<lang xml:lang="fr-FR">/);
  assert.match(manual, /A &amp; &lt;B&gt; &quot;quoted&quot;/);
  assert.match(manual, /rate="-5%" pitch="\+2%"/);
  assert.doesNotMatch(studioSsml(voices[0], 'Hello', '', 0, 0), /<lang |<prosody /);
});

test('Speech credentials are DPAPI-protected and restored without exposing the key', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speech-credentials-'));
  const store = new Store(root); await store.init();
  const key = 'synthetic-only-speech-key';
  const speechFetch: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'), key);
    return Response.json(voices);
  };
  try {
    const studio = new AzureVoicesStudio(store, speechFetch);
    const status = await studio.save({ region: 'eastus', endpoint: '', apiKey: key });
    assert.equal(status.source, 'saved');
    assert.ok(!JSON.stringify(status).includes(key));
    assert.ok(!(await readFile(path.join(root, 'speech-connection.json'), 'utf8')).includes(key));
    const restored = new AzureVoicesStudio(store, speechFetch);
    await restored.load();
    assert.equal(restored.status().region, 'eastus');
    assert.equal((await restored.voices(true)).length, 2);
    await restored.clear();
    assert.notEqual(restored.status().source, 'saved');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('studio pauses in-flight work, reopens a legacy cancelled run and resumes only pending clips', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-resume-'));
  const previous = { ...process.env };
  process.env.AZURE_SPEECH_REGION = 'eastus';
  process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key';
  delete process.env.AZURE_SPEECH_ENDPOINT;
  const bytes = wav(Buffer.alloc(4800));
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const speech: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/voices/list')) return Response.json([voices[0]]);
    calls.push(String(init?.body));
    if (calls.length === 1) { entered(); await hold; }
    return new Response(new Uint8Array(bytes));
  };
  const wait = async (run: StudioRun) => {
    for (let i = 0; i < 200; i++) {
      if (!['running', 'pausing'].includes(run.status)) return;
      await delay(20);
    }
    assert.fail('Studio run did not settle.');
  };
  let run: StudioRun | undefined;
  try {
    const studio = new AzureVoicesStudio(new Store(root), speech);
    await studio.voices();
    const plan = await studio.plan({
      scripts: [parseStudioScript('example', 'First line\nSecond line\nThird line').script],
      voices: [voices[0].ShortName], outputParent: root, useExisting: false, rate: 0, pitch: 0, concurrency: 1,
    });
    run = await studio.start(plan.token, true);
    await started;
    assert.equal(studio.pause(run.id).status, 'pausing');
    await assert.rejects(studio.resume(run.id, true), /already starting, running or pausing/);
    release();
    await wait(run);
    assert.equal(run.status, 'paused', run.error);
    assert.deepEqual(run.cells.map(cell => cell.status), ['done', 'queued', 'queued']);
    assert.equal(calls.length, 1);
    assert.ok(run.reportPath);
    const checkpoint = JSON.parse(await readFile(run.reportPath, 'utf8')) as StudioRun;
    assert.equal(checkpoint.status, 'paused');
    const second = run.cells[1];
    await writeFile(second.path, bytes);
    const third = run.cells[2];
    const group = path.dirname(path.dirname(third.path));
    const legacyPath = path.join(`${group} part 2`, path.basename(path.dirname(third.path)), path.basename(third.path));
    checkpoint.cells[2].path = legacyPath;
    await writeFile(run.reportPath, JSON.stringify({ ...checkpoint, status: 'cancelled' }));
    const recovered = new AzureVoicesStudio(new Store(root), speech);
    const reopened = await recovered.reopen(run.reportPath);
    assert.equal(reopened.status, 'paused');
    assert.equal(reopened.id, run.id);
    assert.deepEqual(reopened.cells.map(cell => cell.status), ['done', 'skipped', 'queued']);
    assert.equal(calls.length, 1);
    await rm(reopened.cells[0].path);
    const view = await recovered.getRunView(run.id);
    assert.deepEqual(view.missingAudioIds, [reopened.cells[0].id]);
    assert.equal(view.byLocale, plan.byLocale);
    assert.equal(recovered.getRun(run.id).cells[0].status, 'done');
    await assert.rejects(recovered.resume(run.id, false), /confirmation/);
    run = await recovered.resume(run.id, true);
    await wait(run);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /Third line/);
    await assert.rejects(readFile(reopened.cells[0].path), { code: 'ENOENT' });
    assert.deepEqual((await recovered.getRunView(run.id)).missingAudioIds, [reopened.cells[0].id]);
    assert.deepEqual(await readFile(legacyPath), bytes);
    assert.deepEqual(await readFile(second.path), bytes);
  } finally {
    release();
    if (run) await wait(run);
    for (const key of ['AZURE_SPEECH_REGION', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_ENDPOINT']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('studio automatically runs more than 5,000 pairs without splitting output folders', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-large-'));
  const previous = { ...process.env };
  process.env.AZURE_SPEECH_REGION = 'eastus';
  process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key';
  delete process.env.AZURE_SPEECH_ENDPOINT;
  const scripts = Array.from({ length: 6 }, (_, index) => ({
    ...parseStudioScript(`large_${index}`, Array.from({ length: index === 5 ? 1 : 500 }, () => 'Bonjour.').join('\n')).script,
    locale: 'fr-FR',
  }));
  const audio = new Uint8Array(wav(Buffer.alloc(4800)));
  let calls = 0;
  const studio = new AzureVoicesStudio(new Store(root), async input => {
    if (String(input).endsWith('/voices/list')) return Response.json(voices);
    calls++;
    // Verify that an individual failure doesn't stop subsequent batches.
    return calls === 200 ? new Response(null, { status: 400 }) : new Response(audio);
  });
  let running: StudioRun | undefined;
  try {
    await studio.voices();
    const plan = await studio.plan({
      scripts, voices: voices.map(voice => voice.ShortName), outputParent: root, runName: 'large',
      useExisting: false, rate: 0, pitch: 0, concurrency: 4,
    });
    assert.equal(plan.calls, 5002);
    assert.equal(calls, 0);
    const folders = new Map<string, number>();
    for (const cell of plan.cells) {
      const folder = path.basename(path.dirname(path.dirname(cell.path)));
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    assert.deepEqual(folders, new Map([['fr-FR Female', 2501], ['fr-FR Male', 2501]]));
    assert.equal(new Set(plan.cells.map(cell => cell.path)).size, 5002);

    running = await studio.start(plan.token, true);
    while (running.status === 'running') await delay(50);
    assert.equal(running.status, 'completed', running.error);
    assert.equal(calls, 5002);
    assert.equal(running.cells.filter(cell => cell.status === 'done').length, 5001);
    assert.equal(running.cells.filter(cell => cell.status === 'failed').length, 1);
    assert.equal(running.cells.at(-1)?.status, 'done');
    const manifest = await readFile(path.join(running.output, 'manifest.csv'), 'utf8');
    assert.equal(manifest.split('\r\n').length, 5003);
    const imported = await new BatchImport().plan({ directory: running.byLocale });
    assert.equal(imported.tests.length, 2);
    assert.equal(imported.tests.reduce((count, item) => count + item.files.length, 0), 5001);
  } finally {
    if (running?.status === 'running') {
      studio.cancel(running.id);
      while (running.status === 'running') await delay(50);
    }
    for (const key of ['AZURE_SPEECH_REGION', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_ENDPOINT']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('studio API previews without billing, synthesizes, imports and safely skips existing clips', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-studio-'));
  const data = path.join(root, 'data'), output = path.join(root, 'output');
  await mkdir(output);
  const previous = { region: process.env.AZURE_SPEECH_REGION, key: process.env.AZURE_SPEECH_KEY, endpoint: process.env.AZURE_SPEECH_ENDPOINT };
  process.env.AZURE_SPEECH_REGION = 'eastus'; process.env.AZURE_SPEECH_KEY = 'synthetic-speech-key'; delete process.env.AZURE_SPEECH_ENDPOINT;
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let synthCalls = 0;
  const bodies: string[] = [];
  let releaseHold: (() => void) | undefined;
  let notifyHold: (() => void) | undefined;
  const holdStarted = new Promise<void>(resolve => { notifyHold = resolve; });
  const speechFetch: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'), 'synthetic-speech-key');
    assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/voices/list')) return Response.json([
      { ...voices[0], SecondaryLocaleList: [...voices[0].SecondaryLocaleList, 'zh-HK'] }, voices[1],
    ]);
    synthCalls++;
    bodies.push(String(init?.body));
    if (synthCalls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    if (String(init?.body).includes('Fail this clip')) return new Response('', { status: 400 });
    if (String(init?.body).includes('Hold this clip')) {
      notifyHold?.();
      await new Promise<void>(resolve => { releaseHold = resolve; });
    }
    return new Response(new Uint8Array(wav(Buffer.alloc(4800))));
  };
  const backend = await createApp({ dataDir: data, port: address.port, speechFetch });
  backend.app.use(backend.errors); server.on('request', backend.app);
  const base = `http://127.0.0.1:${address.port}`;
  const api = (route: string, body?: unknown) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const current: StudioRun = await (await api(`/api/studio/runs/${id}`)).json();
      if (current.status !== 'running' && current.status !== 'pausing') return current;
      await delay(20);
    }
    throw new Error('Run did not finish.');
  };
  try {
    const connection = await (await api('/api/studio/connection')).text();
    assert.ok(!connection.includes('synthetic-speech-key'));
    assert.equal((await api('/api/studio/voices?refresh=1')).status, 200);
    const script = parseStudioScript('greeting', 'hello\tBonjour & merci\nPlease hold').script;
    script.locale = 'fr-FR';
    const input = { scripts: [script], voices: voices.map(v => v.ShortName), outputParent: output, runName: 'run', useExisting: false, rate: 0, pitch: 0, concurrency: 2 };
    const first = await api('/api/studio/plan', input);
    assert.equal(first.status, 200);
    const plan: StudioPlan = await first.json();
    assert.equal(plan.calls, 4);
    assert.equal(plan.characters, 2 * ('Bonjour & merci'.length + 'Please hold'.length));
    assert.equal(synthCalls, 0);
    assert.ok(plan.cells.some(cell => cell.path.includes('Ava%3ADragon')));
    assert.equal((await api('/api/studio/runs', { token: plan.token, consent: false })).status, 400);
    const response = await api('/api/studio/runs', { token: plan.token, consent: true });
    assert.equal(response.status, 201);
    const running: StudioRun = await response.json();
    const completed = await wait(running.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.cells.filter(cell => cell.status === 'done').length, 4);
    assert.equal(synthCalls, 5);
    assert.ok(bodies.every(body => body.includes('<lang xml:lang="fr-FR">')));
    assert.ok(bodies.some(body => body.includes('Bonjour &amp; merci')));
    assert.equal((await api('/api/studio/runs', { token: plan.token, consent: true })).status, 400);
    const batch = await new BatchImport().plan({ directory: completed.byLocale });
    assert.equal(batch.tests.length, 2);
    assert.ok(batch.tests.every(item => item.errors.length === 0 && item.languages.includes('fr-FR') && item.files.length === 2));
    assert.deepEqual(new Set(batch.tests.flatMap(item => item.genders)), new Set(['Male', 'Female']));
    const manifest = await readFile(path.join(completed.output, 'manifest.csv'), 'utf8');
    const runJson = await readFile(path.join(completed.output, 'run.json'), 'utf8');
    assert.ok(!manifest.includes('synthetic-speech-key') && !runJson.includes('synthetic-speech-key'));
    const replay = await api('/api/studio/plan', { ...input, useExisting: true });
    const skipPlan: StudioPlan = await replay.json();
    assert.equal(skipPlan.calls, 0);
    assert.equal(skipPlan.characters, 0);
    const again = await api('/api/studio/runs', { token: skipPlan.token, consent: true });
    const skipped = await wait(((await again.json()) as StudioRun).id);
    assert.equal(skipped.cells.filter(cell => cell.status === 'skipped').length, 4);
    assert.equal(synthCalls, 5);
    const duplicate = await api('/api/studio/plan', { ...input, runName: 'other', scripts: [script, { ...script, name: 'other' }] });
    assert.equal(duplicate.status, 400);
    assert.match((await duplicate.json()).error, /Duplicate clip name/);
    const unsupported = await api('/api/studio/plan', { ...input, runName: 'other', scripts: [{ ...script, locale: 'de-DE' }] });
    assert.equal(unsupported.status, 400);
    const broken = parseStudioScript('errors', 'good\tHello\nbad\tFail this clip').script;
    const failurePlan: StudioPlan = await (await api('/api/studio/plan', { ...input, scripts: [broken], voices: [voices[0].ShortName], runName: 'failures' })).json();
    const failedRun = await api('/api/studio/runs', { token: failurePlan.token, consent: true });
    const failure = await wait(((await failedRun.json()) as StudioRun).id);
    assert.equal(failure.cells.filter(cell => cell.status === 'done').length, 1);
    assert.equal(failure.cells.filter(cell => cell.status === 'failed').length, 1);
    assert.match(failure.cells.find(cell => cell.status === 'failed')?.error ?? '', /HTTP 400/);
    const alteredPlan: StudioPlan = await (await api('/api/studio/plan', { ...input, useExisting: true })).json();
    await writeFile(alteredPlan.cells[0].path, wav(Buffer.alloc(4800, 1)));
    const altered = await api('/api/studio/runs', { token: alteredPlan.token, consent: true });
    assert.equal(altered.status, 400);
    assert.match((await altered.json()).error, /changed after preview/);
    assert.equal(synthCalls, 7);
    const cancelling = parseStudioScript('cancel', 'Hold this clip\nAnother clip\nA third clip').script;
    const cancelPlan: StudioPlan = await (await api('/api/studio/plan', { ...input, scripts: [cancelling], voices: [voices[0].ShortName], runName: 'cancel', concurrency: 1 })).json();
    const started: StudioRun = await (await api('/api/studio/runs', { token: cancelPlan.token, consent: true })).json();
    await holdStarted;
    assert.equal((await api(`/api/studio/runs/${started.id}/cancel`, {})).status, 200);
    assert.ok(releaseHold); releaseHold();
    const cancelled = await wait(started.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cells.filter(cell => cell.status === 'done').length, 1);
    assert.equal(cancelled.cells.filter(cell => cell.status === 'queued').length, 2);
    assert.equal(synthCalls, 8);
    const runs: StudioRun[] = await (await api('/api/studio/runs')).json();
    assert.ok(runs.some(run => run.id === started.id));

    const mixed = await api('/api/studio/plan', { ...input, runName: 'filename-languages', localeFromFilename: true,
      scripts: [
        parseStudioScript('ZH-hk_appointments', 'hk1\t第一句\nhk2\t第二句').script,
        parseStudioScript('en-US', 'us1\tHello there').script,
        parseStudioScript('zh-HKish', 'other1\tDefault greeting').script,
      ],
    });
    assert.equal(mixed.status, 200);
    const mixedPlan: StudioPlan = await mixed.json();
    assert.equal(mixedPlan.calls, 8);
    assert.deepEqual(mixedPlan.cells.map(cell => [cell.locale, cell.languageFallback]), [
      ['zh-HK', undefined], ['', { reason: 'unsupported-locale', requestedLocale: 'zh-HK' }],
      ['zh-HK', undefined], ['', { reason: 'unsupported-locale', requestedLocale: 'zh-HK' }],
      ['en-US', undefined], ['en-US', undefined],
      ['', { reason: 'no-filename-locale' }], ['', { reason: 'no-filename-locale' }],
    ]);
    assert.ok(mixedPlan.cells.filter(cell => cell.languageFallback).every(cell => /Auto (Female|Male)/.test(cell.path)));
    assert.equal(synthCalls, 8);
    const mixedStart = await api('/api/studio/runs', { token: mixedPlan.token, consent: true });
    assert.equal(mixedStart.status, 201);
    const mixedRun = await wait(((await mixedStart.json()) as StudioRun).id);
    assert.equal(mixedRun.status, 'completed');
    assert.equal(mixedRun.cells.filter(cell => cell.status === 'done').length, 8);
    const mixedBodies = bodies.slice(8);
    assert.equal(mixedBodies.filter(body => body.includes('<lang xml:lang="zh-HK">')).length, 2);
    assert.equal(mixedBodies.filter(body => body.includes('<lang xml:lang="en-US">')).length, 2);
    assert.equal(mixedBodies.filter(body => !body.includes('<lang ')).length, 4);
    const mixedManifest = await readFile(path.join(mixedRun.output, 'manifest.csv'), 'utf8');
    assert.match(mixedManifest, /language_fallback,requested_locale/);
    assert.match(mixedManifest, /"unsupported-locale","zh-HK"/);
    assert.match(mixedManifest, /"no-filename-locale",""/);

    const directOutput = path.join(output, 'direct');
    await mkdir(directOutput);
    const directInput = { scripts: [script], voices: [voices[0].ShortName], outputParent: directOutput,
      useExisting: false, rate: 0, pitch: 0, concurrency: 1 };
    const directPreview = await api('/api/studio/plan', directInput);
    assert.equal(directPreview.status, 200);
    const directPlan: StudioPlan = await directPreview.json();
    assert.equal(directPlan.byLocale, directOutput);
    assert.equal(path.relative(directOutput, directPlan.cells[0].path), path.join('fr-FR Female', 'en-US-Ava%3ADragonHDLatestNeural', 'hello.wav'));
    const directStart = await api('/api/studio/runs', { token: directPlan.token, consent: true });
    assert.equal(directStart.status, 201);
    const directRun = await wait(((await directStart.json()) as StudioRun).id);
    assert.equal(directRun.status, 'completed');
    assert.ok(directRun.cells.every(cell => cell.status === 'done'));
    assert.equal((await new BatchImport().plan({ directory: directOutput })).tests.length, 1);
    const originalReport = path.join(directOutput, `run-${directRun.id}.json`);
    const originalJson = await readFile(originalReport, 'utf8');
    const blocked = await api('/api/studio/plan', directInput);
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /An output WAV already exists: .*\. Choose a different output folder\./);
    const directReplay: StudioPlan = await (await api('/api/studio/plan', { ...directInput, useExisting: true })).json();
    assert.equal(directReplay.calls, 0);
    const replayStart = await api('/api/studio/runs', { token: directReplay.token, consent: true });
    assert.equal(replayStart.status, 201);
    const replayRun = await wait(((await replayStart.json()) as StudioRun).id);
    assert.ok(replayRun.cells.every(cell => cell.status === 'skipped'));
    assert.equal(await readFile(originalReport, 'utf8'), originalJson);
    assert.match(await readFile(path.join(directOutput, `manifest-${replayRun.id}.csv`), 'utf8'), /"skipped"/);
    await rm(directRun.cells[0].path);
    const updatedDirect: StudioRun = await (await api(`/api/studio/runs/${directRun.id}`)).json();
    const updatedReplay: StudioRun = await (await api(`/api/studio/runs/${replayRun.id}`)).json();
    assert.deepEqual(updatedDirect.missingAudioIds, [directRun.cells[0].id]);
    assert.deepEqual(updatedReplay.missingAudioIds, [replayRun.cells[0].id]);
    assert.equal(await readFile(originalReport, 'utf8'), originalJson);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = previous.region;
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.endpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT; else process.env.AZURE_SPEECH_ENDPOINT = previous.endpoint;
    await rm(root, { recursive: true, force: true });
  }
});
