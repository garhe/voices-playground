import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { bareAirportCodes, continuesAfterQuestion } from '../server/scriptGeneration.js';
import { parseStudioScript } from '../server/studioScripts.js';
import { expressionTagListsSchema, type ExpressionTagLists } from '../shared/scriptExpressionTags.js';
import { MAX_SCRIPT_BRIEF_LENGTH, MAX_SCRIPT_STYLE_LENGTH, SCRIPT_PROGRESS_CONTENT_TYPE, scriptFileName, scriptFileText, scriptGenerationSchema, type ScriptGenerationResult, type ScriptGenerationStatus } from '../shared/scriptGeneration.js';
import { generateScriptPreview, generateScriptsWithRetry, mergeBatchResults, regenerateLocalePreview } from '../src/scriptGenerationProgress.js';
import { loadBriefTemplates, loadDefaultBrief, saveBriefTemplate, saveDefaultBrief } from '../src/scriptBriefTemplates.js';
import { BUILT_IN_BRIEF_TEMPLATES, DEFAULT_SCRIPT_BRIEF, DEFAULT_SCRIPT_LOCALES, extractScriptStyle, ScriptGeneration } from '../src/ScriptGeneration.js';

const brief = {
  locales: ['fr-ca'], style: '  Friendly support call with dry humor  ', speakers: 2, utteranceCount: 2,
  prompt: 'Reschedule a delivery.', consent: true,
};

test('default content brief keeps tag rules separate and requires hesitations in each call', () => {
  const html = renderToStaticMarkup(createElement(ScriptGeneration, {
    active: false, onConfigure: () => {}, request: async () => { throw new Error('Unexpected request'); },
  }));
  const prompt = html.match(/Content brief<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
  assert.ok(prompt);
  assert.match(html, /<\/textarea><\/label><details[^>]*><summary>Expression tags applied: one style tag per sentence<\/summary>.*<\/details><div class="button-row"><button[^>]*>Improve with AI<\/button>.*New template name/);
  assert.match(html, /Prefix every spoken sentence with exactly 1 emotion\/style tag in square brackets/);
  assert.match(html, /Use \[calm\] at most 4 times per locale/);
  assert.match(html, /Optional sound tags: \[laughter\]/);
  assert.match(html, /Allowed style tags<textarea[^>]*>amazed, amused/);
  assert.match(html, /Optional sound tags<textarea[^>]*>laughter, coughing/);
  assert.ok(prompt.includes('Use local fillers, such as `um...`, `yep...`, `alright...`, `ah ha...`  in English, `嗯嗯...`, `是...的...`, `这样子...` in Mandarin, `即係...` in Cantonese, `euh...`, `oui...`, `alors...`  in French, or `à...`, `vâng...` in Vietnamese.'));
  assert.match(prompt, /at least 2 hesitations per mini-call\*\* \(at least 8 total\)/);
  assert.match(prompt, /place at least half \*\*in the middle of a sentence\*\*/);
  assert.doesNotMatch(prompt, /expression tags|Use only these style names|\[calm\]/);
  assert.match(html, /Expression tags<select><option value="on" selected="">On<\/option><option value="off">Off<\/option>/);
  assert.match(prompt, /Use at most 1 brief greeting across the calls; focus on solving the problem/);
  const delivery = prompt.match(/\*\*Colloquial Delivery:\*\*([^\r\n]*)/)?.[1];
  assert.ok(delivery);
  assert.match(delivery, /In every locale, use what a local agent would actually say on the phone/);
  assert.match(delivery, /Mix in English words or acronyms where locals naturally do/);
  assert.match(delivery, /Prefer local equivalents when they sound more natural\. No term is mandatory\./);
  assert.doesNotMatch(delivery, /zh-HK|literal word/);
  assert.match(prompt, /End any utterance at the question\./);
  assert.match(prompt, /without asterisks; parentheses only for airport codes\./);
  assert.match(html, /Script style<input[^>]*value="Customer_Services"/);
  assert.doesNotMatch(html, /Leave blank to use the style from the brief/);
  assert.match(html, /<section class="card script-generation-card"><h2>01 · Script brief<\/h2>[\s\S]*?<\/section><section class="card script-generation-card"[^>]*><h2[^>]*>02 · Languages \/ Accents<\/h2>[\s\S]*?Generate preview[\s\S]*?<\/section><\/form><form[^>]*><h2>03 · Preview and save<\/h2>/);
  assert.match(html, /<option value="customer_services" selected="">customer_services<\/option>/);
  assert.match(html, /<button[^>]*type="button"[^>]*>Save as default<\/button>/);
  assert.doesNotMatch(html, /<option value="customer_services_tag"/);
  assert.doesNotMatch(prompt, /Do NOT use any square brackets/);
  assert.doesNotMatch(prompt, /4 to 6 total/);
  assert.equal(scriptGenerationSchema.safeParse({ ...brief, speakers: 1, utteranceCount: 16, prompt }).success, true);
  assert.equal(scriptGenerationSchema.safeParse({ ...brief, speakers: 1, utteranceCount: 16, prompt: DEFAULT_SCRIPT_BRIEF }).success, true);
});

test('the customer service template requests distinct cases within the same four domains', () => {
  for (const { prompt } of BUILT_IN_BRIEF_TEMPLATES) {
    assert.match(prompt, /Call 1 — Telecom[\s\S]*Call 2 — Banking & Finance[\s\S]*Call 3 — Delivery & Logistics[\s\S]*Call 4 — Flight & Hotel Travel/);
    assert.match(prompt, /For each locale and run, vary the incident, cause, and resolution within each domain/);
    assert.match(prompt, /Vary case-specific nouns \(devices, merchants, parcels, routes\)/);
    assert.match(prompt, /Don't translate or recycle a script by just swapping names/);
  }
});

test('both travel scenarios request a complete revised flight itinerary and wait for approval', () => {
  const travel = DEFAULT_SCRIPT_BRIEF.split('Call 4 — Flight & Hotel Travel')[1]?.split('\n\n')[0];
  assert.ok(travel);
  assert.match(travel, /Rebook a flight or adjust a hotel booking after a flight change/);
  assert.match(travel, /each endpoint's specific airport name as spoken locally/);
  assert.match(travel, /matching uppercase 3-letter IATA code in parentheses: Hanoi Noi Bai \(HAN\) to Tokyo Narita \(NRT\)/);
  assert.match(travel, /Do not use a city alone, such as Tokyo \(NRT\), or a bare code/);
  assert.match(travel, /In both scenarios, read back the revised itinerary in natural speech/);
  assert.match(travel, /airline name, a plausible flight number with that airline's designator/);
  assert.match(travel, /departure and arrival dates and times in each airport's local time/);
  assert.match(travel, /arrival date explicitly, especially if it changes overnight/);
  assert.match(travel, /dates consistent with any hotel change/);
  assert.match(travel, /asking for approval and confirm the change only in a later utterance/);
});

test('named brief copies persist exactly and cannot overwrite built-ins or saved templates', () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  };
  assert.deepEqual(loadBriefTemplates(storage), []);
  const draft = { name: '  Weekend support  ', prompt: 'Script style: Quick support\n\nCustom wording.\n' };
  const saved = { ...draft, name: 'Weekend support' };
  assert.deepEqual(saveBriefTemplate(storage, draft, BUILT_IN_BRIEF_TEMPLATES), { template: saved, templates: [saved] });
  assert.deepEqual(loadBriefTemplates(storage), [saved]);
  for (const name of ['WEEKEND SUPPORT', 'customer_services']) {
    assert.throws(() => saveBriefTemplate(storage, { ...draft, name }, BUILT_IN_BRIEF_TEMPLATES), /already exists/);
  }
  assert.throws(() => saveBriefTemplate(storage, { ...draft, prompt: ' ' }, BUILT_IN_BRIEF_TEMPLATES), /Enter a content brief/);
  assert.deepEqual(loadBriefTemplates(storage), [saved]);
  assert.throws(() => saveBriefTemplate({ ...storage, setItem: () => { throw new Error('Storage full'); } },
    { ...draft, name: 'Another template' }, BUILT_IN_BRIEF_TEMPLATES), /Could not save/);
  assert.throws(() => saveBriefTemplate({ ...storage, getItem: () => '{' }, draft, BUILT_IN_BRIEF_TEMPLATES), /No templates were overwritten/);
});

test('a default brief persists verbatim and can be replaced without modifying named templates', () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  };
  const named = { name: 'Weekend support', prompt: 'Write a support call.' };
  saveBriefTemplate(storage, named, BUILT_IN_BRIEF_TEMPLATES);
  assert.equal(loadDefaultBrief(storage), null);
  const brief = 'Script style: Podcast\n\nWrite an interview intro.\n';
  saveDefaultBrief(storage, brief);
  assert.equal(loadDefaultBrief(storage), brief);
  assert.throws(() => saveDefaultBrief(storage, '  '), /Enter a content brief/);
  assert.throws(() => saveDefaultBrief(storage, 'x'.repeat(MAX_SCRIPT_BRIEF_LENGTH + 1)));
  assert.throws(() => saveDefaultBrief({ setItem: () => { throw new Error('Storage full'); } }, 'Another brief.'), /Could not save/);
  assert.equal(loadDefaultBrief(storage), brief);
  saveDefaultBrief(storage, 'A different default.');
  assert.equal(loadDefaultBrief(storage), 'A different default.');
  assert.deepEqual(loadBriefTemplates(storage), [named]);
});

test('script style follows an explicit brief label or the opening description', () => {
  assert.deepEqual(DEFAULT_SCRIPT_LOCALES, ['en-US', 'fr-FR', 'zh-HK', 'zh-CN', 'vi-VN']);
  assert.equal(extractScriptStyle(DEFAULT_SCRIPT_BRIEF), 'Customer_Services');
  assert.equal(extractScriptStyle('Write a call.\r\n**Tone:** Warm and direct'), 'Warm and direct');
  assert.equal(extractScriptStyle('### Task\nWrite a friendly hotel support call. Confirm the date.'), 'friendly hotel support call');
  assert.equal(extractScriptStyle(''), '');
  assert.equal(extractScriptStyle(`Style: ${'a'.repeat(MAX_SCRIPT_STYLE_LENGTH - 1)}𐐀`), 'a'.repeat(MAX_SCRIPT_STYLE_LENGTH - 1));
});

test('script generation retries when a question does not end its utterance or an airport code is bare', () => {
  assert.equal(continuesAfterQuestion('[curious] Want me to move you to that flight?'), false);
  assert.equal(continuesAfterQuestion('[curious] Is it the $68.42 charge? [laughter]'), false);
  assert.equal(continuesAfterQuestion('[curious] 要我帮您改到这班吗？'), false);
  assert.equal(continuesAfterQuestion('[confident] The card is locked.'), false);
  assert.equal(continuesAfterQuestion('[curious] Want me to move you? [confident] Done, you are confirmed.'), true);
  assert.equal(continuesAfterQuestion('[concerned] It still fails, right? [calm] Let us check settings.'), true);
  assert.deepEqual(bareAirportCodes(['From Da Nang (DAD) to Incheon (ICN).', 'Your seat to Incheon (ICN) is set.']), []);
  assert.deepEqual(bareAirportCodes(['From Da Nang (DAD) to Incheon (ICN).', 'The flight from Da Nang DAD is ready.']), ['DAD']);
});

test('script filenames use the locale and style, replace spaces, and stay compatible with Studio', () => {
  assert.equal(scriptFileName('en-US', '  Warm  documentary narration  '), 'en-US_Warm_documentary_narration.txt');
  assert.equal(scriptFileName('fr-CA', '../Service à la clientèle: appel/rappel?'), 'fr-CA_Service_à_la_clientèle_appel_rappel.txt');
  assert.equal(scriptFileName('en-US', '???'), 'en-US_script.txt');
  const longName = scriptFileName('fr-CA', `${'a'.repeat(73)}𐐀`);
  assert.equal(longName, `fr-CA_${'a'.repeat(73)}.txt`);
  assert.doesNotThrow(() => parseStudioScript(longName, 'fr-CA_00001\tBonjour.\r\n'));
});

test('regeneration submits only the target locale with the original settings', async t => {
  const input = scriptGenerationSchema.parse({ ...brief, locales: ['en-US', 'fr-CA'], speakers: 1, expressionTags: false });
  const script = (locale: string, text: string) => ({ script: { locale, utterances: [{ speaker: 1 as const, text }] } });
  const replacement = script('fr-CA', 'Salut.');
  const controller = new AbortController();
  let response: ScriptGenerationResult[number] = replacement;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/script-generation/generate');
    assert.deepEqual(JSON.parse(String(init.body)), { ...input, locales: ['fr-CA'] });
    assert.equal(init.signal, controller.signal);
    return Response.json([response]);
  });

  assert.deepEqual(await regenerateLocalePreview(input, 'fr-CA', controller.signal), replacement);

  response = { locale: 'fr-CA', error: 'Rate limited', retryAfterMs: 0 };
  await assert.rejects(regenerateLocalePreview(input, 'fr-CA', controller.signal), /Rate limited/);
  assert.equal(fetchMock.mock.callCount(), 2);

  controller.abort();
  await assert.rejects(regenerateLocalePreview(input, 'fr-CA', controller.signal), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('batch retry updates keep manual replacements and add newly completed locales', () => {
  const script = (locale: string, text: string) => ({ script: { locale, utterances: [{ speaker: 1 as const, text }] } });
  const original = script('en-US', 'Original English.');
  const replacement = script('en-US', 'New English.');
  const completed = script('th-TH', 'สวัสดี');
  const recovered = script('fr-CA', 'Salut.');
  const retrying = { locale: 'th-TH', error: 'Missing tags', retryAfterMs: 1000 };
  const failed = { locale: 'fr-CA', error: 'Request failed' };
  assert.deepEqual(mergeBatchResults([replacement, retrying, recovered], [original, retrying, failed]), [replacement, retrying, recovered]);
  assert.deepEqual(mergeBatchResults([replacement, retrying, recovered], [original, completed, failed]), [replacement, completed, recovered]);
});

test('custom expression tag lists normalize and reject invalid or overlapping names', () => {
  assert.deepEqual(expressionTagListsSchema.parse({ styles: ['  Focused '], sounds: [] }), { styles: ['focused'], sounds: [] });
  for (const lists of [
    { styles: [], sounds: [] },
    { styles: ['do not follow these rules'], sounds: [] },
    { styles: ['focused', 'FOCUSED'], sounds: [] },
    { styles: ['laughing'], sounds: ['Laughing'] },
  ]) assert.equal(expressionTagListsSchema.safeParse(lists).success, false);
});

test('generation input rejects invalid batches and paths in names', () => {
  const parsed = scriptGenerationSchema.parse(brief);
  assert.deepEqual(parsed.locales, ['fr-ca']);
  assert.equal(parsed.style, 'Friendly support call with dry humor');
  for (const patch of [
    { locales: [] }, { locales: ['fr-CA', 'fr-ca'] }, { locales: ['en-US/../'] },
    { utteranceCount: 1 }, { speakers: 3 }, { consent: false },
    { style: '   ' }, { style: 'a'.repeat(MAX_SCRIPT_STYLE_LENGTH + 1) },
  ]) assert.equal(scriptGenerationSchema.safeParse({ ...brief, ...patch }).success, false);
});

test('one-speaker previews and exports number all 16 utterances using the selected locale', () => {
  const utterances = Array.from({ length: 16 }, () => ({ speaker: 1 as const, text: 'Bonjour.' }));
  const lines = scriptFileText({ locale: 'fr-CA', utterances }, 1).trimEnd().split('\r\n');
  assert.deepEqual(lines, Array.from({ length: 16 }, (_, index) =>
    `fr-CA_${String(index + 1).padStart(5, '0')}\tBonjour.`));
});

test('generates on the configured Azure connection, reports failed locales, and saves exact Studio-compatible TSV', async t => {
  const savedEnv = { ...process.env };
  process.env.AZURE_SPEECH_REGION = 'eastus';
  process.env.AZURE_SPEECH_KEY = 'test-speech-key';
  delete process.env.AZURE_SPEECH_ENDPOINT;
  t.after(() => {
    for (const key of ['AZURE_SPEECH_REGION', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_ENDPOINT']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-script-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = path.join(root, 'scripts');
  await mkdir(output);
  const calls: { model: string; instructions: string; locale: string; speakers: number; style: string; contentBrief: string }[] = [];
  const improvementCalls: { model: string; instructions: string; speakers: number; style: string; contentBrief: string }[] = [];
  const foundryEndpoint = 'https://script-test-responses.services.ai.azure.com/openai/v1/responses';
  const foundryCalls: string[] = [];
  const secureStorageAvailable = process.platform === 'win32';
  const suggestedBrief = 'Describe a delivery rescheduling call. Confirm the new slot and recap what happens next.';
  const taggedBrief = 'Put the style in square brackets in front of each sentence, for example [calm] Welcome. [reassuring] How can I help? Use only these style names: calm, reassuring.';
  const unlimitedCalmBrief = 'Prefix every spoken sentence with a style tag in square brackets.';
  const podcastBrief = 'Write a short podcast intro. Do not use tags.';
  const narrativeBrief = 'Read a book excerpt. Prefix each sentence with a tag in square brackets.';
  let customOutput = '';
  const primaryLocales = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-IN', 'en-IE', 'en-ZA', 'fr-FR', 'fr-CA', 'de-DE'];
  let releaseSlowLocale: (() => void) | undefined;
  const slowLocale = new Promise<void>(resolve => { releaseSlowLocale = resolve; });
  let releaseRunLocale: (() => void) | undefined;
  const slowRunLocale = new Promise<void>(resolve => { releaseRunLocale = resolve; });
  let catalogCalls = 0;
  const speechFetch: typeof fetch = async input => {
    assert.equal(String(input), 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
    catalogCalls++;
    return Response.json(primaryLocales.map((Locale, index) => ({
      ShortName: `voice-${index}`, DisplayName: `Test Voice ${index}`, Gender: 'Female', Locale,
      SecondaryLocaleList: index === 0 ? ['es-MX', 'zh-CN-shandong', 'fr-CA'] : [],
    })));
  };
  const scriptFetch: typeof fetch = async (input, init) => {
    if (String(input) === foundryEndpoint) {
      assert.equal(new Headers(init?.headers).get('api-key'), 'test-foundry-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'text-responses');
      assert.deepEqual(body.text, { format: { type: 'json_object' } });
      assert.equal(body.store, false);
      assert.equal(body.messages, undefined);
      assert.match(body.input, /^Return the result as a JSON object\.\n/);
      const spec = JSON.parse(body.input.slice(body.input.indexOf('\n') + 1));
      if (spec.contentBrief === 'Mock rejected request') return Response.json({
        error: { code: 'unsupported_value', param: 'text.format', message: 'Provider detail that should not be exposed.' },
      }, { status: 400, headers: { 'apim-request-id': '01234567-89ab-cdef-0123-456789abcdef' } });
      assert.equal(spec.contentBrief, brief.prompt);
      foundryCalls.push(spec.locale ? 'generate' : 'improve');
      const value = spec.locale
        ? { utterances: [{ speaker: 1, text: 'Bonjour.' }, { speaker: 2, text: 'Merci.' }] }
        : { suggestion: suggestedBrief };
      return Response.json({ status: 'completed', output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ] });
    }
    assert.equal(String(input), 'https://script-test.openai.azure.com/openai/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('api-key'), 'test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_object');
    const spec = JSON.parse(body.messages[1].content);
    if (!('locale' in spec)) {
      improvementCalls.push({ model: body.model, instructions: body.messages[0].content, ...spec });
      const suggestion = spec.contentBrief === 'Return too much.' ? 'a'.repeat(MAX_SCRIPT_BRIEF_LENGTH + 1) : suggestedBrief;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ suggestion }) } }] });
    }
    calls.push({ model: body.model, instructions: body.messages[0].content, ...spec });
    if (spec.contentBrief === 'Check live progress.' && spec.locale.includes('en-US')) await slowLocale;
    if (spec.contentBrief === 'Check reconnectable run.' && spec.locale.includes('en-US')) await slowRunLocale;
    if (spec.locale.includes('es-MX')) return new Response(null, { status: 429, headers: { 'Retry-After': '8' } });
    const recovering = spec.contentBrief === 'Retry invalid output.';
    if (recovering && spec.locale.includes('en-GB')) return new Response(null, { status: 403 });
    const malformed = spec.locale.includes('de-DE') && (!recovering ||
      calls.filter(call => call.contentBrief === spec.contentBrief && call.locale === spec.locale).length === 1);
    const taggedAttempt = calls.filter(call => call.contentBrief === taggedBrief).length;
    const defaultAttempt = calls.filter(call => call.contentBrief === DEFAULT_SCRIPT_BRIEF && call.locale === spec.locale).length;
    const utterances = spec.contentBrief === DEFAULT_SCRIPT_BRIEF
      ? Array.from({ length: 16 }, (_, index) => ({
        speaker: 1,
        text: spec.locale.includes('en-US') && defaultAttempt === 1 && index === 0 ? 'Hello.'
          : spec.locale.includes('en-US') && defaultAttempt === 2 && index === 0 ? '[calm] Hello. [CALM] Hello again.'
          : index < 4 ? '[calm] Hello.' : '[reassuring] I can help.',
      }))
      : spec.contentBrief === unlimitedCalmBrief
      ? Array.from({ length: 16 }, () => ({ speaker: 1, text: '[calm] Hello.' }))
      : [podcastBrief, narrativeBrief].includes(spec.contentBrief)
      ? [{ speaker: 1, text: customOutput }, {
        speaker: 2, text: spec.contentBrief === podcastBrief ? '[reflective] A new chapter begins.' : 'A new chapter begins.',
      }]
      : malformed ? [{ speaker: 1, text: 'Not enough utterances.' }]
      : spec.contentBrief === taggedBrief && taggedAttempt === 1
        ? [{ speaker: 1, text: '[calm] Welcome. How can I help?' }, { speaker: 2, text: '[calm] I can check that.' }]
        : spec.contentBrief === taggedBrief && taggedAttempt === 2
          ? [{ speaker: 1, text: '[calm] Welcome.' }, { speaker: 2, text: '[happy] I can check that.' }]
          : spec.contentBrief === taggedBrief
          ? [{ speaker: 1, text: '[calm] Hmm... Welcome. [reassuring] How can I help?' }, { speaker: 2, text: '[calm] 你好。 [reassuring] 我可以幫你。' }]
          : [{ speaker: 1, text: 'Bonjour, comment puis-je vous aider?' }, { speaker: 2, text: 'Je voudrais changer la date, s’il vous plaît.' }];
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ utterances }) } }] });
  };
  let port = 0;
  const server = createServer();
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) assert.fail('Expected a local TCP address.');
  port = address.port;
  const options = {
    dataDir: path.join(root, 'data'), port, endpoint: 'https://script-test.openai.azure.com', key: 'test-key',
    scriptDeployment: 'text-default', scriptFetch, speechFetch,
  };
  const { app, errors } = await createApp(options);
  app.use(errors);
  server.on('request', app);
  const url = `http://127.0.0.1:${port}/api/script-generation/`;
  const post = (route: string, value: unknown, method = 'POST') => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });

  assert.deepEqual(await (await fetch(`${url}settings`)).json(), { deployment: 'text-default', source: 'environment', secureStorageAvailable });
  const catalog: { value: string; label: string }[] = await (await fetch(`${url}locales`)).json();
  assert.deepEqual(catalog.map(option => option.value).sort(), [...primaryLocales, 'es-MX', 'zh-CN-shandong'].sort());
  assert.equal((await fetch(`${url}locales?refresh=1`)).status, 200);
  assert.equal(catalogCalls, 2);
  assert.equal((await post('generate', { ...brief, consent: false })).status, 400);
  const unsupported = await post('generate', { ...brief, locales: ['fr-CA', 'it-IT'] });
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /it-IT is not in the current Azure Speech voice catalog/);
  assert.equal(calls.length, 0);
  const response = await post('generate', { ...brief, locales: ['fr-ca', 'es-MX', 'de-DE'] });
  assert.equal(response.status, 200);
  const results: ScriptGenerationResult = await response.json();
  const [success, limited, invalid] = results;
  assert.ok('script' in success);
  assert.deepEqual(success.script.utterances.map(item => item.speaker), [1, 2]);
  assert.ok('error' in limited && limited.locale === 'es-MX' && /rate limit/.test(limited.error));
  assert.ok('error' in invalid && invalid.locale === 'de-DE' && /utterance count/.test(invalid.error));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.model === 'text-default' && call.style === brief.style.trim()
    && call.speakers === 2 && call.contentBrief === brief.prompt));
  assert.match(calls[0].locale, /fr-CA/);

  const realFetch = globalThis.fetch;
  const progressFetch = t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) => {
    assert.equal(input, '/api/script-generation/generate');
    assert.equal(new Headers(init.headers).get('Accept'), SCRIPT_PROGRESS_CONTENT_TYPE);
    const timeout = AbortSignal.timeout(5000);
    return realFetch(`${url}generate`, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  });
  const progress: { generated: number; failed: number }[] = [];
  let notifyFastLocales: (() => void) | undefined;
  const fastLocales = new Promise<void>(resolve => { notifyFastLocales = resolve; });
  try {
    const generateWithTags = (prompt: string, expressionTags: boolean, expressionTagLists?: ExpressionTagLists) => generateScriptPreview(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US'], prompt, expressionTags, expressionTagLists }), () => {},
    );
    customOutput = '[excited] Welcome to the show. [laughing] Today we talk about books. [laughter]';
    const [taggedPodcast] = await generateWithTags(podcastBrief, true);
    assert.ok('script' in taggedPodcast);
    assert.equal(taggedPodcast.script.utterances[0].text, customOutput);
    const podcastCall = calls.find(call => call.contentBrief === podcastBrief);
    assert.match(podcastCall?.instructions ?? '', /Expression tags are ON.*exactly 1 emotion\/style tag.*whispering/);
    assert.match(podcastCall?.instructions ?? '', /specific airport name as spoken locally.*Tokyo Narita \(NRT\).*not just its city/);
    assert.match(podcastCall?.instructions ?? '', /\[laughter\], \[coughing\], \[throat_clearing\], \[breathing\], \[sighing\], \[yawning\]/);
    customOutput = '[excited] [reassuring] Welcome to the show.';
    const [duplicateTag] = await generateWithTags(podcastBrief, true);
    assert.ok('error' in duplicateTag && /invalid requested sentence tags/.test(duplicateTag.error));

    const customTags = { styles: ['reflective'], sounds: ['soft_breath'] };
    customOutput = '[reflective] Welcome to the show. [soft_breath]';
    const [customPodcast] = await generateWithTags(podcastBrief, true, customTags);
    assert.ok('script' in customPodcast);
    assert.equal(customPodcast.script.utterances[0].text, customOutput);
    assert.match(calls.at(-1)?.instructions ?? '', /Use only these style names: reflective\. Optional sound tags: \[soft_breath\]/);
    customOutput = '[reflective] Welcome to the show. [laughter]';
    const [removedSound] = await generateWithTags(podcastBrief, true, customTags);
    assert.ok('error' in removedSound && /invalid requested sentence tags/.test(removedSound.error));
    customOutput = '[excited] Welcome to the show.';
    const [removedStyle] = await generateWithTags(podcastBrief, true, customTags);
    assert.ok('error' in removedStyle && /invalid requested sentence tags/.test(removedStyle.error));

    customOutput = '[calm] The library closed at dusk.';
    const [unwantedTag] = await generateWithTags(narrativeBrief, false);
    assert.ok('error' in unwantedTag && /expression tags were off/.test(unwantedTag.error));
    customOutput = 'The library closed at dusk.';
    const [untaggedNarrative] = await generateWithTags(narrativeBrief, false);
    assert.ok('script' in untaggedNarrative);
    assert.equal(untaggedNarrative.script.utterances[0].text, customOutput);
    assert.match(calls.find(call => call.contentBrief === narrativeBrief)?.instructions ?? '', /Expression tags are OFF.*even if the content brief requests them/);

    let taggedResults: ScriptGenerationResult = [];
    await generateScriptsWithRetry(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US'], prompt: taggedBrief }),
      new AbortController().signal,
      (_progress, results) => { taggedResults = results; },
    );
    assert.deepEqual(taggedResults, [{ script: { locale: 'en-US', utterances: [
      { speaker: 1, text: '[calm] Hmm... Welcome. [reassuring] How can I help?' },
      { speaker: 2, text: '[calm] 你好。 [reassuring] 我可以幫你。' },
    ] } }]);
    const taggedCalls = calls.filter(call => call.contentBrief === taggedBrief);
    assert.equal(taggedCalls.length, 3);
    assert.match(taggedCalls[0].instructions, /explicitly requests bracketed emotion, style, or paralinguistic tags/);

    let defaultResults: ScriptGenerationResult = [];
    let sawCalmLimitFailure = false;
    await generateScriptsWithRetry(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US', 'fr-CA'], speakers: 1, utteranceCount: 16, prompt: DEFAULT_SCRIPT_BRIEF, expressionTags: true }),
      new AbortController().signal,
      (_progress, results) => {
        defaultResults = results;
        if (results.some(result => 'error' in result && /used \[calm\] 5 times/.test(result.error))) sawCalmLimitFailure = true;
      },
    );
    assert.equal(calls.filter(call => call.contentBrief === DEFAULT_SCRIPT_BRIEF && call.locale.includes('en-US')).length, 3);
    assert.equal(calls.filter(call => call.contentBrief === DEFAULT_SCRIPT_BRIEF && call.locale.includes('fr-CA')).length, 1);
    assert.equal(sawCalmLimitFailure, true);
    for (const result of defaultResults) {
      assert.ok('script' in result);
      assert.equal(result.script.utterances.length, 16);
      assert.equal(result.script.utterances.filter(({ text }) => text === '[calm] Hello.').length, 4);
    }
    assert.ok('script' in defaultResults[0]);
    assert.match(scriptFileText(defaultResults[0].script, 1), /^en-US_00001\t\[calm\] Hello\.\r\n/);

    let unlimitedResults: ScriptGenerationResult = [];
    await generateScriptsWithRetry(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US'], speakers: 1, utteranceCount: 16, prompt: unlimitedCalmBrief }),
      new AbortController().signal,
      (_progress, results) => { unlimitedResults = results; },
    );
    assert.ok('script' in unlimitedResults[0]);
    assert.equal(unlimitedResults[0].script.utterances.filter(({ text }) => text === '[calm] Hello.').length, 16);

    const live = generateScriptPreview(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US', 'fr-ca', 'es-MX'], prompt: 'Check live progress.' }),
      update => {
        progress.push(update);
        if (update.generated === 1 && update.failed === 1) notifyFastLocales?.();
      },
    );
    await Promise.race([fastLocales, live.then(() => assert.fail('Generation finished before the slow locale was released.'))]);
    assert.deepEqual(progress.at(-1), { generated: 1, failed: 1 });
    releaseSlowLocale?.();
    const liveResults = await live;
    assert.deepEqual(progress.at(-1), { generated: 2, failed: 1 });
    assert.deepEqual(liveResults.map(result => 'script' in result ? result.script.locale : result.locale), ['en-US', 'fr-CA', 'es-MX']);
    assert.ok('error' in liveResults[2] && liveResults[2].retryAfterMs === 8000);
    assert.equal(calls.filter(call => call.contentBrief === 'Check live progress.').length, 3);

    let completed: ScriptGenerationResult = [];
    await generateScriptsWithRetry(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US', 'de-DE', 'en-GB'], prompt: 'Retry invalid output.' }),
      new AbortController().signal,
      (_progress, results) => { completed = results; },
    );
    assert.deepEqual(completed.map(result => 'script' in result ? result.script.locale : result.error), [
      'en-US', 'de-DE', 'Azure OpenAI did not authorize this request. Check the existing connection and deployment access.',
    ]);
    const retryCalls = calls.filter(call => call.contentBrief === 'Retry invalid output.');
    assert.equal(retryCalls.length, 4);
    assert.match(retryCalls[3].locale, /de-DE/);

    const stop = new AbortController();
    await assert.rejects(generateScriptsWithRetry(
      scriptGenerationSchema.parse({ ...brief, locales: ['en-US', 'es-MX'], prompt: 'Stop before retry.' }),
      stop.signal,
      (update, results) => {
        if (update.nextRetryMs === undefined) return;
        assert.deepEqual(update, { generated: 1, failed: 0, retrying: 1, nextRetryMs: 8000 });
        assert.ok(results.some(result => 'script' in result && result.script.locale === 'en-US'));
        stop.abort();
      },
    ), { name: 'AbortError' });
    assert.equal(calls.filter(call => call.contentBrief === 'Stop before retry.').length, 2);
  } finally {
    releaseSlowLocale?.();
    progressFetch.mock.restore();
  }

  const getRun = async () => ((await (await fetch(`${url}run`)).json()) as ScriptGenerationStatus).run;
  async function waitForRun(predicate: (run: NonNullable<Awaited<ReturnType<typeof getRun>>>) => boolean) {
    for (let count = 0; count < 100; count++) {
      const run = await getRun();
      if (run && predicate(run)) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('The run did not reach the expected state.');
  }
  const runInput = { ...brief, locales: ['en-US', 'fr-FR', 'en-GB', 'en-AU'], prompt: 'Check reconnectable run.' };
  const runCalls = () => calls.filter(call => call.contentBrief === runInput.prompt);
  try {
    assert.equal(await getRun(), undefined);
    assert.equal((await post('run', runInput)).status, 202);
    const running = await waitForRun(run => run.activeLocales.includes('en-US') && run.results.length === 2);
    const action = (name: string, extra: object = {}) => post('run/action', { action: name, id: running.id, ...extra });
    assert.equal(running.state, 'running');
    assert.equal((await post('run', runInput)).status, 409);
    assert.equal((await action('regenerate', { locale: 'fr-FR' })).status, 200);
    await waitForRun(run => run.regeneration?.state === 'done');
    assert.equal((await action('pause')).status, 200);
    assert.equal((await getRun())?.state, 'pausing');
    releaseRunLocale?.();
    const paused = await waitForRun(run => run.state === 'paused');
    assert.equal(paused.id, running.id);
    assert.equal(paused.results.length, 3);
    assert.deepEqual(paused.activeLocales, []);
    assert.equal(runCalls().some(call => call.locale.includes('en-AU')), false);
    assert.equal((await action('resume')).status, 200);
    const completedRun = await waitForRun(run => run.state === 'completed');
    assert.equal(completedRun.id, running.id);
    assert.equal(completedRun.results.length, 4);
    assert.equal(runCalls().length, 5);
    assert.equal((await action('restart')).status, 200);
    const restarted = await waitForRun(run => run.id !== running.id && run.state === 'completed');
    assert.deepEqual(restarted.input, scriptGenerationSchema.parse(runInput));
    assert.equal(runCalls().length, 9);
    assert.equal((await action('restart')).status, 409);

    assert.equal((await post('run', { ...brief, locales: ['en-US', 'es-MX'], prompt: 'Pause server retry.' })).status, 202);
    const waiting = await waitForRun(run => run.retryAt !== undefined);
    assert.equal(waiting.results.length, 2);
    assert.equal((await post('run/action', { action: 'pause', id: waiting.id })).status, 200);
    const pausedRetry = await getRun();
    assert.equal(pausedRetry?.state, 'paused');
    assert.equal(pausedRetry?.retryAt, undefined);
    assert.deepEqual(pausedRetry?.results, waiting.results);
  } finally {
    releaseRunLocale?.();
  }

  const english = { locale: 'en-US', utterances: [{ speaker: 1 as const, text: 'Hello.' }, { speaker: 2 as const, text: 'Hi.' }] };
  const englishFile = 'en-US_Friendly_support_call_with_dry_humor.txt';
  const frenchFile = 'fr-CA_Friendly_support_call_with_dry_humor.txt';
  await writeFile(path.join(output, englishFile), 'existing', 'utf8');
  const save = await post('save', { directory: output, style: brief.style, speakers: 2, scripts: [success.script, english] });
  assert.equal(save.status, 200);
  const target = path.join(output, frenchFile);
  assert.deepEqual(await save.json(), [
    { file: frenchFile, path: target },
    { file: englishFile, error: 'A file already exists with this name; it was not overwritten.' },
  ]);
  const contents = await readFile(target, 'utf8');
  assert.equal(contents, 'fr-CA_00001_S1\tBonjour, comment puis-je vous aider?\r\nfr-CA_00002_S2\tJe voudrais changer la date, s’il vous plaît.\r\n');
  assert.deepEqual(parseStudioScript(frenchFile, contents).script.clips.map(clip => [clip.name, clip.text]),
    success.script.utterances.map(({ speaker, text }, index) => [`fr-CA_0000${index + 1}_S${speaker}`, text]));
  assert.equal(await readFile(path.join(output, englishFile), 'utf8'), 'existing');
  assert.deepEqual((await readdir(output)).sort(), [englishFile, frenchFile]);
  assert.equal(scriptFileText({ ...english, utterances: [english.utterances[0]] }, 1), 'en-US_00001\tHello.\r\n');
  assert.equal((await post('save', { directory: output, style: brief.style, speakers: 2, scripts: [{ ...english, locale: '../x' }] })).status, 400);
  assert.equal((await post('save', {
    directory: output, style: brief.style, speakers: 1, scripts: [{ locale: 'en-GB', utterances: [{ speaker: 1, text: 'Two\tfields' }] }],
  })).status, 400);

  assert.equal((await post('settings', { deployment: 'not/a/deployment' }, 'PUT')).status, 400);
  assert.deepEqual(await (await post('settings', { deployment: '  text-saved  ' }, 'PUT')).json(), {
    deployment: 'text-saved', source: 'saved', secureStorageAvailable,
  });
  const restarted = await createApp(options);
  restarted.app.use(restarted.errors);
  server.removeListener('request', app);
  server.on('request', restarted.app);
  assert.deepEqual(await (await fetch(`${url}settings`)).json(), { deployment: 'text-saved', source: 'saved', secureStorageAvailable });
  const callsBeforeAll = calls.length;
  const all = await post('generate', { ...brief, locales: catalog.map(option => option.value) });
  assert.equal(all.status, 200);
  const allResults: ScriptGenerationResult = await all.json();
  assert.deepEqual(allResults.map(result => 'script' in result ? result.script.locale : result.locale), catalog.map(option => option.value));
  assert.equal(calls.length - callsBeforeAll, catalog.length);
  assert.ok(calls.slice(callsBeforeAll).every(call => call.model === 'text-saved'));

  const improvement = { prompt: '  Reschedule a delivery.  ', style: brief.style, speakers: 2, consent: true };
  for (const patch of [{ prompt: '   ' }, { prompt: 'a'.repeat(MAX_SCRIPT_BRIEF_LENGTH + 1) }, { consent: false }]) {
    assert.equal((await post('improve-brief', { ...improvement, ...patch })).status, 400);
  }
  assert.equal(improvementCalls.length, 0);
  delete process.env.AZURE_SPEECH_KEY;
  const improved = await post('improve-brief', improvement);
  assert.equal(improved.status, 200);
  assert.deepEqual(await improved.json(), { suggestion: suggestedBrief });
  assert.equal(improvementCalls.length, 1);
  const [call] = improvementCalls;
  assert.equal(call.model, 'text-saved');
  assert.equal(call.contentBrief, 'Reschedule a delivery.');
  assert.equal(call.style, brief.style.trim());
  assert.equal(call.speakers, 2);
  assert.match(call.instructions, /Keep the original purpose, scenario, required topics and constraints/);
  const invalidSuggestion = await post('improve-brief', { ...improvement, prompt: 'Return too much.' });
  assert.equal(invalidSuggestion.status, 400);
  assert.match((await invalidSuggestion.json()).error, /original brief was not changed/);
  assert.equal(calls.length, callsBeforeAll + catalog.length);
  const foundrySettings = { deployment: 'text-responses', foundry: { endpoint: foundryEndpoint } };
  assert.equal((await post('settings', foundrySettings, 'PUT')).status, 400);
  assert.equal((await post('settings', {
    ...foundrySettings, foundry: { endpoint: 'https://example.com/openai/v1/responses', apiKey: 'test-foundry-key' },
  }, 'PUT')).status, 400);
  if (secureStorageAvailable) {
    const savedFoundry = await post('settings', {
      ...foundrySettings, foundry: { endpoint: new URL(foundryEndpoint).origin, apiKey: 'test-foundry-key' },
    }, 'PUT');
    assert.equal(savedFoundry.status, 200);
    const shown = { ...foundrySettings, source: 'saved', secureStorageAvailable };
    assert.deepEqual(await savedFoundry.json(), shown);
    assert.deepEqual(await (await post('settings', foundrySettings, 'PUT')).json(), shown);
    const raw = await readFile(path.join(options.dataDir, 'script-generation-settings.json'), 'utf8');
    assert.doesNotMatch(raw, /test-foundry-key/);
    assert.equal((await post('settings', {
      ...foundrySettings, foundry: { endpoint: 'https://other-resource.services.ai.azure.com/openai/v1/responses' },
    }, 'PUT')).status, 400);
    const separate = await createApp({ ...options, endpoint: undefined, key: undefined });
    separate.app.use(separate.errors);
    server.removeListener('request', restarted.app);
    server.on('request', separate.app);
    assert.deepEqual(await (await fetch(`${url}settings`)).json(), shown);
    assert.deepEqual(await (await post('improve-brief', improvement)).json(), { suggestion: suggestedBrief });
    process.env.AZURE_SPEECH_KEY = 'test-speech-key';
    const generated = await post('generate', brief);
    assert.equal(generated.status, 200);
    assert.deepEqual(await generated.json(), [{ script: { locale: 'fr-CA', utterances: [
      { speaker: 1, text: 'Bonjour.' }, { speaker: 2, text: 'Merci.' },
    ] } }]);
    assert.deepEqual(foundryCalls, ['improve', 'generate']);
    const rejected = await post('improve-brief', { ...improvement, prompt: 'Mock rejected request' });
    assert.equal(rejected.status, 400);
    const diagnostic = await rejected.text();
    assert.match(diagnostic, /Foundry Responses returned HTTP 400. Azure rejected the JSON output format/);
    assert.match(diagnostic, /01234567-89ab-cdef-0123-456789abcdef/);
    assert.doesNotMatch(diagnostic, /Provider detail|test-foundry-key|Mock rejected request/);
  }
});
