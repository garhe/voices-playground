import { useState } from 'react';
import type { Job } from '../shared/domain';
import { summarizeTtsIssues } from '../shared/ttsIssues';

export function TtsDetailsExport({ job }: { job: Job }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  async function exportDetails() {
    setError('');
    setExporting(true);
    try {
      const { exportTtsDetailsWorkbook } = await import('./arenaExcel');
      await exportTtsDetailsWorkbook(summarizeTtsIssues(job), job.id);
    } catch (cause) {
      setError(`Could not export the detailed report: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  }

  return <div>
    <button type="button" className="secondary" disabled={exporting || !job.clips.length}
      onClick={() => void exportDetails()}>{exporting ? 'Preparing Excel…' : 'Export detailed report (.xlsx)'}</button>
    {error && <p role="alert" className="error-text">{error}</p>}
  </div>;
}
