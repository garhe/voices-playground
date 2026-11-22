import { validStudioName, type StudioScript } from '../shared/studio.js';
export { decodeStudioText } from '../shared/scriptSources.js';

export function parseStudioScript(name: string, text: string): { script: StudioScript; warnings: string[] } {
  name = name.trim().replace(/\.txt$/i, '');
  if (!validStudioName(name, 80)) throw new Error(`Invalid script name "${name}". Use letters, numbers, spaces, dots, hyphens or underscores; avoid reserved Windows names.`);
  const lines = text.split(/\r\n|\n|\r/);
  const warnings: string[] = [];
  let start = 0;
  let locale = '';
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) throw new Error(`${name}: header has no closing --- line.`);
    for (const line of lines.slice(1, end)) {
      const match = /^locale:\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\s*$/i.exec(line);
      if (!match) throw new Error(`${name}: draft supports only a locale setting in the header; remove unsupported settings before proceeding.`);
      locale = match[1];
    }
    start = end + 1;
  }
  const spoken = lines.slice(start).flatMap((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith('//')) return [];
    const tab = raw.indexOf('\t');
    if (index === 0 && tab >= 0 && /^(filename|file|name|id)$/i.test(raw.slice(0, tab).trim())) {
      warnings.push(`${name}: skipped column header on line ${start + index + 1}.`); return [];
    }
    let clipName = tab >= 0 ? raw.slice(0, tab).trim().replace(/\.(wav|mp3)$/i, '') : '';
    let value = (tab >= 0 ? raw.slice(tab + 1).replace(/\t/g, ' ') : raw).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/""/g, '"');
    if (!value) throw new Error(`${name}, line ${start + index + 1}: spoken text is empty.`);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(value)) throw new Error(`${name}, line ${start + index + 1}: text contains characters not supported in SSML. Save as UTF-8 or UTF-16 with a BOM.`);
    if (value.length > 3000) throw new Error(`${name}, line ${start + index + 1}: the draft supports at most 3,000 characters per line.`);
    if (clipName && !validStudioName(clipName, 100)) throw new Error(`${name}, line ${start + index + 1}: invalid clip name "${clipName}".`);
    if (tab >= 0 && !clipName) warnings.push(`${name}, line ${start + index + 1}: empty name; using an automatic name.`);
    return [{ name: clipName, text: value, line: start + index + 1, source: clipName ? 'tab' as const : 'auto' as const }];
  });
  if (!spoken.length) throw new Error(`${name}: no spoken lines found.`);
  if (spoken.length > 500) throw new Error(`${name}: the draft supports at most 500 lines per script.`);
  const width = Math.max(3, String(spoken.length).length);
  const clips = spoken.map((clip, index) => ({ ...clip, name: clip.name || `${name}_L${String(index + 1).padStart(width, '0')}` }));
  return { script: { name, clips, locale }, warnings };
}
