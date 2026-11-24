import { DEFAULT_EXPRESSION_TAG_LISTS } from './scriptExpressionTags.js';
import type { StudioVoice } from './studio.js';

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const expressionStyles = new Set(DEFAULT_EXPRESSION_TAG_LISTS.styles.map(tag => tag.toLowerCase()));
const expressionSounds = new Set(DEFAULT_EXPRESSION_TAG_LISTS.sounds.map(tag => tag.toLowerCase()));

export type StudioExpressionMarkup = {
  ssmlText: string;
  spokenText: string;
  unlistedStyles: string[];
  soundTags: string[];
};

export function studioExpressionMarkup(voice: StudioVoice, text: string, prosodyAttributes = ''): StudioExpressionMarkup {
  const voiceStyles = new Map((voice.StyleList ?? []).map(style => [style.toLowerCase(), style]));
  const unlistedStyles = new Set<string>();
  const soundTags = new Set<string>();
  const ssml: string[] = [];
  let spokenText = '';
  let activeStyle: string | undefined;
  let cursor = 0;
  const append = (segment: string) => {
    spokenText += segment;
    const escaped = escapeXml(segment);
    const prosody = prosodyAttributes ? `<prosody ${prosodyAttributes}>${escaped}</prosody>` : escaped;
    ssml.push(activeStyle ? `<mstts:express-as style="${escapeXml(activeStyle)}">${prosody}</mstts:express-as>` : prosody);
  };

  for (const match of text.matchAll(/\[([^\[\]\r\n]+)\]/g)) {
    const tag = match[1].trim();
    const normalized = tag.toLowerCase();
    const style = voiceStyles.get(normalized);
    const precedingText = text.slice(0, match.index).trimEnd();
    const startsSentence = !precedingText || /[.!?…]["'»”’)]*$/.test(precedingText);
    const isSound = expressionSounds.has(normalized);
    const isStyle = !isSound && (expressionStyles.has(normalized) || style !== undefined ||
      (startsSentence && /^\p{L}[\p{L}\p{N}_-]*$/u.test(tag)));
    if (!isStyle && !isSound) continue;
    append(text.slice(cursor, match.index));
    if (isStyle) {
      activeStyle = style ?? normalized;
      if (!style) unlistedStyles.add(normalized);
    } else {
      soundTags.add(tag);
    }
    cursor = match.index + match[0].length;
  }
  append(text.slice(cursor));
  return { ssmlText: ssml.join(''), spokenText, unlistedStyles: [...unlistedStyles], soundTags: [...soundTags] };
}

export function studioSsml(voice: StudioVoice, text: string, locale: string, rate: number, pitch: number): string {
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}%`;
  const attributes = [rate ? `rate="${signed(rate)}"` : '', pitch ? `pitch="${signed(pitch)}"` : ''].filter(Boolean).join(' ');
  const expression = studioExpressionMarkup(voice, text, attributes);
  const content = locale ? `<lang xml:lang="${escapeXml(locale)}">${expression.ssmlText}</lang>` : expression.ssmlText;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(voice.Locale)}"><voice name="${escapeXml(voice.ShortName)}">${content}</voice></speak>`;
}
