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
import { RecordingGenerationProgress, RecordingScript as RecordingScriptView } from '../src/RecordingScript.js';
import { RecordingBatchScheduler } from '../src/recordingBatchScheduler.js';

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
  const parallelLocales = ['en-US', 'ja-JP', 'fr-FR', 'zh-HK', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'ko-KR', 'th-TH',
    'en-GB', 'en-AU', 'fr-CA', 'zh-CN', 'es-MX', 'pt-PT', 'da-DK', 'sv-SE', 'fi-FI', 'pl-PL'];
  const speechFetch: typeof fetch = async () => Response.json([...parallelLocales, 'vi-VN'].map((Locale, index) => ({
    ShortName: `voice-${index}`, DisplayName: `Voice ${index}`, Gender: 'Female', Locale, SecondaryLocaleList: [],
  })));
  const specs: {
    locale: string; recordedRole: string; contentBrief: string; domains: string[];
    totalCharacters?: number; previousAttemptProblem?: string; agentGender?: string; customerGender?: string; previousScenarios?: string[];
    batchNumber?: number; scenarioFocus?: string;
  }[] = [];
  let simulateTimeout = true;
  const parallelGate = new AbortController();
  const parallelWorkbooks = [
    { locale: parallelLocales[0], agentGender: 'female' as const },
    { locale: parallelLocales[0], agentGender: 'male' as const },
    ...parallelLocales.slice(1, 19).map(locale => ({ locale, agentGender: 'female' as const })),
  ];
  const entered = new Map(parallelWorkbooks.map(target => [recordingVariantKey(target), new AbortController()]));
  const waitForGate = (gate: AbortController) => gate.signal.aborted
    ? Promise.resolve() : once(gate.signal, 'abort').then(() => undefined);
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
      assert.ok(spec.agentGender === 'female' || spec.agentGender === 'male');
      assert.equal(spec.customerGender, spec.agentGender === 'female' ? 'male' : 'female');
      if (spec.contentBrief === 'Throttled batch test.') {
        return Response.json({}, { status: 429, headers: { 'Retry-After': '9' } });
      }
      if (spec.contentBrief === 'Azure server error test.') {
        return Response.json({}, { status: 500, headers: { 'Retry-After': '12' } });
      }
      if (spec.contentBrief === 'Invalid batch draft test.') {
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
      }
      if (spec.contentBrief === 'Filtered batch test.') {
        return Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: null } }] });
      }
      if (spec.contentBrief === 'Parallel batch test.' && spec.batchNumber === 1) {
        const key = recordingVariantKey({ locale: spec.locale, agentGender: spec.agentGender });
        const gate = entered.get(key);
        assert.ok(gate, `Unexpected parallel batch for ${key}`);
        gate.abort();
        await waitForGate(parallelGate);
      }
      if (spec.batchNumber === 2 && simulateTimeout) {
        simulateTimeout = false;
        throw new DOMException('Mock timeout', 'TimeoutError');
      }
      const rows = Array.from({ length: 24 }, (_, index) => {
        const conversation = Math.floor(index / 6) + 1;
        const variant = spec.contentBrief === 'Parallel batch test.' ? `${spec.agentGender} ` : '';
        const scenario = `${spec.domains[0]} — ${variant}Batch ${spec.batchNumber} case ${conversation}`;
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
  const unknown = await post('generate', { ...request, locale: 'nl-NL' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /nl-NL is not in the current Azure Speech voice catalog/);

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
  step = await post('batch', { ...longRun, paired: true });
  assert.equal(step.status, 504);
  assert.match((await step.json()).error, /timed out/);
  const throttled = await post('batch', {
    ...longRun, runId: '37c4a0e9-d782-46e9-92d4-6784a4bdec16',
    input: { ...longRun.input, prompt: 'Throttled batch test.' },
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('Retry-After'), '9');
  for (const [prompt, status, message] of [
    ['Azure server error test.', 502, /Azure OpenAI returned HTTP 500/],
    ['Invalid batch draft test.', 422, /did not match the required rows format/],
    ['Filtered batch test.', 400, /declined this request/],
  ] as const) {
    const response = await post('batch', {
      ...longRun, runId: '37c4a0e9-d782-46e9-92d4-6784a4bdec17', input: { ...longRun.input, prompt },
    });
    assert.equal(response.status, status);
    assert.match((await response.json()).error, message);
    if (status === 502) assert.equal(response.headers.get('Retry-After'), '12');
  }
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
  assert.equal(specs.filter(spec => spec.batchNumber === 1 && spec.contentBrief === longRun.input.prompt).length, 1);
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

  const parallelRun = {
    runId: '37c4a0e9-d782-46e9-92d4-6784a4bdec15',
    input: { ...longRun.input, prompt: 'Parallel batch test.' },
  };
  const parallelBatch = (locale: string, agentGender = 'female') => post('batch', {
    ...parallelRun, ...(locale === 'en-US' ? { paired: true } : {}),
    input: { ...parallelRun.input, locale, agentGender },
  });
  const inFlight: Promise<Response>[] = [];
  try {
    for (const target of parallelWorkbooks) {
      const { locale, agentGender } = target;
      const gate = entered.get(recordingVariantKey(target))!;
      const batch = parallelBatch(locale, agentGender);
      inFlight.push(batch);
      await Promise.race([waitForGate(gate), batch.then(response => assert.fail(`${locale} returned ${response.status} before entering Azure.`))]);
      if (locale === 'en-US') assert.equal((await parallelBatch(locale, agentGender)).status, 409);
    }
    assert.equal((await parallelBatch('vi-VN')).status, 409);
    assert.equal((await post('generate', request)).status, 409);
  } finally { parallelGate.abort(); }
  assert.deepEqual((await Promise.all(inFlight)).map(response => response.status), Array(20).fill(200));
  const pairedSpecs = specs.filter(spec => spec.contentBrief === 'Parallel batch test.' && spec.locale === 'en-US');
  assert.match(pairedSpecs.find(spec => spec.agentGender === 'female')?.scenarioFocus ?? '', /before or during/);
  assert.match(pairedSpecs.find(spec => spec.agentGender === 'male')?.scenarioFocus ?? '', /after a transaction/);
  for (const gender of ['female', 'male']) {
    const nextPaired = await parallelBatch('en-US', gender);
    assert.equal(nextPaired.status, 200);
    assert.equal((await nextPaired.json()).batches, 2);
  }
  const nextMale = specs.at(-1)!;
  assert.ok(nextMale.previousScenarios?.includes(`${nextMale.domains[0]} — female Batch 2 case 1`));
});

test('ramps recording batch concurrency to twenty without counting restored checkpoints', async t => {
  const limits: number[] = [];
  const scheduler = new RecordingBatchScheduler(20, limit => limits.push(limit));
  t.after(() => scheduler.close());
  for (let index = 0; index < 15; index++) await scheduler.request(async () => ({ done: true }));
  assert.deepEqual(limits, [4]);
  for (let index = 0; index < 184; index++) await scheduler.request(async () => ({ done: false }));
  assert.deepEqual(limits, Array.from({ length: 17 }, (_, index) => index + 4));
  const gate = new AbortController();
  const released = once(gate.signal, 'abort');
  let started = 0;
  const work = Array.from({ length: 21 }, () => scheduler.request(async () => {
    started++;
    await released;
    return { done: false };
  }));
  await Promise.resolve();
  try { assert.equal(started, 20); }
  finally { gate.abort(); }
  await Promise.all(work);
  assert.equal(started, 21);
});

test('returns to the last stable limit after a failed probe and waits before increasing again', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let limit = 0;
  const scheduler = new RecordingBatchScheduler(20, next => { limit = next; }, 0);
  t.after(() => scheduler.close());
  const success = () => scheduler.request(async () => ({ done: false }));
  const throttleOnce = async () => {
    let attempts = 0;
    await scheduler.request(async () => {
      if (attempts++ === 0) throw Object.assign(new Error('Throttled'), { status: 429 });
      return { done: false };
    });
  };
  for (let index = 0; index < 9; index++) await success();
  assert.equal(limit, 6);
  await throttleOnce();
  assert.equal(limit, 5);
  now += 59_999;
  for (let index = 0; index < 5; index++) await success();
  assert.equal(limit, 5);
  now++;
  await success();
  assert.equal(limit, 6);
  await throttleOnce();
  assert.equal(limit, 5);
  await throttleOnce();
  assert.equal(limit, 2);
});

test('backs off on Azure throttling and timeouts, retries, and leaves other errors alone', async t => {
  const changes: Array<{ limit: number; until: number }> = [];
  const scheduler = new RecordingBatchScheduler(10, (limit, until) => changes.push({ limit, until }), 1);
  t.after(() => scheduler.close());
  let attempts = 0;
  let cooldown = 0;
  const result = await scheduler.request(async () => {
    attempts++;
    if (attempts === 1) {
      cooldown = Date.now() + 10;
      throw Object.assign(new Error('Throttled'), { status: 429, retryAfterMs: 10 });
    }
    assert.ok(Date.now() >= cooldown);
    if (attempts === 2) throw Object.assign(new Error('Timeout'), { status: 504 });
    return { done: false };
  });
  assert.deepEqual(result, { done: false });
  assert.equal(attempts, 3);
  assert.deepEqual(changes.filter(change => change.until > 0).map(change => change.limit), [2, 1]);
  let failures = 0;
  await assert.rejects(scheduler.request(async () => {
    failures++;
    throw new Error('Invalid credentials');
  }), /Invalid credentials/);
  assert.equal(failures, 1);
});

test('retries recoverable batches beyond three attempts without blocking other queued work', async t => {
  const scheduler = new RecordingBatchScheduler(1, () => {}, 1);
  t.after(() => scheduler.close());
  const attempts = [502, 422, 503, 502, 429, 504];
  const order: string[] = [];
  const retries: number[] = [];
  let other: Promise<{ done: boolean }> | undefined;
  const result = await scheduler.request(async () => {
    const status = attempts.shift();
    order.push(status ? String(status) : 'success');
    if (status) throw Object.assign(new Error('Retryable batch error'), { status });
    return { done: true };
  }, retry => {
    retries.push(retry.attempt);
    if (retry.attempt === 1) other = scheduler.request(async () => {
      order.push('other workbook');
      return { done: true };
    });
  });
  await other;
  assert.deepEqual(result, { done: true });
  assert.deepEqual(retries, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(order, ['502', 'other workbook', '422', '503', '502', '429', '504', 'success']);
});

test('stopping cancels a batch waiting for a retry', async () => {
  const scheduler = new RecordingBatchScheduler(1, () => {}, 60_000);
  let calls = 0;
  await assert.rejects(scheduler.request(async () => {
    calls++;
    throw Object.assign(new Error('Temporary error'), { status: 502 });
  }, () => queueMicrotask(() => scheduler.close())), /scheduling stopped/);
  assert.equal(calls, 1);
});

function renderRecordingScript() {
  return renderToStaticMarkup(createElement(RecordingScriptView, {
    request: async () => { throw new Error('not used'); }, active: false, connected: true, speechConfigured: true,
    deployment: 'text-default', azureBusy: false, onConfigure: () => undefined,
  }));
}

test('shows live Recording script progress from finished scripts and saved batches', () => {
  const render = (props: Parameters<typeof RecordingGenerationProgress>[0]) =>
    renderToStaticMarkup(createElement(RecordingGenerationProgress, props));
  assert.match(render({ completed: 0, total: 24 }), /aria-valuenow="0"/);
  const partial = render({ completed: 0, total: 24, batches: {
    'en-us:female': { label: 'English', characters: 35_000, target: 70_000, batches: 20 },
    'ja-jp:female': { label: 'Japanese', characters: 35_000, target: 70_000, batches: 18 },
  } });
  assert.match(partial, /<strong>4\.1%<\/strong>/);
  assert.match(partial, /aria-valuenow="4\.1"/);
  assert.match(partial, /20 batches saved/);
  assert.match(partial, /18 batches saved/);
  assert.match(render({ completed: 1, total: 2, batches: {
    'en-us:female': { label: 'English', characters: 70_001, target: 70_000, batches: 40 },
  } }), /aria-valuenow="99\.9"/);
  assert.match(render({ completed: 1, total: 2 }), /aria-valuenow="50"/);
  assert.match(render({ completed: 2, total: 2 }), /aria-valuenow="100"/);
});

test('lists in-progress workbooks by saved Agent characters, highest first', () => {
  const html = renderToStaticMarkup(createElement(RecordingGenerationProgress, {
    completed: 4, total: 24, batches: {
      'fr-fr:male': { label: 'French (France) Male', characters: 61_243, target: 80_000, batches: 34 },
      'en-us:male': { label: 'English (US) Male', characters: 20_427, target: 80_000, batches: 11 },
      'ko-kr:female': { label: 'Korean (Korea) Female', characters: 69_348, target: 80_000, batches: 39 },
    },
  }));
  assert.deepEqual([...html.matchAll(/<p class="muted" role="status">([^:]+):/g)].map(([, label]) => label),
    ['Korean (Korea) Female', 'French (France) Male', 'English (US) Male']);
});

test('renders the Recording script workspace with the default brief and column guide', () => {
  const html = renderRecordingScript();
  assert.match(html, /01 · Recording script brief/);
  const controlsStart = html.indexOf('class="filter-bar script-brief-controls recording-script-controls">');
  assert.ok(controlsStart >= 0);
  const controlsEnd = html.indexOf('</div><label>Domains<input', controlsStart);
  assert.ok(controlsEnd > controlsStart);
  assert.doesNotMatch(html.slice(controlsStart, controlsEnd), />Domains<input/);
  assert.match(html.slice(controlsStart), /<\/div><label>Domains<input[^>]*>[^]*?<\/label><label>Content brief<textarea/);
  assert.match(html, /Domains<input[^>]*value="Online Shopping, Food Delivery, Travel, Hospitality, Telecom, Banking, Financial Services, Insurance, Restaurant, Tour, Medical, Spa"/);
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
