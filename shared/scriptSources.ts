export const scriptInputs = [
  { id: 'text', label: 'Paste text' },
  { id: 'upload', label: 'Upload .txt' },
  { id: 'folder', label: 'Folder of .txt files' },
  { id: 'paths', label: 'List of file paths' },
] as const;
export type ScriptInput = typeof scriptInputs[number]['id'];
export const MAX_SCRIPT_FILE_BYTES = 2_000_000;
export const scriptPaths = (text: string) => text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);

export function decodeStudioText(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch { throw new Error('Unsupported encoding. Save the file as UTF-8 or UTF-16 with a BOM.'); }
}
