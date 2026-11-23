import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import {
  assignRecordingIds, buildRecordingRows, countWords, DEFAULT_RECORDING_ID_START, parseRecordingDomains, recordingCharacterCount,
  recordingGenerateSchema, recordingScriptText, recordingVariantKey, recordingVariants, type RecordingScript,
} from '../shared/recordingScript.js';
import { RecordingScript as RecordingScriptView } from '../src/RecordingScript.js';

test('counts words with locale-aware segmentation', () => {
  assert.equal(countWords('Hi, I ordered a glass vase and it just arrived completely shattered into a million pieces.', 'en-US'), 16);
  assert.equal(countWords('Oh no, I’m really sorry the vase arrived shattered.', 'en-US'), 9);
  assert.ok(countWords('我约了明天下午装洗衣机。', 'zh-CN') > 1);
  assert.equal(countWords('   ', 'en-US'), 0);
  assert.deepEqual(parseRecordingDomains('telecom, banking;\ne-commerce'), ['telecom', 'banking', 'e-commerce']);
  assert.equal(recordingCharacterCount(buildRecordingRows({ rows: [
    { conversation: 1, scenario: 'Test', role: 'Customer', content: 'hello', tone: '' },
    { conversation: 1, scenario: 'Test', role: 'Agent', content: '世界', tone: 'Calm' },
  ] }, 'en-US', 'Agent')), 7);
  assert.equal(recordingGenerateSchema.safeParse({
    locale: 'en-US', prompt: 'Brief', recordedRole: 'Agent', domains: ['telecom', 'banking'],
    totalCharacters: 1000, consent: true,
  }).success, true);
});

test('plans one recording script per locale and selected Agent gender', () => {
  const locales = ['en-US', 'ja-JP'];
  assert.deepEqual(recordingVariants(locales, ['female', 'male']).map(recordingVariantKey),
    ['en-us:female', 'en-us:male', 'ja-jp:female', 'ja-jp:male']);
  assert.deepEqual(recordingVariants(locales, ['male']).map(recordingVariantKey), ['en-us:male', 'ja-jp:male']);
  assert.deepEqual(recordingVariants(locales, []).map(recordingVariantKey), ['en-us:', 'ja-jp:']);
});

test('builds rows with per-conversation turns, recorded-role tones and IDs that restart in each file', () => {
  const draft = { rows: [
    { conversation: 1, scenario: 'Inbound', role: 'Customer', content: 'My vase\tarrived broken.', tone: 'Upset' },
    { conversation: 1, scenario: 'Inbound', role: 'Agent', content: 'I am so sorry.\nLet me fix that.', tone: 'Apologetic' },
    { conversation: 2, scenario: 'Outbound', role: 'agent', content: 'Hello again.', tone: 'Cheerful' },
  ] };
  const rows = buildRecordingRows(draft, 'en-US', 'Agent');
  assert.deepEqual(rows.map(row => [row.turn, row.role, row.content, row.tone, row.wordCount]), [
    [1, 'Customer', 'My vase arrived broken.', '', 4],
    [2, 'Agent', 'I am so sorry. Let me fix that.', 'Apologetic', 8],
    [1, 'agent', 'Hello again.', 'Cheerful', 2],
  ]);
  const scripts: RecordingScript[] = [{ locale: 'en-US', rows }, { locale: 'fr-FR', rows: rows.slice(1, 2) }];
  const numbered = assignRecordingIds(scripts, '0009', 'Agent');
  assert.deepEqual(numbered.map(script => script.rows.map(row => row.id)), [['', '0009', '0010'], ['0009']]);
  assert.equal(recordingScriptText(numbered[1], 'Agent'),
    'ID\tScenario\tTurn\tRole\tContent\tAgent Emotional Tone\tWordcount\r\n0009\tInbound\t2\tAgent\tI am so sorry. Let me fix that.\tApologetic\t8\r\n');
  assert.deepEqual(assignRecordingIds(scripts, DEFAULT_RECORDING_ID_START, 'Agent').map(script => script.rows.find(row => row.id)?.id),
    ['4010000001', '4010000001']);
  assert.deepEqual(assignRecordingIds(scripts, '1', '').map(script => script.rows.map(row => row.id)), [['1', '2', '3'], ['1']]);
});

test('generates and saves recording scripts through the Recording script routes', async t => {
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-recording-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = path.join(root, 'scripts');
  await mkdir(output);
  const speechFetch: typeof fetch = async () => Response.json(['en-US', 'ja-JP'].map((Locale, index) => ({
    ShortName: `voice-${index}`, DisplayName: `Voice ${index}`, Gender: 'Female', Locale, SecondaryLocaleList: [],
  })));
  const specs: {
    locale: string; recordedRole: string; contentBrief: string; domains: string[];
    totalCharacters?: number; previousAttemptProblem?: string; agentGender?: string; customerGender?: string; previousScenarios?: string[];
    batchNumber?: number;
  }[] = [];
  let simulateTimeout = true;
  const scriptFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const spec = JSON.parse(body.messages[1].content);
    specs.push(spec);
    assert.match(body.messages[0].content, /tone/);
    assert.match(body.messages[0].content, /Start every service Agent reply with a short, audible acknowledgment/);
    assert.match(body.messages[0].content, /Yep, got it.*Sure.*Of course/);
    assert.match(body.messages[0].content, /locally natural equivalents, not literal translations or a required phrase list/);
    assert.match(body.messages[0].content, /does not mean repeating the problem or delivering a full sentence of sympathy on every turn/);
    assert.match(body.messages[0].content, /For every locale, write dialogue that sounds like a real local phone conversation/);
    assert.match(body.messages[0].content, /actively use familiar loanwords or brief, idiomatic code-switches where local speakers would naturally use them/);
    assert.match(body.messages[0].content, /include at least one concrete timing detail in most calls/);
    assert.match(body.messages[0].content, /at most twice across the script and never on consecutive Agent turns/);
    assert.match(body.messages[0].content, /grammar and forms of address for both the speaker and the listener/);
    assert.match(body.messages[0].content, /Cover every supplied domain/);
    assert.match(body.messages[0].content, /different incidents, underlying causes, and fixes/);
    assert.match(body.messages[0].content, /count only Unicode characters in Agent spoken content/);
    assert.match(body.messages[0].content, /dividing the target by the number of domains/);
    if (spec.batchNumber) {
      assert.equal(spec.domains.length, 1);
      assert.ok(spec.totalCharacters > 0 && spec.totalCharacters <= 1800);
      assert.equal(spec.agentGender, 'female');
      assert.equal(spec.customerGender, 'male');
      if (spec.batchNumber === 2 && simulateTimeout) {
        simulateTimeout = false;
        throw new DOMException('Mock timeout', 'TimeoutError');
      }
      const rows = Array.from({ length: 24 }, (_, index) => {
        const conversation = Math.floor(index / 6) + 1;
        const scenario = `${spec.domains[0]} — Batch ${spec.batchNumber} case ${conversation}`;
        const chars = Math.floor(spec.totalCharacters / 24) + Number(index < spec.totalCharacters % 24);
        return [
          { conversation, scenario, role: 'Customer', content: 'I need help.', tone: '' },
          { conversation, scenario, role: 'Agent', content: 'A'.repeat(chars), tone: 'Attentive' },
        ];
      }).flat();
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ rows }) } }] });
    }
    const missingRole = spec.contentBrief === 'Wrong role first.' && !spec.previousAttemptProblem;
    const rows = [
      { conversation: 1, scenario: `${spec.domains[0]} — Inbound`, role: 'Customer', content: 'My vase arrived shattered.', tone: spec.recordedRole === 'Agent' ? '' : 'Concerned' },
      { conversation: 1, scenario: `${spec.domains[0]} — Inbound`, role: missingRole ? 'Representative' : 'Agent', content: 'I am really sorry about that.', tone: 'Apologetic' },
      { conversation: 2, scenario: `${spec.domains[1]} — Inbound`, role: 'Customer', content: 'My vase arrived shattered.', tone: spec.recordedRole === 'Agent' ? '' : 'Concerned' },
      { conversation: 2, scenario: `${spec.domains[1]} — Inbound`, role: missingRole ? 'Representative' : 'Agent', content: spec.contentBrief === 'Uneven agent dialogue.' ? 'OK.' : 'I am really sorry about that.', tone: 'Apologetic' },
    ];
    if (spec.previousScenarios?.length && spec.previousAttemptProblem) {
      for (const row of rows) {
        row.scenario = row.scenario.replace('Inbound', row.conversation === 1 ? 'SIM activation' : 'Card lock');
        row.content = row.role === 'Agent' ? 'I can help you restore access.' : 'I cannot activate it.';
      }
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ rows }) } }] });
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) assert.fail('Expected a local TCP address.');
  const appOptions = {
    dataDir: path.join(root, 'data'), port: address.port, endpoint: 'https://script-test.openai.azure.com', key: 'test-key',
    scriptDeployment: 'text-default', scriptFetch, speechFetch,
  };
  const { app, errors } = await createApp(appOptions);
  app.use(errors);
  server.on('request', app);
  const post = (route: string, value: unknown) => fetch(`http://127.0.0.1:${address.port}/api/recording-script/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });

  const request = {
    locale: 'en-US', prompt: 'Write one inbound call.', recordedRole: 'Agent',
    domains: ['Telecom', 'Banking'], totalCharacters: 1, consent: true,
  };
  assert.equal((await post('generate', { ...request, consent: false })).status, 400);
  const unknown = await post('generate', { ...request, locale: 'it-IT' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /it-IT is not in the current Azure Speech voice catalog/);

  const generated = await post('generate', request);
  assert.equal(generated.status, 200);
  const script: RecordingScript = await generated.json();
  assert.deepEqual(script.rows.map(row => [row.id, row.turn, row.role, row.tone, row.wordCount]),
    [['', 1, 'Customer', '', 4], ['', 2, 'Agent', 'Apologetic', 6],
      ['', 1, 'Customer', '', 4], ['', 2, 'Agent', 'Apologetic', 6]]);
  assert.equal(specs.at(-1)?.recordedRole, 'Agent');
  assert.deepEqual(specs.at(-1)?.domains, ['Telecom', 'Banking']);
  assert.equal(specs.at(-1)?.totalCharacters, 1);
  assert.equal(specs.at(-1)?.agentGender, undefined);
  assert.equal(specs.at(-1)?.customerGender, undefined);

  const retried = await post('generate', { ...request, prompt: 'Wrong role first.', agentGender: 'female' });
  assert.equal(retried.status, 200);
  assert.match(specs.at(-1)?.previousAttemptProblem ?? '', /No row used the role "Agent"/);
  assert.deepEqual(specs.slice(-2).map(spec => [spec.agentGender, spec.customerGender]), [['female', 'male'], ['female', 'male']]);
  const femaleScript: RecordingScript = await retried.json();
  assert.equal(femaleScript.agentGender, 'female');

  const previousScenarios = [...new Set(femaleScript.rows.map(row => row.scenario))];
  const male = await post('generate', { ...request, agentGender: 'male', previousScenarios });
  assert.equal(male.status, 200);
  const maleScript: RecordingScript = await male.json();
  assert.equal(maleScript.agentGender, 'male');
  assert.deepEqual([specs.at(-1)?.agentGender, specs.at(-1)?.customerGender], ['male', 'female']);
  assert.deepEqual(specs.at(-1)?.previousScenarios, previousScenarios);
  assert.match(specs.at(-1)?.previousAttemptProblem ?? '', /reused a scenario label/);
  assert.equal(specs.at(-1)?.totalCharacters, request.totalCharacters);
  assert.deepEqual(specs.at(-1)?.domains, request.domains);
  assert.ok(maleScript.rows.every(row => !previousScenarios.includes(row.scenario)));
  const requestCount = specs.length;
  assert.equal((await post('generate', { ...request, agentGender: 'invalid' })).status, 400);
  assert.equal(specs.length, requestCount);

  assert.equal((await post('generate', { ...request, totalCharacters: 58 })).status, 200);
  const short = await post('generate', { ...request, recordedRole: 'Customer', totalCharacters: 59 });
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /58 Agent spoken-content characters; the target is at least 59/);
  const uneven = await post('generate', { ...request, prompt: 'Uneven agent dialogue.', totalCharacters: 32 });
  assert.equal(uneven.status, 400);
  assert.match((await uneven.json()).error, /Banking fewer than 12 Agent spoken-content characters/);

  const numbered = assignRecordingIds([femaleScript, maleScript], '000123456789012345', 'Agent');
  numbered[0].rows[2].content = '你好，請幫我確認這筆款項。';
  const save = { directory: output, name: 'Customer service', recordedRole: 'Agent', scripts: numbered };
  assert.equal((await post('save', { ...save, scripts: [numbered[0], numbered[0]] })).status, 400);
  const saved = await post('save', save);
  assert.equal(saved.status, 200);
  const [result, maleResult] = await saved.json();
  assert.equal(result.file, 'en-US_Customer_service_Female.xlsx');
  assert.equal(maleResult.file, 'en-US_Customer_service_Male.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(output, result.file));
  const sheet = workbook.getWorksheet('Recording script');
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 5);
  assert.deepEqual(sheet.getRow(1).values, [, 'ID', 'Scenario', 'Turn', 'Role', 'Content', 'Agent Emotional Tone', 'Wordcount']);
  assert.deepEqual(sheet.getRow(3).values, [, '000123456789012345', 'Telecom — Inbound', 2, 'Agent', 'I am really sorry about that.', 'Apologetic', 6]);
  assert.equal(sheet.getCell('E4').value, '你好，請幫我確認這筆款項。');
  assert.equal(sheet.getCell('A5').value, '000123456789012346');
  const maleWorkbook = new ExcelJS.Workbook();
  await maleWorkbook.xlsx.readFile(path.join(output, maleResult.file));
  assert.equal(maleWorkbook.getWorksheet('Recording script')?.getCell('E3').value, 'I can help you restore access.');
  assert.equal(maleWorkbook.getWorksheet('Recording script')?.getCell('A3').value, '000123456789012345');
  assert.equal(maleWorkbook.getWorksheet('Recording script')?.getCell('A5').value, '000123456789012346');
  const again = await (await post('save', save)).json();
  assert.match(again[0].error, /already exists/);
  const unspecified = await post('save', { ...save, scripts: [script] });
  assert.equal(unspecified.status, 200);
  assert.equal((await unspecified.json())[0].file, 'en-US_Customer_service.xlsx');

  const longRun = {
    runId: '37c4a0e9-d782-46e9-92d4-6784a4bdec14',
    input: { ...request, totalCharacters: 70_000, agentGender: 'female' },
  };
  let step = await post('batch', longRun);
  assert.equal(step.status, 200);
  const firstBatch = await step.json();
  assert.equal(firstBatch.batches, 1);
  assert.equal(firstBatch.done, false);
  assert.ok(firstBatch.characters > 0);
  step = await post('batch', longRun);
  assert.equal(step.status, 400);
  assert.match((await step.json()).error, /timed out/);
  const restarted = await createApp(appOptions);
  restarted.app.use(restarted.errors);
  server.off('request', app);
  server.on('request', restarted.app);
  step = await post('batch', { ...longRun, input: { ...longRun.input, totalCharacters: 71_000 } });
  assert.equal(step.status, 400);
  assert.match((await step.json()).error, /different settings/);
  let progress = firstBatch;
  for (let attempt = 0; attempt < 50 && !progress.done; attempt++) {
    step = await post('batch', longRun);
    assert.equal(step.status, 200);
    const next = await step.json();
    assert.equal(next.batches, progress.batches + 1);
    assert.ok(next.characters > progress.characters);
    progress = next;
  }
  assert.equal(progress.done, true);
  assert.equal(progress.characters, 70_000);
  const merged: RecordingScript = progress.script;
  const agentRows = merged.rows.filter(row => row.role === 'Agent');
  for (const domain of longRun.input.domains) {
    assert.equal(recordingCharacterCount(agentRows.filter(row => row.scenario.startsWith(`${domain} — `))), 35_000);
  }
  assert.equal(specs.filter(spec => spec.batchNumber === 1).length, 1);
  assert.equal(merged.rows.length, progress.batches * 48);
  assert.equal(new Set(merged.rows.filter(row => row.turn === 1).map(row => row.scenario)).size, progress.batches * 4);
  const calls = specs.length;
  assert.deepEqual(await (await post('batch', longRun)).json(), progress);
  assert.equal(specs.length, calls);
  const longExport = await post('save', {
    ...save, name: 'Long run', scripts: assignRecordingIds([merged], DEFAULT_RECORDING_ID_START, 'Agent'),
  });
  assert.equal(longExport.status, 200);
  const [longFile] = await longExport.json();
  assert.equal(longFile.file, 'en-US_Long_run_Female.xlsx');
  const longWorkbook = new ExcelJS.Workbook();
  await longWorkbook.xlsx.readFile(path.join(output, longFile.file));
  const longSheet = longWorkbook.getWorksheet('Recording script');
  assert.ok(longSheet);
  assert.equal(longSheet.rowCount, merged.rows.length + 1);
  assert.equal(longSheet.getCell('A3').value, '4010000001');
  assert.equal(longSheet.getCell(`A${longSheet.rowCount}`).value, `${4_010_000_000 + agentRows.length}`);
  assert.equal(longSheet.getColumn(5).values.slice(2).reduce<number>((sum, value, index) =>
    sum + (index % 2 === 1 ? Array.from(String(value)).length : 0), 0), 70_000);
});

function renderRecordingScript() {
  return renderToStaticMarkup(createElement(RecordingScriptView, {
    request: async () => { throw new Error('not used'); }, active: false, connected: true, speechConfigured: true,
    deployment: 'text-default', azureBusy: false, onConfigure: () => undefined,
  }));
}

test('renders the Recording script workspace with the default brief and column guide', () => {
  const html = renderRecordingScript();
  assert.match(html, /01 · Recording script brief/);
  const controlsStart = html.indexOf('class="filter-bar script-brief-controls recording-script-controls">');
  assert.ok(controlsStart >= 0);
  const controlsEnd = html.indexOf('</div><label>Domains<input', controlsStart);
  assert.ok(controlsEnd > controlsStart);
  assert.doesNotMatch(html.slice(controlsStart, controlsEnd), />Domains<input/);
  assert.match(html.slice(controlsStart), /<\/div><label>Domains<input[^>]*>[^]*?<\/label><label>Content brief<textarea/);
  assert.match(html, /Agent characters per locale/);
  assert.match(html, /Customer replies do not count/);
  assert.match(html, /Start every service Agent reply with a short, audible acknowledgment/);
  assert.match(html, /not a repeated full sentence about how the Customer must feel/);
  assert.match(html, /in any locale, prefer the natural local expression when mixing would sound forced/);
  assert.match(html, /use a mix of calendar dates, clock times, and time windows/);
  assert.match(html, /role="group" aria-labelledby="recording-agent-gender"/);
  assert.match(html, /type="checkbox"\/>Female<\/label><label[^>]*><input type="checkbox"\/>Male<\/label>/);
  assert.match(html, /correct agreement for the current speaker, the person being addressed, and anyone being referred to/);
  assert.match(html, /Domains/);
  assert.match(html, /ID · Scenario · Turn · Role · Content · Agent Emotional Tone · Wordcount/);
  assert.match(html, /Generate recording scripts/);
  assert.match(html, /en-US_Recording_script\.xlsx/);
});

test('restores a saved Recording script form snapshot instead of an unsaved draft', t => {
  const storage = new Map([
    ['voices-playground.recording-script-brief.v1', 'Unsaved brief'],
    ['voices-playground.recording-script-defaults.v1', JSON.stringify({
      prompt: 'Saved brief', domainsText: 'Travel; Telecom', totalCharactersText: '70000',
      agentGenders: ['female', 'male'], recordedRole: '', idStart: '0003', fileName: 'Saved_script',
      localeSearch: 'Cantonese', selection: ['zh-HK', 'vi-VN'], directory: '',
    })],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const html = renderRecordingScript();
  assert.match(html, />Saved brief<\/textarea>/);
  assert.doesNotMatch(html, /Unsaved brief/);
  assert.match(html, /value="Travel; Telecom"/);
  assert.match(html, /value="70000"/);
  assert.match(html, /value="0003"/);
  assert.match(html, /Recorded role<input[^>]*value=""/);
  assert.match(html, /checked=""\/>Female/);
  assert.match(html, /checked=""\/>Male/);
  assert.match(html, /zh-HK_Saved_script_Female\.xlsx/);
  assert.match(html, /4 scripts selected/);
  assert.match(html, /Save current fields as defaults/);
});
