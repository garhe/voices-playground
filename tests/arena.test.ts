import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExcelJS from 'exceljs';
import { ArenaImport } from '../server/arena.js';
import { createApp } from '../server/app.js';
import { arenaData, arenaImportSchema, arenaScript, arenaUploadSchema, type ArenaData, type ArenaPreview } from '../shared/arena.js';
import { parseSortingPaths } from '../shared/sorting.js';
import { type Job, type TestQueueState, ARENA_RUBRIC, ARENA_TEST_GUIDE, activeDimensions, dimensionLabel, profileSchema } from '../shared/domain.js';
import { testHistory, type TestHistory } from '../shared/history.js';
import { assessmentTool, instructions, parseAssessment } from '../server/realtime.js';
import { voiceDescriptorKeys, type VoiceDescriptors } from '../shared/voiceDescriptors.js';
import { voiceDescriptorRows } from '../shared/voiceDescriptorResults.js';
import { VoiceDescriptorReport } from '../src/VoiceDescriptorReport.js';
import { VoiceArena } from '../src/VoiceArena.js';
import { arenaComparisonWorkbook, arenaWorkbook } from '../src/arenaExcel.js';
import { ArenaVoiceReport } from '../src/ArenaVoiceReport.js';
import { ArenaDimensionComparison } from '../src/ArenaDimensionComparison.js';
import { ArenaScoreMatrix } from '../src/ArenaScoreMatrix.js';
import { ArenaTestStatus } from '../src/ArenaTestStatus.js';
import { TtsIssueSummary } from '../src/TtsIssueSummary.js';
import { summarizeTtsIssues } from '../shared/ttsIssues.js';
import { queueForWorkspace } from '../src/TestQueue.js';
import { arenaDetailMatches, arenaDetailOptions, arenaDetailSelectionForCell, arenaVoiceName } from '../src/arenaDetails.js';
import { createHistoryLoader, workspaceHistory } from '../src/historyLoader.js';
import { EvaluationWorkbench } from '../src/App.js';
import { batchTestProfile } from '../src/batch.js';
import { newTestProfile, withArenaRubric, withLanguageAccent } from '../src/readiness.js';
import { job, clip, assessment } from './fixtures.js';

async function file(root: string, relative: string, contents = 'audio') {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}
const avaLatest = 'en-US-Ava:DragonHDLatestNeural';
const avaV3 = 'en-US-Ava:DragonHDV3Neural';

const descriptors: VoiceDescriptors = {
  speakingStyle: 'Conversational', tone: 'Warm', energyLevel: 'Moderate', speakingPace: 'Moderate',
  expressiveness: 'Neutral', perceivedAgeGroup: 'Adult', voicePersona: 'Reassuring helper', domainSuitability: 'Customer service',
};

test('new Arena judge tool requests exactly eight single-label fields and retains them on parsing', () => {
  assert.ok(!assessmentTool().parameters.required.includes('voiceDescriptors'));
  const tool = assessmentTool({}, 'speaker', true);
  assert.ok(tool.parameters.required.includes('voiceDescriptors'));
  assert.deepEqual(tool.parameters.properties.voiceDescriptors?.required, voiceDescriptorKeys);
  const result = arenaJob(avaLatest, 'en-US', '2026-02-01', 4.6);
  const value = { ...result.results[0].assessment!, voiceDescriptors: descriptors };
  assert.deepEqual(parseAssessment(JSON.stringify(value), result.profile).voiceDescriptors, descriptors);
  assert.throws(() => parseAssessment(JSON.stringify({ ...value, voiceDescriptors: { ...descriptors, tone: ['Warm', 'Calm'] } }), result.profile));
});

test('Arena shows only the top label per category, isolates voices, and keeps older reports unchanged', () => {
  const result = arenaJob(avaLatest, 'en-US', '2026-02-01', 4.6);
  const baseline = arenaData([result]).cells[0];
  assert.equal(baseline.voiceDescriptors, undefined);
  result.collectVoiceDescriptors = true;
  for (const entry of result.results) entry.assessment!.voiceDescriptors = descriptors;
  assert.deepEqual(arenaData([result]).cells[0].voiceDescriptors, descriptors);
  assert.equal(arenaData([result]).cells[0].score, baseline.score);
  result.results[0].assessment!.voiceDescriptors = { ...descriptors, tone: 'Calm' };
  assert.equal(voiceDescriptorRows(result)[0].labels.tone, 'Warm');
  assert.equal(voiceDescriptorRows({ ...result, results: [...result.results].reverse() })[0].labels.tone, 'Warm');
  const html = renderToStaticMarkup(createElement(ArenaVoiceReport, { job: result, voice: avaLatest, busy: false, onOpen: () => {} }));
  assert.match(html, /<dt>Tone<\/dt><dd>Warm<\/dd>/);
  assert.match(html, /<dt>Domain suitability<\/dt><dd>Customer service<\/dd>/);
  assert.match(html, /<dt>Voice persona<\/dt><dd>Reassuring helper<\/dd>/);
});

test('Scoring descriptors separate model, script locale and role, including best estimates without scores', () => {
  const result = job([
    clip({ voice: avaLatest, language: 'en-US', role: 'agent' }),
    clip({ voice: avaLatest, language: 'fr-FR', role: 'agent' }),
    clip({ voice: avaLatest, language: 'en-US', role: 'customer' }),
    clip({ voice: avaV3, language: 'en-US', role: 'agent' }),
  ], [4, 4]);
  result.profile = { ...result.profile, scope: 'both', speakerMode: 'automatic' };
  assert.equal(renderToStaticMarkup(createElement(VoiceDescriptorReport, { job: result })), '');
  result.collectVoiceDescriptors = true;
  for (const entry of result.results) {
    const source = result.clips.find(item => item.id === entry.clipId)!;
    entry.assessment!.speakerAttribution = { role: source.role, status: source.role === 'customer' ? 'not_present' : 'identified', evidence: 'Fixture' };
    entry.assessment!.assessable = false;
    entry.assessment!.languageSupported = false;
    entry.assessment!.voiceDescriptors = { ...descriptors, tone: source.language === 'fr-FR' ? 'Calm' : source.voice === avaV3 ? 'Friendly' : 'Warm' };
  }
  const rows = voiceDescriptorRows(result);
  assert.deepEqual(rows.map(row => [row.model, row.locale, row.role, row.labels.tone]), [
    ['DragonHDLatestNeural', 'en-US', 'agent', 'Warm'],
    ['DragonHDLatestNeural', 'fr-FR', 'agent', 'Calm'],
    ['DragonHDLatestNeural', 'en-US', 'customer', null],
    ['DragonHDV3Neural', 'en-US', 'agent', 'Friendly'],
  ]);
  const html = renderToStaticMarkup(createElement(VoiceDescriptorReport, { job: result }));
  for (const heading of ['Voice', 'Requested role', 'Speaking style', 'Tone', 'Energy level', 'Speaking pace', 'Expressiveness', 'Perceived age group', 'Voice persona', 'Domain suitability'])
    assert.ok(html.includes(`<span>${heading}</span>`), heading);
  assert.doesNotMatch(html, /<span>(?:Model|Script locale)<\/span>|<td>(?:DragonHDLatestNeural|DragonHDV3Neural|fr-FR|en-US)<\/td>/);
  assert.doesNotMatch(html, /One best-fit label per category/);
  assert.match(html, /<td>agent<\/td><td>Conversational<\/td><td>Calm<\/td>/);
  assert.match(html, /<td>customer<\/td><td>Not assessable<\/td>/);
});
function arenaJob(voice: string, locale: string, date: string, value: number, domain = 'customer_services') {
  const result = job([clip({ voice })], [value, value]);
  result.arena = { locale, domain, scripts: [`${locale}_${domain}`] };
  result.createdAt = date;
  return result;
}

test('Arena Excel export preserves visible order, numeric scores, and exact source evidence', async () => {
  const first = arenaJob(avaV3, 'en-US', '2026-02-01', 4.25);
  first.collectVoiceDescriptors = true;
  first.results[0].assessment!.voiceDescriptors = descriptors;
  first.results[0].assessment!.reasons.naturalness = '=Saved listening comment';
  const hidden = arenaJob(avaV3, 'de-DE', '2026-02-02', 3);
  const cells = arenaData([first, hidden]).cells;
  const shown = cells.filter(cell => cell.locale === 'en-US');
  const config = { voices: ['Missing voice', avaV3], locales: ['en-US'], cells: shown };
  const book = arenaWorkbook(config, new Map([[first.id, first]]));
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await book.xlsx.writeBuffer());
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), [
    'Scorecard', 'Voice details', 'Dimension scores', 'Recording scores', 'Judge assessments', 'Judge evidence',
  ]);
  const scorecard = reopened.getWorksheet('Scorecard')!;
  assert.equal(scorecard.getCell('B1').value, 'en-US');
  assert.equal(scorecard.getCell('A2').value, 'Missing voice');
  assert.equal(scorecard.getCell('B2').value, null);
  assert.equal(scorecard.getCell('B3').value, shown[0].score);
  const details = reopened.getWorksheet('Voice details')!;
  assert.equal(details.getCell('D2').value, first.id);
  assert.equal(details.rowCount, 2);
  assert.ok(Object.values(details.getRow(2).values).includes('Conversational'));
  const assessments = reopened.getWorksheet('Judge assessments')!;
  assert.equal(assessments.getCell('M2').value, 4.25);
  assert.equal(assessments.getCell('N2').value, '=Saved listening comment');
  assert.throws(() => arenaWorkbook(config, new Map()), /Refresh the scorecard/);
});

test('script filenames require explicit domains and preserve dialects independently of voice locale', () => {
  assert.deepEqual(arenaScript('zh-CN_Customer_Services.txt'), {
    locale: 'zh-CN', domain: 'customer_services', scripts: ['zh-CN_Customer_Services'],
  });
  assert.equal(arenaScript('zh-Hant-TW_Narration.txt').locale, 'zh-Hant-TW');
  assert.equal(arenaScript('EN-us_Customer SERVICES.txt').domain, 'customer_services');
  for (const name of ['en-US.txt', 'Customer_Services.txt', 'en-US_.txt', 'en-US_../bad.txt'])
    assert.throws(() => arenaScript(name));
});

test('pasted script paths preserve quoted Windows paths, spaces and all seven languages', () => {
  const locales = ['zh-TW', 'en-US', 'fr-FR', 'vi-VN', 'yue-CN', 'zh-CN', 'zh-HK'];
  const paths = locales.map(locale => `C:\\Work Folder\\Scorecard\\Test scripts\\${locale}_Customer_Services.txt`);
  for (const newline of ['\r\n', '\n', '\r']) {
    const pasted = ` ${newline}${paths.map(value => `  "${value}"  `).join(newline)}${newline}`;
    assert.deepEqual(parseSortingPaths(pasted), paths);
  }
});

test('matrix keeps full model identity, separates domains/locales and takes latest complete per voice', () => {
  const old = arenaJob(avaLatest, 'en-US', '2026-01-01', 4.6);
  const latest = arenaJob(avaLatest, 'en-US', '2026-02-01', 4.8);
  const incomplete = arenaJob(avaLatest, 'en-US', '2026-03-01', 1);
  incomplete.results.pop();
  const running = arenaJob(avaLatest, 'en-US', '2026-04-01', 2);
  running.status = 'running';
  const otherModel = arenaJob(avaV3, 'en-US', '2026-01-01', 4.5);
  const french = arenaJob(avaLatest, 'fr-FR', '2026-01-01', 4.7);
  const domain = arenaJob(avaLatest, 'en-US', '2026-01-01', 3.2, 'narration');
  const ordinary = job();
  const data = arenaData([old, incomplete, otherModel, french, latest, domain, running, ordinary]);
  assert.equal(data.reports.length, 7);
  assert.equal(data.cells.length, 4);
  const cell = data.cells.find(cell => cell.voice === avaLatest && cell.locale === 'en-US' && cell.domain === 'customer_services')!;
  assert.ok(Math.abs(cell.score - 4.8) < 1e-9);
  assert.equal(cell.jobId, latest.id);
  assert.equal(cell.model, 'DragonHDLatestNeural');
  assert.equal(data.reports.find(report => report.id === incomplete.id)?.eligibleVoices, 0);
  assert.equal(data.cells.find(cell => cell.voice === avaV3)?.jobId, otherModel.id);
  const afterDeletingLatest = arenaData([old, incomplete, otherModel, french, domain, running, ordinary]);
  assert.equal(afterDeletingLatest.cells.find(item => item.voice === cell.voice && item.locale === cell.locale && item.domain === cell.domain)?.jobId, old.id);
});

test('matrix requires every file and judge for each voice but does not block other complete voices', () => {
  const first = clip({ voice: avaLatest, file: 'a.wav' });
  const second = clip({ voice: avaLatest, file: 'b.wav' });
  const other = clip({ voice: avaV3, file: 'c.wav' });
  const result = job([first, second, other], [4, 5]);
  result.arena = arenaScript('en-US_Customer_Services');
  result.results.find(item => item.clipId === second.id)!.assessment!.languageSupported = false;
  assert.deepEqual(arenaData([result]).cells.map(cell => cell.voice), [avaV3]);
  result.status = 'cancelled';
  assert.equal(arenaData([result]).cells.length, 0);
});

test('Arena imports voice/model folders, matches scripts, decodes Studio identities and detects changed files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-'));
  try {
    const scripts = path.join(root, 'scripts');
    const audio = path.join(root, 'audio');
    await file(scripts, 'en-US_Customer_Services.txt', 'Hello\nGoodbye');
    await file(scripts, 'zh-CN_Customer_Services.txt', '您好');
    const sourcePath = await file(audio, 'en-US-Ava%3ADragonHDLatestNeural/en-US_Customer_Services_L001.wav');
    await file(audio, 'en-US-Ava%3ADragonHDLatestNeural/nested/zh-CN_Customer_Services_L001.wav');
    await file(audio, 'en-US-Ava%3ADragonHDV3Neural/en-US_Customer_Services_L002.mp3');
    const importer = new ArenaImport();
    const preview = await importer.plan({ directory: `"${audio}"`, scriptsDirectory: scripts, layout: 'voices' });
    assert.equal(preview.tests.length, 2);
    const english = preview.tests.find(test => test.arena.locale === 'en-US')!;
    assert.deepEqual(english.files.map(source => source.voice), [avaLatest, avaV3]);
    const source = english.files[0];
    assert.equal((await importer.audio(preview.token, source.id)).toString(), 'audio');
    const clips = english.files.map(source => clip({ file: source.path, voice: source.voice }));
    assert.equal(importer.metadata({ token: preview.token, testName: english.name }, clips).domain, 'customer_services');
    assert.throws(() => importer.metadata({ token: preview.token, testName: english.name }, clips.slice(1)), /every file/);
    await writeFile(sourcePath, 'modified audio');
    await assert.rejects(importer.audio(preview.token, source.id), /changed after preview/);
    const next = await importer.plan({ directory: audio, scriptsDirectory: scripts, layout: 'voices' });
    await assert.rejects(importer.audio(preview.token, next.tests[0].files[0].id), /expired/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena supports Studio layout and tab-named clips, rejects ambiguity, missing scripts and links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-studio-'));
  try {
    const scripts = path.join(root, 'scripts');
    const audio = path.join(root, 'audio');
    await file(scripts, 'fr-FR_Narration.txt', 'custom_fr_narration\tBonjour');
    await file(audio, 'fr-FR Female/en-US-Ava%3ADragonHDLatestNeural/custom_fr_narration.wav');
    const importer = new ArenaImport();
    const input = { directory: audio, scriptsDirectory: scripts, layout: 'tests' };
    const preview = await importer.plan(input);
    assert.equal(preview.tests[0].arena.locale, 'fr-FR');
    assert.equal(preview.tests[0].files[0].voice, avaLatest);
    assert.equal((await importer.audio(preview.token, preview.tests[0].files[0].id)).toString(), 'audio');
    await file(scripts, 'fr-FR_Other.txt', 'custom_fr_narration\tSalut');
    await assert.rejects(importer.plan(input), /exactly one/);
    await rm(path.join(scripts, 'fr-FR_Other.txt'));
    await file(audio, 'fr-FR Female/en-US-Ava%3ADragonHDLatestNeural/unknown.wav');
    await assert.rejects(importer.plan(input), /exactly one/);
    await rm(path.join(audio, 'fr-FR Female', 'en-US-Ava%3ADragonHDLatestNeural', 'unknown.wav'));
    await symlink(path.join(audio, 'fr-FR Female'), path.join(audio, 'linked'), 'junction');
    await assert.rejects(importer.plan(input), /links or junctions/i);
    await assert.rejects(importer.plan({ ...input, directory: 'relative' }), /absolute/);
    await rm(path.join(audio, 'linked'));
    await rm(path.join(scripts, 'fr-FR_Narration.txt'));
    await assert.rejects(importer.plan(input), /containing.*scripts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena accepts more than 200 files and rejects script header/filename locale conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-limits-'));
  try {
    const scripts = path.join(root, 'scripts');
    const audio = path.join(root, 'audio');
    await file(scripts, 'en-US_Domain.txt', '---\nlocale: fr-FR\n---\nHello');
    await mkdir(audio);
    const importer = new ArenaImport();
    const input = { directory: audio, scriptsDirectory: scripts, layout: 'voices' };
    await assert.rejects(importer.plan(input), /header locale/);
    await file(scripts, 'en-US_Domain.txt', 'Hello');
    for (let index = 0; index < 201; index++) await file(audio, `Voice${index}/en-US_Domain_L001.wav`);
    const preview = await importer.plan(input);
    assert.equal(preview.tests.length, 1);
    assert.equal(preview.tests[0].files.length, 201);
    assert.deepEqual(preview.tests[0].errors, []);
    assert.throws(() => importer.metadata({ token: preview.token, testName: preview.tests[0].name }, []), /must match every file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena scorecard has Gender instead of panel and search, separate from the shared New test workspace', () => {
  const html = renderToStaticMarkup(createElement(VoiceArena, {
    active: false, busy: false, onDelete: () => {}, deletedIds: new Set<string>(),
    request: async () => { throw new Error('No requests during render'); },
    onOpen: () => {}, newTest: createElement('div', null, 'Shared evaluation workspace'),
  }));
  for (const label of ['Arena scorecard', 'Domain', 'Language / accent', 'Voice model', 'Gender'])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /aria-label="Arena test status"/);
  assert.doesNotMatch(html, /Judging panel|Search voices/);
  assert.match(html, /<div hidden=""><div class="page-title"><h1>New Arena test/);
  const evaluation = renderToStaticMarkup(createElement(EvaluationWorkbench, { arenaMode: true }));
  for (const label of ['Single evaluation', 'Batch evaluation', 'Drop a folder', 'Add to queue', 'Start evaluation', 'Test scripts directory', 'Copy Scoring panel'])
    assert.ok(evaluation.includes(label), label);
  assert.match(evaluation, /<label>Test scripts directory or file paths \(one per line\)<textarea rows="4"/);
  assert.match(evaluation, /Paste absolute \.txt file paths or a directory path, one per line/);
  assert.match(evaluation, /01 · Evaluation settings/);
  assert.doesNotMatch(evaluation, /class="sidebar"|class="topbar"|Arena matrix/);
  assert.match(evaluation, /arena-evaluation-readiness/);
  assert.doesNotMatch(evaluation, /Voice Selection|Who should be scored\?|Language \/ accent|Speaker selection|<strong>TTS evaluation<\/strong>|Judges probe accent fit/);
  const shell = renderToStaticMarkup(createElement(EvaluationWorkbench, {}));
  assert.match(shell, /aria-label="Voice Arena" aria-expanded="true"/);
  assert.match(shell, /aria-label="Voices Scoring" aria-expanded="false"/);
  assert.match(shell, /aria-current="page"><span>01<\/span> New test/);
  assert.match(shell, /<h1>New Arena test<\/h1>/);
});

test('Arena TTS rubric scores accent, pronunciation, naturalness and emotion/style for the script locale', () => {
  const profile = withLanguageAccent(newTestProfile({ stage: 'tts', scope: 'single', speakerMode: 'automatic', language: 'auto', target: '' }, ARENA_RUBRIC), 'zh-TW');
  assert.equal(profile.target, ARENA_TEST_GUIDE);
  assert.equal(profileSchema.safeParse(profile).success, true);
  for (const dimension of ['accentFit', 'articulation', 'naturalness', 'expressiveness'] as const)
    assert.ok(activeDimensions(profile).includes(dimension), dimension);
  assert.deepEqual(['articulation', 'expressiveness', 'accentFit'].map(d => dimensionLabel(profile, d as never)), ['Pronunciation accuracy', 'Emotion & speaking style', 'Accent fit']);
  const prompt = instructions(profile);
  for (const text of ['Voice Arena TTS rubric', 'lexical tones', 'zh-TW = Taiwan Mandarin', 'Emotion and speaking style'])
    assert.ok(prompt.includes(text), text);
  assert.match(prompt, /No reference script is provided/);
  for (const claim of [/skipped/i, /misread/i, /correct reading of numbers/i])
    assert.doesNotMatch(prompt, claim, `Audio-only judges cannot verify: ${claim}`);
  const saved = newTestProfile({ ...profile, target: '' });
  assert.equal(withArenaRubric(saved).rubric?.id, ARENA_RUBRIC.id);
  assert.equal(withArenaRubric(saved).target, ARENA_TEST_GUIDE);
  const custom = { ...saved, rubric: { ...saved.rubric!, name: 'My Arena rubric' } };
  assert.equal(withArenaRubric(custom), custom);
});

test('Arena detail report isolates the voice and locale and ranks saved dimensions and files lowest first', () => {
  const first = clip({ voice: avaLatest, file: 'weak.wav', start: 5, end: 15 });
  const second = clip({ voice: avaLatest, file: 'strong.wav', start: 0, end: 4 });
  const other = clip({ voice: avaV3, file: 'other-voice.wav' });
  const result = job([first, second, other], [4, 4]);
  result.arena = arenaScript('zh-TW_Customer_Services');
  result.profile = withLanguageAccent(newTestProfile({ stage: 'tts', scope: 'single', speakerMode: 'automatic', language: 'auto', target: '' }, ARENA_RUBRIC), 'zh-TW');
  for (const entry of result.results) {
    const a = entry.assessment!;
    a.speakerAttribution = { role: 'speaker', status: 'identified', evidence: 'One synthetic speaker.' };
    a.scores.accentFit = entry.clipId === first.id ? 1 : 4;
    a.scores.contextFit = 4;
    a.scores.audioQuality = 4;
    a.reasons.accentFit = entry.clipId === other.id ? 'OTHER VOICE EVIDENCE' : 'Regional vowel mismatch.';
    a.scores.articulation = 3;
    if (entry.clipId === first.id) a.rehearsalCases = [{
      dimension: 'accentFit', cue: 'First greeting', observation: 'Vowel mismatch reduces locale fit.',
      direction: 'Use the target regional vowel.', check: 'Native-like vowel on replay.',
    }];
  }
  const html = renderToStaticMarkup(createElement(ArenaVoiceReport, { job: result, voice: avaLatest, busy: false, onOpen: () => {} }));
  const cell = arenaData([result]).cells.find(item => item.voice === avaLatest)!;
  assert.ok(html.includes(`Overall preference: ${cell.score.toFixed(2)} / 5`));
  assert.match(html, /zh-TW|Regional vowel mismatch|First greeting|Source files: weak.wav/);
  assert.doesNotMatch(html, /OTHER VOICE EVIDENCE|other-voice.wav|DragonHDV3Neural/);
  assert.ok(html.indexOf('href="#arena-dimension-accentFit"') < html.indexOf('href="#arena-dimension-articulation"'));
  const recordings = html.slice(html.indexOf('aria-label="Recording breakdown"'));
  assert.ok(recordings.indexOf('weak.wav') < recordings.indexOf('strong.wav'));
  assert.match(recordings, /5\.0–15\.0s/);
  assert.match(recordings, new RegExp(`/api/clips/${first.id}/audio`));
  assert.match(html, /Open full test report|No precise defect timestamp|Judge 1|Judge 2/);
});

test('Arena detail report preserves missing ratings and exposes failed judges instead of inventing low scores', () => {
  const result = arenaJob(avaLatest, 'fr-FR', '2026-01-01', 4);
  result.results[0] = { ...result.results[0], status: 'failed', error: 'Audio connection failed.', assessment: undefined };
  const html = renderToStaticMarkup(createElement(ArenaVoiceReport, { job: result, voice: avaLatest, busy: false, onOpen: () => {} }));
  assert.match(html, /Incomplete coverage|Not assessed|Audio connection failed/);
  assert.doesNotMatch(html, /0\.00 \/ 5/);
  assert.match(html, /0\/1 fully assessed files/);
  const missing = renderToStaticMarkup(createElement(ArenaVoiceReport, { job: result, voice: avaV3, busy: false, onOpen: () => {} }));
  assert.match(missing, /role="alert"/);
  assert.doesNotMatch(missing, /Overall preference/);
});

test('Arena detail filters separate voice, model, locale and gender while preserving the exact saved identity', () => {
  const andrew = 'en-US-Andrew:DragonHDV3Neural';
  const old = arenaJob(avaLatest, 'en-US', '2026-01-01', 2);
  const latest = arenaJob(avaLatest, 'en-US', '2026-02-01', 4);
  const otherModel = arenaJob(avaV3, 'fr-FR', '2026-01-01', 3);
  const otherVoice = arenaJob(andrew, 'zh-TW', '2026-01-01', 5);
  const unsuffixed = arenaJob('en-US-JennyNeural', 'fr-FR', '2026-01-01', 3);
  const otherDomain = arenaJob(avaLatest, 'en-US', '2026-01-01', 1, 'narration');
  latest.voiceLabels = [{ voice: avaLatest, gender: 'Female' }];
  otherVoice.voiceLabels = [{ voice: andrew, gender: 'Male' }];
  otherDomain.voiceLabels = [{ voice: avaLatest, gender: 'Other' }];
  const cells = arenaData([old, latest, otherModel, otherVoice, unsuffixed, otherDomain]).cells;
  const domainCells = cells.filter(cell => cell.domain === 'customer_services');
  assert.deepEqual(arenaDetailOptions(domainCells), {
    voices: ['en-US-Andrew', 'en-US-Ava', 'en-US-JennyNeural'],
    models: ['DragonHDLatestNeural', 'DragonHDV3Neural', 'Neural'],
    locales: ['en-US', 'fr-FR', 'zh-TW'],
    genders: ['Female', 'Male', 'Unspecified'],
  });
  const latestCell = domainCells.find(cell => cell.jobId === latest.id)!;
  const selection = arenaDetailSelectionForCell(latestCell);
  assert.deepEqual(selection, { domain: 'customer_services', voice: 'en-US-Ava', model: 'DragonHDLatestNeural', locale: 'en-US', identity: avaLatest });
  assert.deepEqual(arenaDetailMatches(cells, selection).map(cell => cell.jobId), [latest.id]);
  assert.deepEqual(arenaDetailMatches(cells, { ...selection, model: 'DragonHDV3Neural', locale: 'fr-FR' }).map(cell => cell.voice), [avaV3]);
  assert.deepEqual(arenaDetailMatches(cells, { ...selection, model: 'DragonHDV3Neural', locale: 'en-US' }), []);
  assert.deepEqual(arenaDetailMatches(cells, { domain: selection.domain, voice: 'en-US-Ava', model: '', locale: '' }).map(cell => cell.jobId), [latest.id, otherModel.id]);
  assert.deepEqual(arenaDetailMatches(cells, { ...selection, gender: 'Female' }).map(cell => cell.jobId), [latest.id]);
  assert.deepEqual(arenaDetailMatches(cells, { ...selection, gender: 'Male' }), []);
  assert.deepEqual(arenaDetailMatches(cells, { ...selection, model: '', locale: '', gender: 'Unspecified' }).map(cell => cell.jobId), [otherModel.id]);
  assert.equal(arenaVoiceName('en-US-JennyNeural'), 'en-US-JennyNeural');
  assert.equal(arenaVoiceName(':custom'), ':custom');
  assert.equal(arenaVoiceName('en-US-Ava:custom:model'), 'en-US-Ava');
});

test('Arena compares distinct dimension scores for the latest eligible run of each script locale, voice and model', () => {
  const english = arenaJob(avaLatest, 'en-US', '2026-02-01', 4);
  const french = arenaJob(avaLatest, 'fr-FR', '2026-02-01', 3);
  const alternate = arenaJob(avaV3, 'en-US', '2026-02-01', 5);
  const newerIncomplete = arenaJob(avaLatest, 'en-US', '2026-03-01', 2);
  english.voiceLabels = [{ voice: avaLatest, gender: 'Female' }];
  newerIncomplete.results.pop();
  for (const [run, value] of [[english, 4.25], [french, 3.25], [alternate, 4.75]] as const) {
    for (const result of run.results) result.assessment!.scores.naturalness = value;
  }
  const cells = arenaData([english, french, alternate, newerIncomplete]).cells;
  assert.equal(cells.length, 3);
  const html = renderToStaticMarkup(createElement(ArenaDimensionComparison, { cells, busy: false, onInspect: () => {} }));
  assert.match(html, /<table aria-label="Full-panel scores out of 5">/);
  assert.doesNotMatch(html, /<caption\b/);
  for (const label of ['Voice', 'Model', 'Script locale', 'Gender', 'Overall preference', 'Naturalness'])
    assert.ok(html.includes(`<button class="table-sort-button" type="button"><span>${label}</span>`));
  assert.match(html, /aria-sort="descending" class="sortable-header"><button[^>]*><span>Overall preference<\/span>/);
  assert.deepEqual([...html.matchAll(/<td><strong>([\d.]+)<\/strong><\/td>/g)].map(match => Number(match[1])),
    [...cells].sort((a, b) => b.score - a.score).map(cell => Number(cell.score.toFixed(2))));
  for (const [run, gender, naturalness] of [[english, 'Female', '4.25'], [french, 'Unspecified', '3.25'], [alternate, 'Unspecified', '4.75']] as const) {
    const cell = cells.find(value => value.jobId === run.id)!;
    assert.ok(html.includes(`<tr><th scope="row" title="${cell.voice}">en-US-Ava</th><td>${cell.model}</td><td>${cell.locale}</td>` +
      `<td>${gender}</td><td><strong>${cell.score.toFixed(2)}</strong></td><td title="Naturalness">${naturalness}</td>`));
  }
  assert.match(html, /Not assessed/);
  assert.doesNotMatch(html, /Unavailable/);
  const legacy = renderToStaticMarkup(createElement(ArenaDimensionComparison, {
    cells: [{ ...cells[0], dimensionScores: undefined }], busy: false, onInspect: () => {},
  }));
  assert.match(legacy, /Some dimension scores are unavailable.*<td>Unavailable<\/td>/);
  assert.ok(legacy.includes(`<td><strong>${cells[0].score.toFixed(2)}</strong></td><td>Unavailable</td>`));
});

test('Arena detail filters detect ambiguous full voice identities instead of merging reports', () => {
  const withoutSuffix = arenaJob('en-US-Ava', 'en-US', '2026-01-01', 3);
  const explicitModel = arenaJob('en-US-Ava:Unspecified', 'en-US', '2026-01-01', 4);
  const cells = arenaData([withoutSuffix, explicitModel]).cells;
  const selection = arenaDetailSelectionForCell(cells.find(cell => cell.jobId === explicitModel.id)!);
  const matches = arenaDetailMatches(cells, selection);
  assert.equal(matches.length, 2);
  assert.deepEqual(new Set(matches.map(cell => cell.voice)), new Set(['en-US-Ava', 'en-US-Ava:Unspecified']));
  assert.equal(matches.find(cell => cell.voice === selection.identity)?.jobId, explicitModel.id);
});

test('Arena and Scoring history stay separate even with the currently running legacy server', async () => {
  const arena = arenaJob(avaLatest, 'en-US', '2026-01-01', 4);
  arena.name = 'Arena queued test'; arena.status = 'queued';
  const scoring = job(); scoring.name = 'Scoring completed test';
  const histories = [testHistory(arena), testHistory(scoring)];
  assert.deepEqual(histories.map(entry => entry.workspace), ['arena', 'scoring']);
  const legacy = histories.map(entry => { const copy = { ...entry }; delete copy.workspace; return copy; });
  let lookups = 0;
  const load = createHistoryLoader(async () => legacy, async () => {
    throw new Error('Already-complete history must not download full jobs.');
  }, async () => { lookups++; return [arena.id]; });
  const resolved = await load();
  assert.deepEqual(workspaceHistory(resolved, 'arena').map(entry => entry.id), [arena.id]);
  assert.deepEqual(workspaceHistory(resolved, 'scoring').map(entry => entry.id), [scoring.id]);
  assert.deepEqual(workspaceHistory(legacy, 'scoring'), [], 'Unclassified history must not leak into Scoring.');
  assert.equal(lookups, 1);
  await load();
  assert.equal(lookups, 1, 'Unchanged legacy history should not rescan all Arena reports on every poll.');
  legacy.push({ ...legacy[1], id: 'new-scoring-job', name: 'New Scoring test' });
  assert.deepEqual(workspaceHistory(await load(), 'scoring').map(entry => entry.id), [scoring.id, 'new-scoring-job']);
  assert.equal(lookups, 2, 'A newly saved job triggers a fresh workspace classification.');
  await load(undefined, true);
  assert.equal(lookups, 3, 'Explicit refresh rechecks legacy classifications.');
  const modern = createHistoryLoader(async () => histories, async () => { throw new Error('Unexpected job download.'); },
    async () => { throw new Error('Modern workspace metadata must not need a fallback.'); });
  assert.deepEqual((await modern()).map(entry => entry.workspace), ['arena', 'scoring']);
  let failures = 0;
  const broken = createHistoryLoader(async () => legacy, async () => scoring,
    async () => { failures++; throw new Error('Arena classification failed.'); });
  await assert.rejects(broken(), /Arena classification failed/);
  await assert.rejects(broken(), /Arena classification failed/);
  assert.equal(failures, 2, 'Failed classification must be retried, not cached as Scoring.');
  const controller = new AbortController();
  let abortedLookups = 0;
  const aborted = createHistoryLoader(async () => legacy, async () => scoring, async () => {
    if (++abortedLookups === 1) controller.abort(new Error('Classification aborted.'));
    return [arena.id];
  });
  await assert.rejects(aborted(controller.signal), /Classification aborted/);
  assert.deepEqual(workspaceHistory(await aborted(), 'arena').map(entry => entry.id), [arena.id]);
  assert.equal(abortedLookups, 2, 'An aborted fallback must not cache incomplete classification.');
});

test('Arena detailed reports groups comparison view with its filters below test status', () => {
  const html = renderToStaticMarkup(createElement(VoiceArena, {
    active: true, page: 'details', request: async <T,>() => ({ cells: [], reports: [] } as T),
    busy: false, onOpen: () => {}, onDelete: () => {}, deletedIds: new Set<string>(),
  }));
  for (const text of ['Arena detailed reports', 'Report domain', 'Loading voice breakdowns'])
    assert.ok(html.includes(text), text);
  const filters = html.slice(html.indexOf('aria-label="Detailed report selection"'), html.indexOf('</section>', html.indexOf('aria-label="Detailed report selection"')));
  assert.match(filters, /class="field-row filter-bar"/);
  for (const label of ['Report domain', 'Voice', 'Model', 'Script locale', 'Gender'])
    assert.match(filters, new RegExp(`class="multi-filter"><span[^>]*>${label}</span>`));
  assert.equal((filters.match(/<select/g) ?? []).length, 1);
  assert.match(filters, /<option value="scores" selected="">Scores<\/option><option value="descriptors">Voice descriptors<\/option>/);
  assert.doesNotMatch(filters, /Voice \/ model|Report locale|Compare the latest fully assessed result/);
  assert.match(html, /<div hidden=""><div class="page-title"><h1>Arena scorecard/);
  assert.match(html, /<h1>Arena detailed reports<\/h1>.*<h2>Arena test status<\/h2>.*<h2>Voice and locale breakdown<\/h2>/);
});

test('Arena combines selected values without merging scorecards or breakdown rows across domains', () => {
  const jobs = [
    arenaJob(avaLatest, 'en-US', '2026-02-01', 4.25),
    arenaJob(avaLatest, 'en-US', '2026-02-01', 3.75, 'narration'),
    arenaJob(avaLatest, 'de-DE', '2026-02-01', 4.5, 'narration'),
    arenaJob(avaLatest, 'fr-FR', '2026-02-01', 3, 'narration'),
  ];
  const cells = arenaDetailMatches(arenaData(jobs).cells, {
    domain: ['customer_services', 'narration'], voice: [], model: [], locale: ['en-US', 'de-DE'],
  });
  assert.deepEqual(new Set(cells.map(cell => cell.jobId)), new Set(jobs.slice(0, 3).map(job => job.id)));
  const comparison = renderToStaticMarkup(createElement(ArenaDimensionComparison, { cells, busy: false, onInspect: () => {} }));
  assert.match(comparison, /<span>Domain<\/span>/);
  for (const [domain, expected, other] of [['customer_services', '4.25', '3.75'], ['narration', '3.75', '4.25']]) {
    const matrix = renderToStaticMarkup(createElement(ArenaScoreMatrix, {
      domain, cells: cells.filter(cell => cell.domain === domain), locales: ['en-US'],
      load: async () => jobs[0], busy: false, onInspect: () => {},
    }));
    assert.ok(matrix.includes(`${expected} out of 5`));
    assert.ok(!matrix.includes(`${other} out of 5`));
  }
});

test('Arena comparison uses the parent-selected view without a separate filter control', () => {
  const result = arenaJob(avaLatest, 'en-US', '2026-02-01', 4.6);
  const cells = arenaData([result]).cells.map(cell => ({ ...cell, voiceDescriptors: { ...descriptors, tone: null } }));
  const props = { cells, busy: false, onInspect: () => {} };
  const scores = renderToStaticMarkup(createElement(ArenaDimensionComparison, { ...props, view: 'scores' }));
  const labels = renderToStaticMarkup(createElement(ArenaDimensionComparison, { ...props, view: 'descriptors' }));
  assert.match(scores, /aria-label="Full-panel scores out of 5"/);
  assert.match(labels, /aria-label="Top voice descriptors"/);
  assert.match(scores, /Export to Excel/);
  assert.match(labels, /Export to Excel/);
  assert.match(labels, /<td>Conversational<\/td><td>Not assessable<\/td>/);
  assert.doesNotMatch(labels, /Overall preference|<select/);
  assert.doesNotMatch(scores, /<select/);
  const legacy = renderToStaticMarkup(createElement(ArenaDimensionComparison, {
    ...props, cells: arenaData([result]).cells, view: 'descriptors',
  }));
  assert.equal((legacy.match(/<td>Not collected<\/td>/g) ?? []).length, voiceDescriptorKeys.length);
});

test('Arena comparison Excel exports the selected view and preserves row order and cell types', async () => {
  const first = arenaJob(avaV3, 'en-US', '2026-02-01', 4.25);
  const second = arenaJob(avaLatest, 'de-DE', '2026-02-02', 3.75);
  const cells = arenaData([first, second]).cells;
  const firstCell = cells.find(cell => cell.jobId === first.id)!;
  const secondCell = cells.find(cell => cell.jobId === second.id)!;
  const rows = [
    { ...firstCell, voiceDescriptors: { ...descriptors, tone: null } },
    { ...secondCell, dimensionScores: undefined },
  ];
  for (const view of ['scores', 'descriptors'] as const) {
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(await arenaComparisonWorkbook(rows, view).xlsx.writeBuffer());
    assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), [view === 'scores' ? 'Scores' : 'Voice descriptors']);
    const sheet = reopened.worksheets[0];
    assert.equal(sheet.rowCount, 3);
    assert.equal(sheet.getCell('A2').value, arenaVoiceName(firstCell.voice));
    assert.equal(sheet.getCell('C2').value, 'en-US');
    assert.equal(sheet.getCell('C3').value, 'de-DE');
    if (view === 'scores') {
      assert.equal(sheet.getCell('E2').value, firstCell.score);
      assert.equal(sheet.getCell('F2').value, firstCell.dimensionScores?.find(item => item.dimension === 'naturalness')?.score);
      assert.equal(sheet.getCell('F3').value, null);
    } else {
      assert.equal(sheet.getCell('E2').value, 'Conversational');
      assert.equal(sheet.getCell('F2').value, 'Not assessable');
      assert.equal(sheet.getCell('E3').value, 'Not collected');
    }
  }
});

test('Arena test status uses live FIFO order, retains finished reports, and excludes Scoring jobs', () => {
  const saved = (name: string, domain: string, status: Job['status']) => ({
    ...arenaJob(avaLatest, 'en-US', '2026-01-01', 4, domain), name, status,
  });
  const done = saved('Done report', 'narration', 'completed');
  const interrupted = saved('Interrupted report', 'service', 'interrupted');
  const running = saved('Running report', 'service', 'queued');
  const first = saved('First waiting', 'narration', 'queued');
  const second = saved('Second waiting', 'service', 'queued');
  const stale = saved('Stale running', 'service', 'running');
  const entry = (run: Job) => ({ id: run.id, name: run.name! });
  const state = queueForWorkspace({
    paused: true, active: { ...entry(running), workspace: 'arena', retry: true, autoRetryCount: 2 },
    waiting: [
      { id: 'scoring', name: 'Scoring only', workspace: 'scoring' },
      entry(first), { ...entry(second), workspace: 'arena' },
    ],
  }, [testHistory(first)], 'arena').state;
  const html = renderToStaticMarkup(createElement(ArenaTestStatus, {
    reports: arenaData([done, interrupted, second, first, running, stale]).reports,
    reportsLoaded: true, queue: state, busy: false, onOpen: () => {}, onDelete: () => {},
  }));
  const rows = [...html.matchAll(/<tr><td class="arena-report-select">.*?<\/td><th scope="row">([^<]+)<\/th>(.*?)<\/tr>/g)];
  assert.deepEqual(rows.slice(0, 3).map(row => row[1]), ['Running report', 'First waiting', 'Second waiting']);
  assert.equal(rows.length, 6);
  assert.match(rows[0][2], /Running.*Automatic retry 2/);
  assert.match(rows[1][2], /Queued.*Arena queue #1/);
  assert.match(rows[1][2], /en-US_narration\.txt/);
  assert.match(rows[2][2], /Queued.*Arena queue #2/);
  assert.match(html, /1 running · 2 queued · Shared queue paused · 1 completed/);
  assert.match(rows.find(row => row[1] === 'Done report')![2], /Completed.*Open report/);
  assert.match(rows.find(row => row[1] === 'Interrupted report')![2], /Interrupted/);
  assert.match(rows.find(row => row[1] === 'Stale running')![2], /Updating status/);
  for (const name of ['Running report', 'First waiting', 'Second waiting', 'Stale running'])
    assert.match(html, new RegExp(`aria-label="Select Arena report ${name}"[^>]*disabled=""`));
  for (const name of ['Done report', 'Interrupted report'])
    assert.doesNotMatch(html, new RegExp(`aria-label="Select Arena report ${name}"[^>]*disabled=""`));
  assert.match(html, /disabled="">Delete selected<\/button>/);
  assert.doesNotMatch(html, /Scoring only/);
});

test('Arena activity shows concurrent judges for the current file, not pending or stale work', () => {
  const active = job([
    clip({ voice: avaV3, file: 'active.wav', start: 1, end: 4 }),
    clip({ voice: 'Waiting Voice', file: 'later.wav' }),
  ], [4, 4, 3]);
  active.status = 'running';
  active.arena = arenaScript('fr-FR_Customer_Services.txt');
  active.results[1].status = 'running';
  active.results[2].status = 'running';
  for (const result of active.results.slice(3)) result.status = 'pending';
  const props = {
    reports: [], reportsLoaded: true, busy: false, onOpen: () => {}, onDelete: () => {},
    queue: { paused: false, active: { id: active.id, name: 'French service test' }, waiting: [] },
  };
  const render = (activity?: { job?: Job; error?: string }) =>
    renderToStaticMarkup(createElement(ArenaTestStatus, { ...props, activity }));
  const live = render({ job: active });
  assert.match(live, /Running now: French service test/);
  assert.match(live, /fr-FR_Customer_Services\.txt.*Script locale: fr-FR/);
  assert.match(live, /1 \/ 6 judge assessments completed.*2 in progress · 3 pending/);
  assert.doesNotMatch(live, /Entire batch:/, 'Older servers do not provide estimates.');
  const renderEta = (paused: boolean, eta: NonNullable<TestQueueState['eta']>) =>
    renderToStaticMarkup(createElement(ArenaTestStatus, { ...props, activity: { job: active },
      queue: { ...props.queue, paused, eta } }));
  assert.match(renderEta(false, { currentMinutes: 12, batchMinutes: 90 }),
    /Current locale: ~12 min left · Entire batch: ~90 min left · At the recent pace; excludes future retries\./);
  assert.match(renderEta(false, {}), /Current locale: estimating… · Entire batch: estimating…/);
  assert.match(renderEta(true, { currentMinutes: 12 }), /Current locale: ~12 min left · Entire batch: queue paused/);
  assert.ok(live.includes(avaV3));
  assert.match(live, /active\.wav.*1\.00–4\.00 s.*Judge 2.*deployment-1.*Judge 3.*deployment-2/);
  assert.doesNotMatch(live, /later\.wav|Judge 1/);
  assert.doesNotMatch(render({ job: { ...active, id: 'previous-test' } }), /active\.wav/);
  assert.doesNotMatch(render({ job: { ...active, arena: undefined } }), /active\.wav/);
  assert.match(render({ job: { ...active, status: 'completed' } }), /Updating queue status/);
  assert.match(render({ error: 'Request timed out' }), /Live activity refresh failed: Request timed out/);
  active.results[1].status = 'completed';
  active.results[2].status = 'failed';
  assert.match(render({ job: active }), /1 failed or stopped.*No judge is in progress right now/);
});

test('TTS issue summaries rank low dimensions per voice and exclude incomplete-file evidence', () => {
  const first = clip({ voice: avaLatest, file: 'first.wav' });
  const second = clip({ voice: avaLatest, file: 'second.wav' });
  const incomplete = clip({ voice: avaLatest, file: 'incomplete.wav' });
  const strong = clip({ voice: avaV3, file: 'strong.wav' });
  const saved = job([first, second, incomplete, strong], [4, 4]);
  saved.profile = { ...saved.profile, stage: 'tts' };
  saved.arena = arenaScript('id-ID_Customer_Services.txt');
  for (const result of saved.results) {
    result.assessment!.scores.audioQuality = 4;
    if (result.clipId === strong.id) continue;
    if (result.clipId === incomplete.id && result.judgeId === saved.judges[0].id) {
      result.status = 'pending';
      delete result.assessment;
      continue;
    }
    const assessment = result.assessment!;
    assessment.scores.expressiveness = result.clipId === incomplete.id ? 1 : 2;
    assessment.scores.naturalness = 3;
    assessment.reasons.expressiveness = result.clipId === incomplete.id ? 'Excluded observation.' : 'Flat pitch.';
    if (result.clipId === first.id) assessment.rehearsalCases = [{
      dimension: 'expressiveness', cue: 'During the greeting', observation: 'Little variation in the greeting.',
      direction: 'Re-record the greeting.', check: 'Check the pitch.',
    }];
  }
  const voices = summarizeTtsIssues(saved);
  assert.deepEqual(voices[0].issues.map(issue => [issue.dimension, issue.score]), [['expressiveness', 2], ['naturalness', 3]]);
  assert.deepEqual(voices[0].issues[0].examples.map(example => example.file), ['first.wav', 'second.wav']);
  const html = renderToStaticMarkup(createElement(TtsIssueSummary, { voices }));
  assert.match(html, /Domain: customer_services.*Script locale: id-ID.*2\/3 fully assessed audio files/);
  assert.match(html, /Little variation in the greeting\..*Cue: During the greeting/);
  assert.match(html, /No assessed dimension below 4\/5/);
  assert.doesNotMatch(html, /Excluded observation|Re-record|next.take/);
});

test('Arena gender uses explicit voice labels, falls back to test name, and never guesses from voice identity', () => {
  const result = arenaJob(avaLatest, 'en-US', '2026-01-01', 4);
  assert.equal(arenaData([result]).cells[0].gender, 'Unspecified');
  result.name = 'en-US Female Customer Services';
  assert.equal(arenaData([result]).cells[0].gender, 'Female');
  result.voiceLabels = [{ voice: avaLatest, gender: 'Other' }];
  assert.equal(arenaData([result]).cells[0].gender, 'Other');
  delete result.voiceLabels;
  result.name = 'en-US Female Male comparison';
  assert.equal(arenaData([result]).cells[0].gender, 'Unspecified');
});

test('Arena upload preview validates selected files against required scripts and restricts single tests to one domain/locale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-upload-'));
  try {
    await file(root, 'en-US_Customer_Services.txt', 'Hello');
    await file(root, 'fr-FR_Customer_Services.txt', 'Bonjour');
    const importer = new ArenaImport();
    const source = { id: randomUUID(), path: 'collection/Voice/en-US_Customer_Services_L001.wav', voice: avaLatest, size: 48000 };
    const preview = await importer.planUploads({ scriptsDirectory: root, files: [source] });
    assert.equal(preview.tests[0].arena.locale, 'en-US');
    assert.equal(importer.metadata({ token: preview.token, testName: preview.tests[0].name }, [clip({ file: source.path, voice: avaLatest })]).domain, 'customer_services');
    await assert.rejects(importer.planUploads({ scriptsDirectory: root, files: [source, {
      ...source, id: randomUUID(), path: 'collection/Voice/fr-FR_Customer_Services_L001.wav',
    }] }), /Single evaluation requires one/);
    await assert.rejects(importer.planUploads({ scriptsDirectory: root, files: [{ ...source, path: 'unknown.wav' }] }), /exactly one/);
    await assert.rejects(importer.planUploads({ scriptsDirectory: root, files: [] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena matches selected script paths from multiple directories in single and batch previews', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-script-paths-'));
  try {
    const locales = ['zh-TW', 'en-US', 'fr-FR', 'vi-VN', 'yue-CN', 'zh-CN', 'zh-HK'];
    const audio = path.join(root, 'audio');
    const scripts: string[] = [];
    for (const [index, locale] of locales.entries()) {
      scripts.push(await file(root, `${index < 3 ? 'First scripts' : 'More scripts'}/${locale}_Customer_Services.txt`, 'Hello'));
      await file(audio, `Test/en-US-Ava%3ADragonHDLatestNeural/${locale}_Customer_Services_L001.wav`);
    }
    await file(root, 'First scripts/notes.txt', 'This file was not selected');
    const scriptPaths = parseSortingPaths(scripts.map(value => `"${value}"`).join('\r\n'));
    const importer = new ArenaImport();
    const first = { id: randomUUID(), path: `${locales[0]}_Customer_Services_L001.wav`, voice: avaLatest, size: 48000 };
    const single = await importer.planUploads({ scriptPaths, files: [first] });
    assert.equal(single.tests[0].arena.locale, 'zh-TW');
    assert.equal(single.tests[0].arena.domain, 'customer_services');
    await assert.rejects(importer.planUploads({ scriptPaths, files: [first, {
      ...first, id: randomUUID(), path: 'en-US_Customer_Services_L001.wav',
    }] }), /Single evaluation requires one/);
    await assert.rejects(importer.planUploads({ scriptPaths: [scripts[0]], files: [{
      ...first, path: 'en-US_Customer_Services_L001.wav',
    }] }), /exactly one/);
    const batch = await importer.plan({
      directory: audio, scriptPaths: scripts.map(value => `"${value}"`), layout: 'tests',
    });
    assert.deepEqual(batch.tests.map(value => value.arena.locale).sort(), [...locales].sort());
    assert.ok(batch.tests.every(value => value.arena.domain === 'customer_services' && value.files.length === 1));
    assert.equal((await importer.audio(batch.token, batch.tests[0].files[0].id)).toString(), 'audio');
    const listedBatch = await importer.plan({ directories: [path.join(audio, 'Test')], scriptPaths, layout: 'tests' });
    assert.deepEqual(listedBatch.tests.map(value => value.arena.locale).sort(), [...locales].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena script sources deduplicate paths and reject invalid or ambiguous inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-script-validation-'));
  try {
    const directory = path.join(root, 'scripts');
    const english = await file(directory, 'en-US_Customer_Services.txt', 'Hello');
    const french = await file(directory, 'fr-FR_Customer_Services.txt', 'Bonjour');
    const nonScript = await file(root, 'not-a-script.md', 'Not a script');
    const importer = new ArenaImport();
    const source = { id: randomUUID(), path: 'en-US_Customer_Services_L001.wav', voice: avaLatest, size: 48000 };
    const preview = await importer.planUploads({ scriptPaths: [`"${directory}"`, english, `"${english}"`, french], files: [source] });
    assert.equal(preview.tests[0].arena.locale, 'en-US');
    await assert.rejects(importer.planUploads({ scriptPaths: ['relative\\script.txt'], files: [source] }), /absolute test script/);
    await assert.rejects(importer.planUploads({ scriptPaths: [path.join(root, 'missing.txt')], files: [source] }), /Test script path does not exist/);
    await assert.rejects(importer.planUploads({ scriptPaths: [nonScript], files: [source] }), /Choose a \.txt/);
    await assert.rejects(importer.planUploads({ scriptPaths: [path.parse(root).root], files: [source] }), /not a drive root/);
    const linked = path.join(root, 'linked-scripts');
    await symlink(directory, linked, 'junction');
    await assert.rejects(importer.planUploads({ scriptPaths: [path.join(linked, path.basename(english))], files: [source] }), /links or junctions/i);
    const duplicate = await file(root, 'other/en-US_Customer_Services.txt', 'Different script');
    await assert.rejects(importer.planUploads({ scriptPaths: [english, duplicate], files: [source] }), /Duplicate script name/);
    assert.equal(arenaUploadSchema.safeParse({ scriptPaths: [], files: [source] }).success, false);
    assert.equal(arenaUploadSchema.safeParse({ scriptPaths: ['""'], files: [source] }).success, false);
    assert.equal(arenaUploadSchema.safeParse({ scriptPaths: [english], scriptsDirectory: directory, files: [source] }).success, false);
    assert.equal(arenaImportSchema.safeParse({ directory: root, scriptPaths: [english], layout: 'voices', extra: true }).success, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena batch folder lists retain gender per voice while grouping a shared language/domain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-genders-'));
  try {
    const scripts = path.join(root, 'scripts');
    await file(scripts, 'en-US_Customer_Services.txt', 'Hello');
    const female = path.join(root, 'en-US Female');
    const male = path.join(root, 'en-US Male');
    await file(female, 'en-US-Ava%3ADragonHDLatestNeural/en-US_Customer_Services_L001.wav');
    await file(male, 'en-US-Andrew%3ADragonHDLatestNeural/en-US_Customer_Services_L001.wav');
    const importer = new ArenaImport();
    const preview = await importer.plan({ directories: [female, male], scriptsDirectory: scripts, layout: 'tests' });
    assert.equal(preview.tests.length, 1);
    assert.deepEqual(preview.tests[0].voiceLabels, [
      { voice: avaLatest, gender: 'Female' }, { voice: 'en-US-Andrew:DragonHDLatestNeural', gender: 'Male' },
    ]);
    assert.deepEqual(importer.labels({ token: preview.token, testName: preview.tests[0].name }), preview.tests[0].voiceLabels);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Arena and Scoring queue 201 files each as single reports that survive server recreation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-arena-api-'));
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = {
    dataDir: path.join(root, 'data'), port: address.port,
    endpoint: 'https://example.openai.azure.com', key: 'test-only',
    evaluate: async ({ collectVoiceDescriptors }: Parameters<typeof import('../server/realtime.js').judgeAudio>[0]) => {
      const result = assessment(4.6);
      result.scores.contextFit = 4.6; result.scores.accentFit = 4.6; result.scores.audioQuality = 4.6;
      result.speakerAttribution = { role: 'speaker' as const, status: 'identified' as const, evidence: 'One speaker.' };
      if (collectVoiceDescriptors) result.voiceDescriptors = descriptors;
      return { assessment: result };
    },
  };
  let backend = await createApp(options);
  backend.app.use(backend.errors); server.on('request', backend.app);
  const url = `http://127.0.0.1:${address.port}`;
  const call = async <T,>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
    const response = await fetch(url + route, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<T>;
  };
  try {
    const scriptsDirectory = path.join(root, 'scripts');
    const directory = path.join(root, 'audio');
    const count = 201;
    const script = await file(scriptsDirectory, 'en-US_Customer_Services.txt', Array.from({ length: count }, (_, i) => `Line ${i + 1}`).join('\n'));
    for (let i = 1; i <= count; i++)
      await file(directory, `en-US-Ava%3ADragonHDLatestNeural/en-US_Customer_Services_L${String(i).padStart(3, '0')}.wav`);
    const panel = [{ id: randomUUID(), name: 'Arena only', deployment: 'arena-deployment' }];
    const profile = newTestProfile({ stage: 'tts', scope: 'single', speakerMode: 'automatic', target: '', language: 'auto' });
    await call('/api/arena/settings', { judges: panel, profile }, 'PUT');
    const scoring = await call<{ judges: typeof panel }>('/api/config');
    assert.notEqual(scoring.judges[0].deployment, panel[0].deployment);
    await call('/api/queue/pause', {});
    const missingScript = await fetch(url + '/api/arena/uploads/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptPaths: [path.join(root, 'missing.txt')],
        files: [{ id: randomUUID(), path: 'en-US_Customer_Services_L001.wav', voice: avaLatest, size: 1 }],
      }),
    });
    assert.equal(missingScript.status, 400);
    assert.match(((await missingScript.json()) as { error: string }).error, /Test script path does not exist/);
    const legacyPreview = await call<ArenaPreview>('/api/arena/preview', { directory, scriptsDirectory, layout: 'voices' });
    const batchPreview = await call<ArenaPreview>('/api/arena/preview', { directory, scriptPaths: [`"${script}"`], layout: 'voices' });
    assert.deepEqual(batchPreview.tests[0].arena, legacyPreview.tests[0].arena);
    const preview = await call<ArenaPreview>('/api/arena/uploads/preview', { scriptPaths: [`"${script}"`], files: batchPreview.tests[0].files });
    const test = preview.tests[0];
    assert.equal(test.files.length, count);
    const clipIds: string[] = [];
    for (const source of test.files) {
      const id = randomUUID();
      await call('/api/clips', {
        clip: { id, file: source.path, voice: source.voice, language: 'en-US', role: 'speaker', start: 0, end: 1, channel: 'mix' },
        pcm: Buffer.alloc(48000).toString('base64'),
      });
      clipIds.push(id);
    }
    const input = {
      name: 'en-US Female Customer Services', profile: batchTestProfile(profile, test.name), judges: panel, clipIds,
      consent: true, enqueue: true, autoRetry: false, arena: { token: preview.token, testName: test.name },
    };
    const invalid = await fetch(url + '/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, profile: { ...input.profile, language: 'fr-FR' } }),
    });
    assert.equal(invalid.status, 400);
    const saved = await call<Job>('/api/jobs', input);
    const scoringJob = await call<Job>('/api/jobs', { ...input, arena: undefined, name: 'Large scoring test',
      clipOverrides: clipIds.map(id => ({ id, voice: 'Scoring voice', language: 'en-US' })) });
    assert.deepEqual(saved.arena, test.arena);
    assert.equal(saved.collectVoiceDescriptors, true);
    const savedHistory = await call<TestHistory[]>('/api/jobs');
    assert.equal(savedHistory.find(entry => entry.id === saved.id)?.workspace, 'arena');
    const queued = await call<TestQueueState>('/api/queue');
    assert.deepEqual(queued.waiting.map(entry => entry.id), [saved.id, scoringJob.id]);
    assert.equal(queued.waiting.find(entry => entry.id === saved.id)?.workspace, 'arena');
    await call('/api/queue/start', { consent: true });
    for (let attempt = 0; attempt < 1000; attempt++) {
      const queue = await call<TestQueueState>('/api/queue');
      if (!queue.active && !queue.waiting.length) break;
      if (attempt === 999) assert.fail('Evaluation queue did not finish.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const data = await call<ArenaData>('/api/arena');
    assert.equal(data.cells.length, 1);
    assert.ok(Math.abs(data.cells[0].score - 4.6) < 1e-9);
    assert.equal(data.cells[0].gender, 'Female');
    assert.deepEqual(data.cells[0].voiceDescriptors, descriptors);
    assert.equal(data.reports[0].status, 'completed');
    const report = await call<Job>(`/api/jobs/${saved.id}`);
    const scoringReport = await call<Job>(`/api/jobs/${scoringJob.id}`);
    for (const completed of [report, scoringReport]) {
      assert.equal(completed.status, 'completed');
      assert.deepEqual(completed.clips.map(clip => clip.id), clipIds);
      assert.deepEqual(completed.results.map(result => result.clipId), clipIds);
      assert.ok(completed.results.every(result => result.status === 'completed'));
    }
    assert.ok(scoringReport.clips.every(clip => clip.voice === 'Scoring voice'));
    assert.deepEqual(report.arena, test.arena);
    assert.deepEqual(report.results[0].assessment?.voiceDescriptors, descriptors);
    server.removeListener('request', backend.app);
    backend = await createApp(options);
    backend.app.use(backend.errors); server.on('request', backend.app);
    assert.deepEqual(await call<ArenaData>('/api/arena'), data);
    const settings = await call<{ judges: typeof panel }>('/api/arena/settings');
    assert.deepEqual(settings.judges, panel);
    await call('/api/queue/pause', {});
    await call('/api/jobs/bulk', { action: 'redo', ids: [saved.id], consent: true });
    const jobs = await backend.store.jobs();
    assert.equal(jobs.length, 3);
    const redo = jobs.find(job => job.id !== saved.id && job.id !== scoringJob.id);
    assert.deepEqual(redo?.arena, saved.arena);
    assert.equal(redo?.clips.length, count);
    assert.equal((await call<TestQueueState>('/api/queue')).waiting[0].workspace, 'arena');
    assert.equal((await call<ArenaData>('/api/arena')).cells[0].jobId, saved.id);
  } finally {
    backend.cancelActive();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
