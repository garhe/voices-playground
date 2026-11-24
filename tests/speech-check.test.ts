import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { compareSpeechText, speechCheck } from '../server/speechCheck.js';
import { ARENA_RUBRIC, type Job } from '../shared/domain.js';
import type { ArenaPreview } from '../shared/arena.js';
import { batchTestProfile } from '../src/batch.js';
import { newTestProfile, withArenaRubric } from '../src/readiness.js';
import { SpeechCheckSummary } from '../src/SpeechCheckSummary.js';
import { assessment } from './fixtures.js';

const credentials = { region: 'eastus2', endpoint: '', key: 'test-key' };

test('Speech text comparison reports possible missing, added and substituted words without a transcript', () => {
  const expected = '[calm] Hello there. Please sit down.';
  assert.deepEqual(compareSpeechText(expected, 'Hello there please sit down', 'en-US'), {
    status: 'compared', missing: 0, added: 0, substituted: 0, firstReferenceWord: null,
  });
  assert.deepEqual(compareSpeechText(expected, 'Hello there please sit', 'en-US'), {
    status: 'compared', missing: 1, added: 0, substituted: 0, firstReferenceWord: 5,
  });
  assert.deepEqual(compareSpeechText(expected, 'Hello there please sit down today', 'en-US'), {
    status: 'compared', missing: 0, added: 1, substituted: 0, firstReferenceWord: 5,
  });
  assert.deepEqual(compareSpeechText(expected, 'Hello there please stand down', 'en-US'), {
    status: 'compared', missing: 0, added: 0, substituted: 1, firstReferenceWord: 4,
  });
  assert.equal(compareSpeechText('[calm] 你好世界', '你好世界', 'zh-CN').status, 'compared');
  assert.equal(compareSpeechText(expected, '', 'en-US').status, 'unavailable');
  assert.equal(compareSpeechText('word '.repeat(1100), 'word '.repeat(1100), 'en-US').status, 'unavailable');
});

test('Speech check sends audio once and keeps recognized text out of its result', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), 'https://eastus2.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    assert.equal((init?.headers as Record<string, string>)['Ocp-Apim-Subscription-Key'], 'test-key');
    assert.ok(init?.body instanceof FormData);
    assert.equal(init?.redirect, 'error');
    const form = init.body;
    assert.deepEqual(JSON.parse(String(form.get('definition'))), { locales: ['en-US'], diarization: { enabled: true, maxSpeakers: 2 } });
    const audio = form.get('audio');
    assert.ok(audio instanceof Blob);
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
    return Response.json({
      combinedPhrases: [{ text: 'Hello there extra confidential word' }],
      phrases: [{ speaker: 1 }, { speaker: 2 }],
    });
  };
  const result = await speechCheck(credentials, Buffer.alloc(48000), 'en-US', 'Hello there', false, new AbortController().signal, fetcher);
  assert.equal(requests, 1);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.text, { status: 'compared', missing: 0, added: 3, substituted: 0, firstReferenceWord: 2 });
  assert.equal(result.speaker.status, 'possible_change');
  assert.doesNotMatch(JSON.stringify(result), /confidential|Hello there|test-key/);
  const html = renderToStaticMarkup(createElement(SpeechCheckSummary, { result, requested: true }));
  assert.match(html, /Possible speaker change/);
  assert.match(html, /do not change scores/);
});

test('Speech check exposes unavailable or failed checks rather than claiming success', async () => {
  const controller = new AbortController();
  const recognized: typeof fetch = async () => Response.json({
    combinedPhrases: [{ text: 'Some words' }], phrases: [{ speaker: 1 }, {}],
  });
  const windowed = await speechCheck(credentials, Buffer.alloc(48000), 'en-US', 'Some words', true, controller.signal, recognized);
  assert.equal(windowed.status, 'completed');
  assert.equal(windowed.text.status, 'unavailable');
  assert.equal(windowed.speaker.status, 'unavailable');
  const missing = await speechCheck(credentials, Buffer.alloc(48000), 'en-US', undefined, false, controller.signal, recognized);
  assert.equal(missing.status, 'completed');
  assert.equal(missing.text.status, 'unavailable');
  await assert.rejects(speechCheck(credentials, Buffer.alloc(48000), 'en-US', 'Some words', false, controller.signal,
    async () => new Response('', { status: 429 })), /HTTP 429/);
  await assert.rejects(speechCheck({ ...credentials, endpoint: 'https://example.com' }, Buffer.alloc(48000), 'en-US',
    'Some words', false, controller.signal, recognized), /valid Azure Speech/);
});

test('Arena Speech review runs once per clip, persists flags and exposes failures without changing scores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arena-speech-check-'));
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const checked: string[] = [];
  const backend = await createApp({
    dataDir: path.join(root, 'data'), port: address.port, endpoint: 'https://example.openai.azure.com',
    key: 'test-only', clipConcurrency: 2,
    verifySpeech: async clip => {
      checked.push(clip.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (clip.file.endsWith('L002.wav')) throw new Error('Speech service unavailable');
      return {
        status: 'completed', text: { status: 'compared', missing: 1, added: 0, substituted: 0, firstReferenceWord: 1 },
        speaker: { status: 'possible_change', segments: 2 },
      };
    },
    evaluate: async () => ({ assessment: assessment(4.6) }),
  });
  backend.app.use(backend.errors); server.on('request', backend.app);
  const url = `http://127.0.0.1:${address.port}`;
  const call = async <T,>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<T>;
  };
  try {
    const script = path.join(root, 'en-US_Customer_Services.txt');
    await writeFile(script, 'Hello\nGoodbye');
    const files = [1, 2].map(index => ({
      id: randomUUID(), path: `voice/en-US_Customer_Services_L00${index}.wav`,
      voice: 'en-US-Ava:DragonHDLatestNeural', size: 48044,
    }));
    const preview = await call<ArenaPreview>('/api/arena/uploads/preview', { scriptPaths: [script], files });
    const ids: string[] = [];
    for (const source of files) {
      const id = randomUUID();
      await call('/api/clips', {
        clip: { id, file: source.path, voice: source.voice, language: 'en-US', role: 'speaker', start: 0, end: 1, channel: 'mix' },
        pcm: Buffer.alloc(48000).toString('base64'),
      });
      ids.push(id);
    }
    const profile = batchTestProfile(withArenaRubric(newTestProfile({
      stage: 'tts', scope: 'single', speakerMode: 'automatic', language: 'auto', target: '',
    }, ARENA_RUBRIC)), preview.tests[0].name);
    const judges = [1, 2].map(index => ({ id: randomUUID(), name: `Judge ${index}`, deployment: `judge-${index}` }));
    const saved = await call<Job>('/api/jobs', {
      name: preview.tests[0].name, profile, judges, clipIds: ids, consent: true, enqueue: true, autoRetry: false,
      arena: { token: preview.token, testName: preview.tests[0].name },
    });
    let report: Job | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      report = await call<Job>(`/api/jobs/${saved.id}`);
      if (report.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(report?.status, 'completed');
    assert.deepEqual(checked.sort(), [...ids].sort());
    assert.equal(report.clips[0].speechCheck?.status, 'completed');
    assert.deepEqual(report.clips[1].speechCheck, { status: 'failed', error: 'Speech service unavailable' });
    assert.equal(report.results.length, 4);
    assert.ok(report.results.every(result => result.status === 'completed' && result.assessment?.scores.naturalness === 4.6));
    for (const variant of [
      { profile: { ...profile, arenaSpeechCheck: false }, arena: { token: preview.token, testName: preview.tests[0].name } },
      { profile, arena: undefined },
    ]) {
      const savedVariant = await call<Job>('/api/jobs', {
        name: preview.tests[0].name, ...variant, judges, clipIds: ids, consent: true, enqueue: true, autoRetry: false,
      });
      let completed: Job | undefined;
      for (let attempt = 0; attempt < 300; attempt++) {
        completed = await call<Job>(`/api/jobs/${savedVariant.id}`);
        if (completed.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(completed?.status, 'completed');
      assert.ok(completed.clips.every(item => item.speechCheck === undefined));
    }
    assert.equal(checked.length, 2, 'Disabled and non-Arena evaluations must not request Speech checks');
    await call('/api/queue/pause', {});
    const existingIds = new Set((await backend.store.jobs()).map(item => item.id));
    await call('/api/jobs/bulk', { action: 'redo', ids: [saved.id], consent: true });
    const redo = (await backend.store.jobs()).find(item => !existingIds.has(item.id));
    assert.ok(redo);
    assert.ok(redo.clips.every(item => item.speechCheck === undefined));
  } finally {
    backend.cancelActive();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
