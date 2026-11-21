import { useState } from 'react';
import { useTableSort } from './TableSort';
import type { ArenaCell } from '../shared/arena';
import { ARENA_RUBRIC, dimensionLabel, dimensions } from '../shared/domain';
import { arenaDetailKey, arenaVoiceName } from './arenaDetails';
import { unassessedDescriptor, voiceDescriptorFields, voiceDescriptorKeys } from '../shared/voiceDescriptors';

export type ArenaComparisonView = 'scores' | 'descriptors';

export function ArenaDimensionComparison({ cells, busy, onInspect, loadingDimensions, dimensionError, view = 'scores' }: {
  cells: ArenaCell[]; busy: boolean; onInspect: (cell: ArenaCell) => void; loadingDimensions?: boolean; dimensionError?: string; view?: ArenaComparisonView;
}) {
  const sorting = useTableSort({ key: 'overall', direction: 'descending' });
  const descriptorSorting = useTableSort({ key: 'voice', direction: 'ascending' });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const descriptors = view === 'descriptors';
  const sort = descriptors ? descriptorSorting : sorting;
  const baseline = [...cells].sort((a, b) =>
    a.locale.localeCompare(b.locale) || arenaVoiceName(a.voice).localeCompare(arenaVoiceName(b.voice)) ||
    a.model.localeCompare(b.model) || a.voice.localeCompare(b.voice) || a.domain.localeCompare(b.domain));
  const rows = sort.rows(baseline, {
    voice: cell => arenaVoiceName(cell.voice), model: cell => cell.model, locale: cell => cell.locale,
    gender: cell => cell.gender, overall: cell => cell.score, domain: cell => cell.domain,
    ...Object.fromEntries(dimensions.map(dimension => [dimension, (cell: ArenaCell) => cell.dimensionScores?.find(item => item.dimension === dimension)?.score])),
    ...Object.fromEntries(voiceDescriptorKeys.map(key => [`descriptor:${key}`, (cell: ArenaCell) => cell.voiceDescriptors?.[key]])),
  });
  const hasOlderData = rows.some(cell => !cell.dimensionScores);
  const multipleDomains = new Set(rows.map(cell => cell.domain)).size > 1;
  async function exportComparison() {
    setExporting(true);
    setExportError('');
    try {
      const { exportArenaComparison } = await import('./arenaExcel');
      await exportArenaComparison(rows, view);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Unexpected workbook export error.');
    } finally {
      setExporting(false);
    }
  }
  return <>
    <div className="button-row">
      <button type="button" className="secondary"
        disabled={!rows.length || exporting || (!descriptors && hasOlderData && loadingDimensions)}
        onClick={() => void exportComparison()}>{exporting ? 'Preparing Excel…' : 'Export to Excel'}</button>
    </div>
    {exportError && <p role="alert" className="error-text">Excel export failed: {exportError}</p>}
    {descriptors && <p className="hint">One best-fit label per category, even when judges tie. Older tests without labels show “Not collected.”</p>}
    {!descriptors && hasOlderData && (dimensionError ? <p role="alert" className="error-text">Could not load saved dimension scores: {dimensionError} Retrying automatically.</p>
      : <p role="status" className="hint">{loadingDimensions ? 'Loading dimension scores from saved Arena reports…'
        : 'Some dimension scores are unavailable. Open Details to inspect the source report.'}</p>)}
    {!descriptors && new Set(rows.map(cell => cell.comparison)).size > 1 &&
      <p className="hint">These runs use different panels, rubrics, or test guides. Scores may not be directly comparable.</p>}
    <div className="table-scroll arena-dimension-comparison" tabIndex={0} role="region" aria-label={descriptors ? 'Voice descriptor comparison' : 'Dimension comparison scores'}>
      <table aria-label={descriptors ? 'Top voice descriptors' : 'Full-panel scores out of 5'}>
        <thead><tr>{sort.header('voice', 'Voice')}{sort.header('model', 'Model')}{sort.header('locale', 'Script locale')}{sort.header('gender', 'Gender')}
          {descriptors ? voiceDescriptorKeys.map(key => sort.header(`descriptor:${key}`, voiceDescriptorFields[key].label)) : <>
            {sort.header('overall', 'Overall preference', 'descending')}
            {dimensions.map(dimension => sort.header(dimension, dimensionLabel({ rubric: ARENA_RUBRIC }, dimension), 'descending'))}
          </>}
          {multipleDomains && sort.header('domain', 'Domain')}<th scope="col">Report</th>
        </tr></thead>
        <tbody>{rows.map(cell => <tr key={arenaDetailKey(cell)}>
          <th scope="row" title={cell.voice}>{arenaVoiceName(cell.voice)}</th><td>{cell.model}</td><td>{cell.locale}</td>
          <td>{cell.gender}</td>
          {descriptors ? voiceDescriptorKeys.map(key => <td key={key}>{cell.voiceDescriptors ? cell.voiceDescriptors[key] ?? unassessedDescriptor : 'Not collected'}</td>) : <>
            <td><strong>{cell.score.toFixed(2)}</strong></td>
            {dimensions.map(dimension => {
            const value = cell.dimensionScores?.find(item => item.dimension === dimension);
            return <td key={dimension} title={value?.label}>{!cell.dimensionScores ? loadingDimensions ? 'Loading…' : 'Unavailable' : value?.score == null ? 'Not assessed' : value.score.toFixed(2)}</td>;
            })}
          </>}
          {multipleDomains && <td>{cell.domain}</td>}
          <td><button className="text-button" disabled={busy} aria-label={`Details for ${cell.voice}, ${cell.model}, script locale ${cell.locale}${multipleDomains ? `, ${cell.domain}` : ''}`} onClick={() => onInspect(cell)}>Details</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}
