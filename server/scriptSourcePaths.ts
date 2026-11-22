import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SCRIPT_FILE_BYTES } from '../shared/scriptSources.js';

const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

async function localStat(input: string) {
  const stat = await lstat(input);
  if (stat.isSymbolicLink() || pathKey(await realpath(input)) !== pathKey(path.resolve(input)))
    throw new Error('Links and junctions are not supported.');
  return stat;
}

export async function checkScriptFile(file: string) {
  const stat = await localStat(file);
  if (!stat.isFile() || !/\.txt$/i.test(file) || stat.size > MAX_SCRIPT_FILE_BYTES)
    throw new Error('Choose a .txt file of at most 2 MB.');
}

export async function* localScriptPaths(paths: string[], includeFromFolder: (name: string) => boolean = () => true):
  AsyncGenerator<{ name: string; error?: string }> {
  for (const raw of paths) {
    const input = raw.trim().replace(/^"(.*)"$/, '$1');
    let names: string[];
    try {
      if (!path.isAbsolute(input) || path.parse(path.resolve(input)).root === path.resolve(input))
        throw new Error('Enter an absolute file or folder path, not a drive root.');
      const stat = await localStat(input);
      if (stat.isDirectory()) {
        const scripts = (await readdir(input)).filter(name => /\.txt$/i.test(name));
        if (!scripts.length) throw new Error('No .txt files found in this folder.');
        names = scripts.filter(includeFromFolder).sort().map(name => path.join(input, name));
        if (!names.length) throw new Error('No unprocessed .txt files found in this folder.');
      } else names = [path.resolve(input)];
    } catch (error) {
      yield { name: input, error: error instanceof Error ? error.message : 'Could not read path.' };
      continue;
    }
    for (const name of names) {
      try { await checkScriptFile(name); }
      catch (error) {
        yield { name, error: error instanceof Error ? error.message : 'Could not read file.' };
        continue;
      }
      yield { name };
    }
  }
}
