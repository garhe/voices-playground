import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EXPRESSION_TAG_LISTS as lists } from '../shared/scriptExpressionTags.js';
import { scriptHasExpressionTags, scriptTagRequestSchema } from '../shared/scriptTags.js';
import { inspectScriptTags, processScriptTags, transformScriptTags } from '../server/scriptTags.js';

test('AI selects only style tags; adding and removing them preserves Studio layout and spoken text', async () => {
  const signal = new AbortController().signal;
  const original = '---\r\nlocale: fr-FR\r\n---\r\n// [calm] Notes\r\nid\ttext\r\nfr_001\t"  Bonjour ! Très bien.  "\r\n\r\nfr_002\tÇa marche [référence].\r\n';
  const tagged = await transformScriptTags(original, 'add', lists, signal, async (sentences, allowed) => {
    assert.deepEqual(sentences, ['Bonjour !', 'Très bien.', 'Ça marche [référence].']);
    assert.ok(allowed.includes('appreciative'));
    return { styles: ['appreciative', 'reassuring', 'confident'] };
  });
  assert.equal(tagged, original
    .replace('  Bonjour ! Très bien.', '  [appreciative] Bonjour ! [reassuring] Très bien.')
    .replace('\tÇa marche', '\t[confident] Ça marche'));
  assert.equal(await transformScriptTags(tagged, 'remove', lists, signal), original);
  await assert.rejects(transformScriptTags('[calm] Hi. [sighing] Bye.', 'add', lists, signal,
    async () => { throw new Error('Azure must not be called for tagged scripts.'); }), /Only remove tags is allowed/);
  await assert.rejects(transformScriptTags('Hi. Bye.', 'remove', lists, signal), /no expression tags to remove/);
  assert.equal(scriptHasExpressionTags('---\ntags: [happy]\n---\n// [happy] Notes\nid\ttext\nfr_001\tBonjour.'), false);
  assert.equal(scriptHasExpressionTags('id\ttext\nfr_001\t[calm] Bonjour. [sighing] Merci.'), true);
  await assert.rejects(transformScriptTags(original, 'add', lists, signal,
    async () => ({ styles: ['calm'], text: 'A rewrite.' })), /one allowed style tag per sentence/);
  assert.equal(scriptTagRequestSchema.safeParse({ action: 'add', source: { type: 'text', name: 'clip', text: original } }).success, false);
});

test('mixed folders and file paths write sibling copies once, preserving encoding and originals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'script-tags-test-'));
  try {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await mkdir(a); await mkdir(b); await mkdir(path.join(a, 'nested'));
    const source = path.join(a, 'voice.txt');
    const contents = Buffer.from('\uFEFFja_001\t[calm] はい。\r\n', 'utf16le');
    await writeFile(source, contents);
    const second = path.join(b, 'second.txt');
    await writeFile(second, 'id_001\t[happy] Hi.\n');
    await writeFile(path.join(a, 'nested', 'skip.txt'), '[happy] Skip.');
    assert.deepEqual(await inspectScriptTags({ type: 'text', name: 'plain', text: 'id_001\tHello.' }), [
      { source: 'plain', tagged: false },
    ]);
    assert.deepEqual(await inspectScriptTags({ type: 'paths', paths: [source, second] }), [
      { source, tagged: true },
      { source: second, tagged: true },
    ]);
    const input = { action: 'remove', source: { type: 'paths', paths: [`"${a}"`, b, source] } } as const;
    const request = scriptTagRequestSchema.parse({ ...input, source: { ...input.source, paths: [...input.source.paths] } });
    const result = await processScriptTags(request, new AbortController().signal);
    assert.deepEqual(result.map(file => file.name), ['voice_NoTags.txt', 'second_NoTags.txt']);
    assert.deepEqual(await readFile(source), contents);
    assert.deepEqual(await readFile(path.join(a, 'voice_NoTags.txt')), Buffer.from('\uFEFFja_001\tはい。\r\n', 'utf16le'));
    assert.equal(await readFile(path.join(b, 'second_NoTags.txt'), 'utf8'), 'id_001\tHi.\n');
    await assert.rejects(readFile(path.join(a, 'nested', 'skip_NoTags.txt')), { code: 'ENOENT' });
    const rerun = await processScriptTags(request, new AbortController().signal);
    assert.equal(rerun.length, 2);
    assert.ok(rerun.every(item => /not overwritten/.test(item.error ?? '')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
