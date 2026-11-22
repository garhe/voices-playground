import { readFile } from 'node:fs/promises';
import type { ArenaCell } from '../shared/arena.js';
import { dimensions, type Dimension } from '../shared/domain.js';
import { TTS_ISSUE_THRESHOLD } from '../shared/ttsIssues.js';
import { DEFAULT_THEME_COLOR, themeMix, themePalette } from '../src/theme.js';

const labels: Record<Dimension, string> = {
  naturalness: 'Naturalness',
  articulation: 'Pronunciation accuracy',
  pace: 'Pace & rhythm',
  expressiveness: 'Emotion & speaking style',
  contextFit: 'Target-style fit',
  accentFit: 'Accent fit',
  audioQuality: 'Audio quality',
};

export function shareScorecardData(cells: readonly ArenaCell[], exportedAt = new Date()) {
  return {
    exportedOn: exportedAt.toISOString().slice(0, 10),
    issueThreshold: TTS_ISSUE_THRESHOLD,
    mixedSettings: new Set(cells.map(cell => cell.comparison)).size > 1,
    dimensions: dimensions.map(id => ({ id, label: labels[id] })),
    cells: cells.map(cell => {
      const ratings = dimensions.flatMap(id => {
        const rating = cell.dimensionScores?.find(item => item.dimension === id);
        return rating ? [{ id, score: rating.score }] : [];
      });
      return {
        voice: cell.voice,
        model: cell.model, domain: cell.domain, locale: cell.locale, gender: cell.gender,
        score: cell.score, files: cell.files, ratings,
        issues: ratings.filter(rating => rating.score !== null && rating.score < TTS_ISSUE_THRESHOLD)
          .sort((a, b) => a.score! - b.score!).map(rating => rating.id),
      };
    }),
  };
}

export async function renderShareScorecard(cells: readonly ArenaCell[], theme = DEFAULT_THEME_COLOR) {
  return renderShareScorecardSnapshot(shareScorecardData(cells), theme);
}

export async function renderShareScorecardSnapshot(snapshot: ReturnType<typeof shareScorecardData>, theme = DEFAULT_THEME_COLOR) {
  const [template, workspaceCss] = await Promise.all([
    readFile(new URL('./shareScorecard.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  ]);
  const mix = themeMix(theme);
  const palette = Object.entries(themePalette(theme)).map(([name, value]) => `${name}:${value}`).join(';');
  // Script elements are parsed as raw text, even for application/json.
  const payload = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const replacements: Record<string, string> = {
    SCORECARD_DATA: payload,
    WORKSPACE_CSS: `${workspaceCss.replace(/<\/style/gi, '<\\/style')}\n:root{${palette}}`,
    THEME_MIX: mix ? ` data-theme-mix="${mix.id}"` : '',
  };
  for (const key of Object.keys(replacements)) {
    if (!template.includes(`<!--${key}-->`)) throw new Error(`Shareable scorecard template is missing its ${key} marker.`);
  }
  return template.replace(/<!--(SCORECARD_DATA|WORKSPACE_CSS|THEME_MIX)-->/g, (_marker, key: string) => replacements[key]);
}
