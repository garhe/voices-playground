import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function realDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('Enter an absolute local directory path.');
  const resolved = path.resolve(directory);
  if (path.parse(resolved).root === resolved) throw new Error('A drive root cannot be used.');
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(resolved)).toLowerCase() !== resolved.toLowerCase())
    throw new Error(`Use a real directory without links or junctions: ${resolved}`);
  return resolved;
}
