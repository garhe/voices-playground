import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { arenaImportSchema, arenaUploadSchema, arenaScript, type ArenaPreview, type ArenaReference, type ArenaMetadata, type ArenaTest, type ArenaScriptSource } from '../shared/arena.js';
import { supportedAudio } from '../shared/batch.js';
import { contiguousWindows, type StoredClip, type VoiceGender } from '../shared/domain.js';
import { BatchImport } from './batch.js';
import { realDirectory } from './localDirectory.js';
import { decodeStudioText, parseStudioScript } from './studioScripts.js';
import { exactStudioSsmlForAudios } from './studio.js';

type Source = { path: string; size: number; mtimeMs: number };
export class ArenaImport {
  private batch = new BatchImport();
  private preview?: ArenaPreview;
  private sources = new Map<string, Source>();
  private layout?: 'voices' | 'tests';
  private references = new Map<string, string>();
  private exactSsml = new Map<string, string>();

  private async scriptMatcher(source: ArenaScriptSource) {
    const inputs = 'scriptsDirectory' in source ? [await realDirectory(source.scriptsDirectory)] : source.scriptPaths;
    const scriptFiles = new Map<string, string>();
    const addScript = async (file: string) => {
      await this.validateFile(file);
      const key = process.platform === 'win32' ? file.toLowerCase() : file;
      if (!scriptFiles.has(key)) scriptFiles.set(key, file);
    };
    for (const input of inputs) {
      if (!path.isAbsolute(input)) throw new Error(`Enter an absolute test script file or directory path: ${input}`);
      const absolute = path.resolve(input);
      if (path.parse(absolute).root === absolute) throw new Error('Choose a test script file or directory, not a drive root.');
      let stat;
      try { stat = await lstat(absolute); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          throw new Error(`Test script path does not exist: ${input}`);
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`Choose real files and directories without links or junctions: ${absolute}`);
      if (stat.isDirectory()) {
        const directory = await realDirectory(absolute);
        for (const name of (await readdir(directory)).sort())
          if (/\.txt$/i.test(name)) await addScript(path.join(directory, name));
      } else {
        if (!/\.txt$/i.test(absolute)) throw new Error(`Choose a .txt test script file: ${absolute}`);
        await addScript(absolute);
      }
    }
    const scripts = new Map<string, { metadata: ArenaMetadata; text: string }>();
    const clipScripts = new Map<string, { metadata: ArenaMetadata; text: string }[]>();
    for (const file of scriptFiles.values()) {
      const name = path.basename(file);
      const metadata = arenaScript(name);
      const stem = name.slice(0, -4);
      const { script } = parseStudioScript(stem, decodeStudioText(await readFile(file)));
      if (script.locale && Intl.getCanonicalLocales(script.locale)[0] !== metadata.locale)
        throw new Error(`Script header locale must match its filename: ${name}`);
      if (scripts.has(stem.toLowerCase())) throw new Error(`Duplicate script name: ${name}`);
      scripts.set(stem.toLowerCase(), { metadata, text: script.clips.map(clip => clip.text).join('\n') });
      for (const clip of script.clips) {
        const key = clip.name.toLowerCase();
        clipScripts.set(key, [...(clipScripts.get(key) ?? []), { metadata, text: clip.text }]);
      }
    }
    if (!scripts.size) throw new Error('Provide a directory containing <locale>_<domain>.txt test scripts, or at least one .txt file path.');
    return (filename: string) => {
      const stem = path.parse(filename).name.toLowerCase();
      const matches = clipScripts.get(stem) ?? (scripts.has(stem) ? [scripts.get(stem)!] : []);
      if (matches.length !== 1) throw new Error(`Audio "${filename}" must match exactly one provided script or clip name. Use unique names such as <locale>_<domain>_L001.wav.`);
      return matches[0];
    };
  }

  private remember(file: { path: string; voice: string }, text: string) {
    this.references.set(JSON.stringify([file.path, file.voice]), text);
  }

  async planUploads(input: unknown): Promise<ArenaPreview> {
    this.preview = undefined;
    this.references.clear();
    this.exactSsml.clear();
    const request = arenaUploadSchema.parse(input);
    const match = await this.scriptMatcher(request);
    const matches = request.files.map(file => match(path.basename(file.path)));
    request.files.forEach((file, index) => this.remember(file, matches[index].text));
    const metadata = matches.map(item => item.metadata);
    const first = metadata[0];
    if (metadata.some(item => item.locale !== first.locale || item.domain !== first.domain))
      throw new Error('Single evaluation requires one script language/domain. Use Batch evaluation for multiple language/domain tests.');
    const test: ArenaTest = {
      name: `${first.locale}_${first.domain}`, arena: { ...first, scripts: [...new Set(metadata.flatMap(item => item.scripts))] },
      files: request.files, languages: [first.locale], genders: ['Unspecified'], errors: [],
    };
    this.preview = { directory: '', token: randomUUID(), ignoredFiles: 0, tests: [test] };
    this.sources.clear(); this.layout = undefined;
    return this.preview;
  }

  async plan(input: unknown): Promise<ArenaPreview> {
    this.preview = undefined;
    this.references.clear();
    this.exactSsml.clear();
    const request = arenaImportSchema.parse(input);
    const root = await realDirectory('directory' in request ? request.directory : request.directories[0]);
    const matchScript = await this.scriptMatcher(request);
    const response: ArenaPreview = { directory: root, token: randomUUID(), tests: [], ignoredFiles: 0 };
    const groups = new Map<string, ArenaTest>();
    const add = (file: { id: string; path: string; voice: string; size: number }, match: { metadata: ArenaMetadata; text: string }, gender: VoiceGender = 'Unspecified') => {
      const { metadata } = match;
      const name = `${metadata.locale}_${metadata.domain}`;
      let group = groups.get(name);
      if (!group) {
        group = { name, arena: { ...metadata, scripts: [...metadata.scripts] }, files: [], errors: [], languages: [metadata.locale], genders: [], voiceLabels: [] };
        groups.set(name, group);
      }
      for (const script of metadata.scripts) if (!group.arena.scripts.includes(script)) group.arena.scripts.push(script);
      const voice = decodeURIComponent(file.voice);
      if (!voice.trim() || voice.length > 200) throw new Error(`Invalid voice/model folder: ${file.voice}`);
      const label = group.voiceLabels!.find(label => label.voice === voice);
      if (label && label.gender !== gender) throw new Error(`Conflicting gender labels for ${voice}. Use consistent test-folder gender metadata.`);
      if (!label) group.voiceLabels!.push({ voice, gender });
      if (!group.genders.includes(gender)) group.genders.push(gender);
      group.files.push({ ...file, voice });
      this.remember({ path: file.path, voice }, match.text);
      if (!file.size || file.size > 100 * 1024 * 1024) group.errors.push(`Audio must be nonempty and no larger than 100 MB: ${file.path}`);
    };
    this.sources.clear();
    if (request.layout === 'tests') {
      const preview = await this.batch.plan('directory' in request ? { directory: root } : { directories: request.directories });
      response.token = preview.token; response.ignoredFiles = preview.ignoredFiles;
      for (const test of preview.tests) {
        if (test.errors.length) throw new Error(`${test.name}: ${test.errors.join(' ')}`);
        for (const file of test.files) add(file, matchScript(path.basename(file.path)), test.genders.length === 1 ? test.genders[0] : 'Unspecified');
      }
    } else {
      const visit = async (directory: string, voice?: string): Promise<void> => {
        for (const name of (await readdir(directory)).sort()) {
          const absolute = path.join(directory, name);
          const stat = await lstat(absolute);
          if (stat.isSymbolicLink() || path.relative(await realpath(absolute), absolute) !== '')
            throw new Error(`Links and junctions are not supported: ${absolute}`);
          if (stat.isDirectory()) { await visit(absolute, voice ?? name); continue; }
          if (!supportedAudio.test(name)) { response.ignoredFiles++; continue; }
          if (!voice || !stat.isFile()) throw new Error(`Place audio inside voice/model folders: ${name}`);
          const id = randomUUID();
          const relative = path.relative(root, absolute);
          if (relative.length > 500) throw new Error(`Audio path is too long: ${relative}`);
          add({ id, path: relative, voice, size: stat.size }, matchScript(name));
          this.sources.set(id, { path: absolute, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      };
      await visit(root);
    }
    response.tests = [...groups.values()];
    if (!response.tests.length) throw new Error('No matching audio found inside voice/model folders.');
    const files = response.tests.flatMap(test => test.files);
    const lookup = request.layout === 'voices' ? files.flatMap(file => {
      if (file.ssml) return [];
      const source = this.sources.get(file.id)?.path;
      return source ? [{ file, source }] : [];
    }) : [];
    const ssmlBySource = await exactStudioSsmlForAudios(lookup.map(item => item.source));
    const lookupIndexByFile = new Map(lookup.map((item, index) => [item.file.id, index]));
    for (const test of response.tests) {
      if (test.name.length > 120) test.errors.push('Locale and domain together must be at most 120 characters.');
    }
    for (const file of files) {
      const lookupIndex = lookupIndexByFile.get(file.id) ?? -1;
      const ssml = file.ssml ?? (lookupIndex >= 0 ? ssmlBySource[lookupIndex] : undefined);
      if (ssml) {
        file.ssml = ssml;
        this.exactSsml.set(JSON.stringify([file.path, file.voice]), ssml);
      }
    }
    this.layout = request.layout;
    this.preview = response;
    return response;
  }

  private async validateFile(source: string) {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || path.relative(await realpath(source), source) !== '')
      throw new Error(`Choose real files without links or junctions: ${source}`);
    return stat;
  }

  async audio(token: string, id: string): Promise<Buffer> {
    if (this.preview?.token !== token) throw new Error('Arena preview expired. Preview the directory again.');
    if (this.layout === 'tests') return this.batch.audio(token, id);
    const source = this.sources.get(id);
    if (!source) throw new Error('Unknown Arena audio.');
    const stat = await this.validateFile(source.path);
    if (stat.size !== source.size || stat.mtimeMs !== source.mtimeMs) throw new Error('Arena audio changed after preview. Preview again.');
    return readFile(source.path);
  }

  metadata(reference: ArenaReference, clips: StoredClip[]): ArenaMetadata {
    const test = this.preview?.token === reference.token ? this.preview.tests.find(test => test.name === reference.testName) : undefined;
    if (!test || test.errors.length) throw new Error('Arena preview expired or invalid. Preview the directory again.');
    const expected = new Set(test.files.map(file => JSON.stringify([file.path, file.voice])));
    const actual = new Set(clips.map(clip => JSON.stringify([clip.file, clip.voice])));
    if (expected.size !== actual.size || [...expected].some(key => !actual.has(key)))
      throw new Error('Arena audio must match every file and voice in the preview.');
    return structuredClone(test.arena);
  }

  /**
   * Script text per clip ID. Clips receive the script when they start near 0 s and form back-to-back windows.
   * This check does not independently verify the original file's end.
   */
  referenceScripts(reference: ArenaReference, clips: StoredClip[]): Map<string, string> {
    this.metadata(reference, clips);
    const perFile = new Map<string, StoredClip[]>();
    for (const clip of clips) {
      const key = JSON.stringify([clip.file, clip.voice]);
      perFile.set(key, [...(perFile.get(key) ?? []), clip]);
    }
    const result = new Map<string, string>();
    for (const [key, group] of perFile) {
      const text = this.references.get(key);
      if (text && text.length <= 20000 && contiguousWindows(group)) for (const clip of group) result.set(clip.id, text);
    }
    return result;
  }

  ssmls(reference: ArenaReference, clips: StoredClip[]): Map<string, string> {
    this.metadata(reference, clips);
    const result = new Map<string, string>();
    for (const clip of clips) {
      const ssml = this.exactSsml.get(JSON.stringify([clip.file, clip.voice]));
      if (ssml) result.set(clip.id, ssml);
    }
    return result;
  }

  labels(reference: ArenaReference) {
    const test = this.preview?.token === reference.token ? this.preview.tests.find(test => test.name === reference.testName) : undefined;
    if (!test) throw new Error('Arena preview expired. Preview again.');
    return structuredClone(test.voiceLabels ?? []);
  }
}
