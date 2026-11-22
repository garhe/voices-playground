import { useState } from 'react';
import type { ArenaCell } from '../shared/arena';
import type { Job } from '../shared/domain';
import { useTableSort } from './TableSort';

export function ArenaScoreMatrix({ domain, cells, locales, load, onInspect, busy,
  externalUrl = import.meta.env?.VITE_ARENA_EXTERNAL_SCORECARD_URL }: {
  domain: string; cells: ArenaCell[]; locales: string[]; load: (id: string) => Promise<Job>;
  onInspect: (cell: ArenaCell) => void; busy: boolean; externalUrl?: string;
}) {
  const configuredUrl = externalUrl?.trim();
  const parsedUrl = configuredUrl?.startsWith('https://') ? URL.parse(configuredUrl) : null;
  const shareUrl = parsedUrl?.protocol === 'https:' && !parsedUrl.username && !parsedUrl.password ? parsedUrl.href : undefined;
  const sort = useTableSort({ key: 'voice', direction: 'ascending' });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const scores = new Map<string, Map<string, ArenaCell>>();
  for (const cell of cells) {
    const row = scores.get(cell.voice) ?? new Map<string, ArenaCell>();
    row.set(cell.locale, cell);
    scores.set(cell.voice, row);
  }
  const voices = sort.rows([...scores.keys()].sort((a, b) => a.localeCompare(b)), {
    voice: voice => voice,
    ...Object.fromEntries(locales.map(locale => [locale, (voice: string) => scores.get(voice)?.get(locale)?.score])),
  });
  async function exportScorecard() {
    setExporting(true);
    setExportError('');
    try {
      const { exportArenaWorkbook } = await import('./arenaExcel');
      await exportArenaWorkbook({ voices, locales, cells }, load, domain);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Unexpected workbook export error.');
    } finally {
      setExporting(false);
    }
  }
  return <section className="card arena-card" aria-label={`Arena matrix: ${domain}`}>
    <div className="section-with-action arena-matrix-heading"><h2>{domain}</h2>
      <div className="arena-matrix-actions">
        {shareUrl ? <a className="secondary" href={shareUrl} target="_blank" rel="noopener noreferrer"
          title="Open the published scorecard in a new tab">Share External</a>
          : <button type="button" className="secondary" disabled
            title={configuredUrl ? 'The configured scorecard URL must be an HTTPS URL without credentials.' : 'No public scorecard URL is configured.'}>Share External</button>}
        <button type="button" className="secondary" disabled={!cells.length || exporting}
          onClick={() => void exportScorecard()}>{exporting ? 'Preparing Excel…' : 'Export to Excel'}</button>
      </div>
    </div>
    {exportError && <p role="alert" className="error-text">Excel export failed: {exportError}</p>}
    {new Set(cells.map(cell => cell.comparison)).size > 1 && <p role="status" className="hint">These results use different panels, rubrics or test guides and may not be directly comparable. Inspect the source reports before ranking them.</p>}
    {!voices.length ? <p>No fully assessed scores match these filters.</p> :
      <div className="table-scroll arena-matrix" tabIndex={0} role="region" aria-label={`${domain}: Voice by locale scores`}>
        <table aria-label={`${domain}: Voice by locale scores`}>
          <thead><tr>{sort.header('voice', 'Voice / model')}{locales.map(locale => sort.header(locale, locale, 'descending'))}</tr></thead>
          <tbody>{voices.map(voice => <tr key={voice}><th scope="row">{voice}</th>{locales.map(locale => {
            const cell = scores.get(voice)?.get(locale);
            return <td key={locale}>{cell ? <button type="button" className="arena-score"
              title={`${new Date(cell.createdAt).toLocaleString()} · ${cell.files} files · ${cell.panel} · ${cell.rubric}`}
              aria-label={`${voice}, ${locale}, ${cell.score.toFixed(2)} out of 5. Open detailed report`}
              disabled={busy} onClick={() => onInspect(cell)}>{cell.score.toFixed(2)}</button>
              : <span aria-label="Not tested">—</span>}</td>;
          })}</tr>)}</tbody>
        </table>
      </div>}
  </section>;
}
