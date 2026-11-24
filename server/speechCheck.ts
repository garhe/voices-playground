import { z } from 'zod';
import type { SpeechCheck } from '../shared/domain.js';
import { wav } from './audio.js';

export type SpeechCheckCredentials = { region: string; endpoint: string; key: string };
const speechResponse = z.object({
  combinedPhrases: z.array(z.object({ text: z.string() })).optional(),
  phrases: z.array(z.object({
    speaker: z.union([z.number(), z.string()]).nullish(),
  })).optional(),
});
const MAX_COMPARISON_CELLS = 1_000_000;

function words(text: string, locale: string): string[] {
  const clean = text.replace(/\[[^\[\]\r\n]+\]/g, ' ')
    .toLocaleLowerCase(locale).normalize('NFD').replace(/\p{M}/gu, '');
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  return [...segmenter.segment(clean)].filter(part => part.isWordLike).map(part => part.segment);
}

export function compareSpeechText(reference: string, recognized: string, locale: string): Extract<SpeechCheck, { status: 'completed' }>['text'] {
  const expected = words(reference, locale);
  const actual = words(recognized, locale);
  if (!expected.length || !actual.length)
    return { status: 'unavailable', reason: 'The reference or recognized speech did not contain comparable words.' };
  if ((expected.length + 1) * (actual.length + 1) > MAX_COMPARISON_CELLS)
    return { status: 'unavailable', reason: 'The text is too long for the bounded comparison.' };
  const width = actual.length + 1;
  const costs = new Uint32Array((expected.length + 1) * width);
  for (let j = 0; j <= actual.length; j++) costs[j] = j;
  for (let i = 1; i <= expected.length; i++) {
    costs[i * width] = i;
    for (let j = 1; j <= actual.length; j++)
      costs[i * width + j] = Math.min(
        costs[i * width + j - 1] + 1, costs[(i - 1) * width + j] + 1,
        costs[(i - 1) * width + j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1),
      );
  }
  let i = expected.length, j = actual.length, missing = 0, added = 0, substituted = 0;
  let firstReferenceWord: number | null = null;
  while (i || j) {
    if (i && j && expected[i - 1] === actual[j - 1] && costs[i * width + j] === costs[(i - 1) * width + j - 1]) {
      i--; j--; continue;
    }
    firstReferenceWord = Math.max(1, i);
    if (i && j && costs[i * width + j] === costs[(i - 1) * width + j - 1] + 1) {
      substituted++; i--; j--;
    } else if (i && costs[i * width + j] === costs[(i - 1) * width + j] + 1) {
      missing++; i--;
    } else {
      added++; j--;
    }
  }
  return { status: 'compared', missing, added, substituted, firstReferenceWord };
}

export async function speechCheck(
  credentials: SpeechCheckCredentials, pcm: Buffer, locale: string, reference: string | undefined,
  windowed: boolean, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<SpeechCheck> {
  if (!/^[a-z0-9-]{2,40}$/.test(credentials.region) || !credentials.key)
    throw new Error('Configure an Azure Speech region and key for the additional check.');
  const root = credentials.endpoint || `https://${credentials.region}.api.cognitive.microsoft.com`;
  const url = new URL(root);
  if (url.protocol !== 'https:' ||
      !(/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(url.hostname) ||
        /^[a-z0-9-]+\.api\.cognitive\.microsoft\.com$/i.test(url.hostname)) ||
      url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('The Speech check requires a valid Azure Speech resource endpoint.');
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'audio.wav');
  form.append('definition', JSON.stringify({ locales: [locale], diarization: { enabled: true, maxSpeakers: 2 } }));
  const response = await fetcher(`${url.origin}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': credentials.key }, body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Azure Speech check failed (HTTP ${response.status}).`);
  const result = speechResponse.parse(await response.json());
  const recognized = (result.combinedPhrases ?? []).map(phrase => phrase.text).join(' ');
  const phrases = result.phrases ?? [];
  const speakers = new Set(phrases.map(phrase => phrase.speaker).filter(speaker => speaker != null));
  const text = windowed ? { status: 'unavailable' as const, reason: 'The reference covers the whole file, not this audio window.' }
    : !reference ? { status: 'unavailable' as const, reason: 'A matching reference script was not available.' }
      : compareSpeechText(reference, recognized, locale);
  return {
    status: 'completed', text,
    speaker: {
      status: speakers.size > 1 ? 'possible_change'
        : speakers.size === 1 && phrases.every(phrase => phrase.speaker != null) ? 'no_change_detected' : 'unavailable',
      segments: phrases.length,
    },
  };
}
