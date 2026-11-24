import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_EXPRESSION_TAG_LISTS, type ExpressionTagLists } from '../shared/scriptExpressionTags.js';
import { decodeStudioText, MAX_SCRIPT_FILE_BYTES } from '../shared/scriptSources.js';
import {
  MAX_TAG_SCRIPT_FILES, scriptHasExpressionTags, type ScriptTagInspection, type ScriptTagRequest,
  type ScriptTagResult, type ScriptTagSource,
} from '../shared/scriptTags.js';
import { checkScriptFile, localScriptPaths } from './scriptSourcePaths.js';

type ChooseStyles = (sentences: string[], allowedStyles: string[]) => Promise<unknown>;
const styleResult = z.object({ styles: z.array(z.string()) }).strict();
const annotation = /\[([\p{L}][\p{L}\p{N}_-]*)\] ?/giu;

function editedLines(text: string, edit: (spoken: string) => string) {
  const lines = text.split(/(\r\n|\n|\r)/);
  const first = lines.findIndex((line, index) => index % 2 === 0 && line.trim());
  const header = lines[first]?.trim() === '---';
  const end = header ? lines.findIndex((line, index) => index > first && index % 2 === 0 && line.trim() === '---') : -1;
  if (header && end < 0) throw new Error('The script header has no closing --- line.');
  const firstSpoken = lines.findIndex((line, index) =>
    index % 2 === 0 && index > end && line.trim() && !line.trimStart().startsWith('//'));
  return lines.map((line, index) => {
    if (index % 2 || index <= end || !line.trim() || line.trimStart().startsWith('//')) return line;
    const tab = line.indexOf('\t');
    if (tab >= 0 && index === firstSpoken && /^(filename|file|name|id)$/i.test(line.slice(0, tab).trim())) return line;
    const prefix = line.slice(0, tab + 1);
    const value = line.slice(tab + 1);
    const quoted = /^(\s*")(.*)("\s*)$/u.exec(value);
    return prefix + (quoted ? quoted[1] + edit(quoted[2]) + quoted[3] : edit(value));
  }).join('');
}

export async function transformScriptTags(
  text: string, action: ScriptTagRequest['action'], lists: ExpressionTagLists, signal: AbortSignal, choose?: ChooseStyles,
) {
  const alreadyTagged = scriptHasExpressionTags(text, lists);
  if (action === 'add' && alreadyTagged)
    throw new Error('This script already has expression tags. Only remove tags is allowed.');
  if (action === 'remove' && !alreadyTagged)
    throw new Error('This script has no expression tags to remove. Add tags first.');
  const known = new Set([...DEFAULT_EXPRESSION_TAG_LISTS.styles, ...lists.styles,
    ...(action === 'remove' ? [...DEFAULT_EXPRESSION_TAG_LISTS.sounds, ...lists.sounds] : [])]);
  const strip = (spoken: string) => spoken.replace(annotation, (whole, name: string) => known.has(name.toLowerCase()) ? '' : whole);
  if (action === 'remove') return editedLines(text, strip);
  if (!choose) throw new Error('Configure a text deployment before adding tags.');
  if (text.length > 100_000) throw new Error('Split scripts longer than 100,000 characters before adding tags.');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const sentences: string[] = [];
  const soundNames = new Set([...DEFAULT_EXPRESSION_TAG_LISTS.sounds, ...lists.sounds]);
  const sentenceParts = (line: string) => {
    // Give sound tags a word shape for segmentation without changing source offsets.
    const masked = line.replace(/\[([\p{L}][\p{L}\p{N}_-]*)\]/giu, (whole, name: string) =>
      soundNames.has(name.toLowerCase()) ? `X${'x'.repeat(whole.length - 1)}` : whole);
    return Array.from(segmenter.segment(masked), ({ index, segment }) => line.slice(index, index + segment.length));
  };
  const hasSpeech = (value: string) => /[\p{L}\p{N}]/u.test(value.replace(/\[[^\]\r\n]+\]/gu, ''));
  editedLines(text, spoken => {
    const value = strip(spoken);
    for (const segment of sentenceParts(value)) if (hasSpeech(segment)) sentences.push(segment.trim());
    return value;
  });
  if (!sentences.length) throw new Error('No spoken sentences found.');
  const tags: string[] = [];
  const allowed = new Set(lists.styles);
  for (let index = 0; index < sentences.length;) {
    signal.throwIfAborted();
    const batch: string[] = [];
    let size = 0;
    do {
      const sentence = sentences[index++];
      if (sentence.length > 8000) throw new Error('Split spoken sentences longer than 8,000 characters before adding tags.');
      batch.push(sentence);
      size += sentence.length;
    } while (batch.length < 50 && index < sentences.length && size + sentences[index].length <= 8000);
    const parsed = styleResult.safeParse(await choose(batch, lists.styles));
    if (!parsed.success || parsed.data.styles.length !== batch.length || parsed.data.styles.some(tag => !allowed.has(tag)))
      throw new Error('Azure did not return one allowed style tag per sentence. No output was written for this script.');
    tags.push(...parsed.data.styles);
  }
  signal.throwIfAborted();
  let index = 0;
  return editedLines(text, spoken => sentenceParts(strip(spoken)).map(segment =>
    hasSpeech(segment) ? segment.replace(/^(\s*)(?=\S)/u, `$1[${tags[index++]}] `) : segment).join(''));
}

function encodeLike(text: string, source: Buffer): Buffer {
  if (source[0] === 0xff && source[1] === 0xfe) return Buffer.from(`\uFEFF${text}`, 'utf16le');
  if (source[0] === 0xfe && source[1] === 0xff) return Buffer.from(`\uFEFF${text}`, 'utf16le').swap16();
  return Buffer.from(source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf ? `\uFEFF${text}` : text);
}

export async function processScriptTags(input: ScriptTagRequest, signal: AbortSignal, choose?: ChooseStyles): Promise<ScriptTagResult[]> {
  const suffix = input.action === 'add' ? '_Tags' : '_NoTags';
  const nameFor = (name: string) => `${name.replace(/\.txt$/i, '')}${suffix}.txt`;
  const edit = (text: string) => transformScriptTags(text, input.action, input.tagLists ?? DEFAULT_EXPRESSION_TAG_LISTS, signal, choose);
  if (input.source.type === 'text') {
    const { name, text } = input.source;
    if (Buffer.byteLength(text) > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a script of at most 2 MB.');
    return [{ source: name, name: nameFor(name), text: await edit(text) }];
  }
  const sources = new Map<string, { name: string; error?: string }>();
  for await (const entry of localScriptPaths(input.source.paths, name => !name.toLowerCase().endsWith(`${suffix.toLowerCase()}.txt`))) {
    signal.throwIfAborted();
    const key = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
    if (!sources.has(key)) sources.set(key, entry);
    if (sources.size > MAX_TAG_SCRIPT_FILES) throw new Error(`Choose at most ${MAX_TAG_SCRIPT_FILES} files per operation.`);
  }
  const results: ScriptTagResult[] = [];
  for (const entry of sources.values()) {
    signal.throwIfAborted();
    const name = nameFor(path.basename(entry.name));
    const destination = path.join(path.dirname(entry.name), name);
    if (entry.error) { results.push({ source: entry.name, name, error: entry.error }); continue; }
    try {
      await checkScriptFile(entry.name);
      const bytes = await readFile(entry.name, { signal });
      if (bytes.length > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a .txt file of at most 2 MB.');
      const output = await edit(decodeStudioText(bytes));
      signal.throwIfAborted();
      await checkScriptFile(entry.name);
      const temp = path.join(path.dirname(entry.name), `.script-tags-${randomUUID()}.tmp`);
      await writeFile(temp, encodeLike(output, bytes), { flag: 'wx', mode: 0o600 }).catch(async error => {
        if (error.code !== 'EEXIST') await unlink(temp).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
        throw error;
      });
      try {
        signal.throwIfAborted();
        await link(temp, destination);
      } finally { await unlink(temp); }
      results.push({ source: entry.name, name, path: destination });
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'The output already exists. It was not overwritten.' : error instanceof Error ? error.message : 'Could not process the script.';
      results.push({ source: entry.name, name, error: message });
    }
  }
  return results;
}

export async function inspectScriptTags(
  source: ScriptTagSource, lists: ExpressionTagLists = DEFAULT_EXPRESSION_TAG_LISTS, signal: AbortSignal = new AbortController().signal,
): Promise<ScriptTagInspection[]> {
  if (source.type === 'text') {
    if (Buffer.byteLength(source.text) > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a script of at most 2 MB.');
    return [{ source: source.name, tagged: scriptHasExpressionTags(source.text, lists) }];
  }
  const sources = new Map<string, { name: string; error?: string }>();
  for await (const entry of localScriptPaths(source.paths)) {
    signal.throwIfAborted();
    const key = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
    if (!sources.has(key)) sources.set(key, entry);
    if (sources.size > MAX_TAG_SCRIPT_FILES) throw new Error(`Choose at most ${MAX_TAG_SCRIPT_FILES} files per operation.`);
  }
  const results: ScriptTagInspection[] = [];
  for (const entry of sources.values()) {
    signal.throwIfAborted();
    if (entry.error) { results.push({ source: entry.name, error: entry.error }); continue; }
    try {
      await checkScriptFile(entry.name);
      const bytes = await readFile(entry.name, { signal });
      if (bytes.length > MAX_SCRIPT_FILE_BYTES) throw new Error('Choose a .txt file of at most 2 MB.');
      results.push({ source: entry.name, tagged: scriptHasExpressionTags(decodeStudioText(bytes), lists) });
    } catch (error) {
      signal.throwIfAborted();
      results.push({ source: entry.name, error: error instanceof Error ? error.message : 'Could not inspect the script.' });
    }
  }
  return results;
}
