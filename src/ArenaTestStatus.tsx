import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArenaMetadata, ArenaReport } from '../shared/arena';
import type { Job, TestQueueState } from '../shared/domain';
import { canManageTest, testStatusLabel } from '../shared/history';
import { runningAssessments } from './EvaluationProgress';
import { useTableSort } from './TableSort';
import { arenaReportMatch, type ArenaDetailSelection } from './arenaDetails';

type Props = {
  reports: ArenaReport[];
  reportsLoaded: boolean;
  queue?: TestQueueState;
  queuePanel?: ReactNode;
  filters?: ReactNode;
  selection?: ArenaDetailSelection;
  activity?: { job?: Job; error?: string };
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (reports: Pick<ArenaReport, 'id' | 'name'>[]) => void;
};

function ScriptNames({ arena }: { arena?: ArenaMetadata }) {
  return arena?.scripts.length ? <span className="arena-script-names">
    {arena.scripts.map(script => <span key={script}>{script}.txt</span>)}
  </span> : <>—</>;
}

function ArenaLiveActivity({ name, arena, job, error, queue }: {
  name: string; arena?: ArenaMetadata; job?: Job; error?: string;
  queue: TestQueueState;
}) {
  const sorting = useTableSort();
  const running = sorting.rows(job ? runningAssessments(job) : [], {
    voice: row => row.clip.voice, audio: row => row.clip.file, judge: row => row.judge.name,
  });
  const counts = { completed: 0, pending: 0, running: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const result of job?.results ?? []) counts[result.status]++;
  const other = counts.failed + counts.cancelled + counts.interrupted;
  return <section className="arena-live-activity" aria-label="Live Arena activity">
    <h3>Running now: {name}</h3>
    <p><strong>Test {arena?.scripts.length === 1 ? 'script' : 'scripts'}:</strong> <ScriptNames arena={arena} />
      {arena && <small>Script locale: {arena.locale} · Domain: {arena.domain}</small>}</p>
    {error ? <p role="alert" className="error-text">Live activity refresh failed: {error}. Retrying automatically.</p>
      : !job ? <p role="status">Loading live judge activity…</p>
      : job.status !== 'running' ? <p role="status">This test is no longer running. Updating queue status…</p>
      : <>
        <p><strong>{counts.completed} / {job.results.length} judge assessments completed</strong>
          {' · '}{counts.running} in progress · {counts.pending} pending
          {other > 0 && ` · ${other} failed or stopped`}</p>
        {queue.eta && <p className="hint">
          Current {arena ? 'locale' : 'test'}: {queue.eta.currentMinutes === undefined
            ? (counts.running || counts.pending ? 'estimating…' : 'finishing…')
            : `~${queue.eta.currentMinutes} min left`}
          {' · '}Entire batch: {queue.paused ? 'queue paused' : queue.eta.batchMinutes === undefined
            ? 'estimating…' : `~${queue.eta.batchMinutes} min left`}
          {' · '}At the recent pace; excludes future retries.
        </p>}
        {running.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Active judge assessments"><table>
          <thead><tr>{sorting.header('voice', 'Voice / model')}{sorting.header('audio', 'Audio file')}{sorting.header('judge', 'Judge')}</tr></thead>
          <tbody>{running.map(({ clip, judge }) => <tr key={`${clip.id}:${judge.id}`}>
            <th scope="row">{clip.voice}</th>
            <td>{clip.file}<small>{clip.start.toFixed(2)}–{clip.end.toFixed(2)} s</small></td>
            <td>{judge.name}<small>{judge.deployment}</small></td>
          </tr>)}</tbody>
        </table></div> : <p>No judge is in progress right now. The test may be preparing the next file or saving results.</p>}
      </>}
  </section>;
}

export function ArenaTestStatus({ reports, reportsLoaded, queue, queuePanel, filters, selection, activity, busy, onOpen, onDelete }: Props) {
  const sorting = useTableSort();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectAll = useRef<HTMLInputElement>(null);
  const saved = new Map(reports.map(report => [report.id, report]));
  const activeTest = queue?.active;
  const activeJob = activity?.job && activity.job.id === activeTest?.id && activity.job.arena ? activity.job : undefined;
  const live = [
    ...(queue?.active ? [{ test: queue.active, running: true, position: 0 }] : []),
    ...(queue?.waiting.map((test, index) => ({ test, running: false, position: index + 1 })) ?? []),
  ];
  const liveIds = new Set(live.map(({ test }) => test.id));
  const other = reports.filter(report => !liveIds.has(report.id));
  const eligible = other.filter(canManageTest);
  const eligibleIds = new Set(eligible.map(report => report.id));
  const selected = eligible.filter(report => selectedIds.has(report.id));
  function select(ids: string[], checked: boolean) {
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => eligibleIds.has(id)));
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  const rows = [
    ...live.map(({ test, running, position }) => ({
      id: test.id, name: test.name, report: saved.get(test.id),
      status: running ? 'running' as const : 'queued' as const, position, retry: test.retry, retryCount: test.autoRetryCount,
    })),
    ...other.map(report => ({
      id: report.id, name: report.name, report, position: 0, retry: false, retryCount: undefined,
      status: queue && (report.status === 'running' || report.status === 'queued') ? undefined : report.status,
    })),
  ];
  const scriptsFor = (id: string, report?: ArenaReport) => (id === activeJob?.id ? activeJob?.arena : undefined) ?? report?.arena;
  const matches = rows.map(row => ({ row, match: selection ? arenaReportMatch(row.report, selection) : 'match' as const }));
  const unavailable = matches.filter(item => item.match === 'unavailable').length;
  const filteredRows = matches.filter(item => item.match === 'match').map(item => item.row);
  const eligibleVisible = filteredRows.filter(row => eligibleIds.has(row.id));
  const selectedVisible = eligibleVisible.filter(row => selectedIds.has(row.id)).length;
  const allSelected = eligibleVisible.length > 0 && selectedVisible === eligibleVisible.length;
  const partiallySelected = selectedVisible > 0 && !allSelected;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partiallySelected;
  }, [partiallySelected]);
  const sortedRows = sorting.rows(filteredRows, {
    test: row => row.name, domain: row => row.report && `${row.report.arena.domain} / ${row.report.arena.locale}`,
    status: row => row.status && testStatusLabel({ status: row.status }),
    scripts: row => scriptsFor(row.id, row.report)?.scripts.join(', '),
    created: row => row.report && Date.parse(row.report.createdAt), voices: row => row.report?.eligibleVoices,
  });
  const status = (queue
    ? `${queue.active ? 1 : 0} running · ${queue.waiting.length} queued${queue.paused ? ' · Queue paused' : ''}`
    : 'Loading live queue…') + (reportsLoaded ? ` · ${other.filter(report => report.status === 'completed').length} completed` : '');
  return <section className="card arena-card" aria-label="Arena test status">
    <h2>Arena test status</h2>
    <p role="status">{status}</p>
    {queuePanel}
    {filters && <div className="field-row filter-bar">{filters}</div>}
    <p className="hint">Filters also apply to the voice and locale breakdown below, but not the queue or status counts. By default, running and queued tests appear first. Sorting does not change queue order. Queue positions count Arena tests only; Voices Scoring shares the underlying queue.</p>
    {unavailable > 0 && <p role="alert" className="error-text">{unavailable} {unavailable === 1 ? 'test is' : 'tests are'} omitted because filter metadata is unavailable. Wait for the reports to refresh; if this persists, restart the local app when safe.</p>}
    {queue && activeTest && <ArenaLiveActivity name={activeTest.name} arena={activeJob?.arena ?? saved.get(activeTest.id)?.arena}
      job={activeJob} error={activity?.error} queue={queue} />}
    {!rows.length ? <p>{reportsLoaded && queue ? 'No Arena tests yet.' : 'Waiting for test status…'}</p> :
      <><div className="button-row">
        <button type="button" className="secondary danger" disabled={busy || !selected.length} onClick={() => onDelete(selected.map(({ id, name }) => ({ id, name })))}>Delete selected</button>
        <span role="status">{selected.length} selected{selected.length > selectedVisible ? ' (including hidden tests)' : ''}</span>
        {!!selected.length && <button type="button" className="text-button" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear selection</button>}
      </div>
      {!filteredRows.length ? <p role="status">{unavailable ? 'No confirmed matches; some tests could not be checked.' : 'No tests match the selected filters.'}</p> :
      <div className="table-scroll table-scroll--with-selection arena-reports" tabIndex={0} role="region" aria-label="Arena test list"><table>
        <thead><tr><th scope="col" className="arena-report-select"><input ref={selectAll} type="checkbox"
          aria-label="Select all eligible matching Arena reports" title="Select all eligible matching Arena reports" disabled={busy || !eligibleVisible.length}
          checked={allSelected} onChange={event => select(eligibleVisible.map(row => row.id), event.target.checked)} /></th>
          {sorting.header('test', 'Test')}{sorting.header('domain', 'Domain / locale')}{sorting.header('status', 'Status')}{sorting.header('scripts', 'Scripts')}{sorting.header('created', 'Created', 'descending')}{sorting.header('voices', 'Fully assessed voices', 'descending')}<th scope="col">Report</th></tr></thead>
        <tbody>{sortedRows.map(({ id, name, report, status, position, retry, retryCount }) => <tr key={id}>
          <td className="arena-report-select"><input type="checkbox" aria-label={`Select Arena report ${name}`}
            checked={eligibleIds.has(id) && selectedIds.has(id)} disabled={busy || !eligibleIds.has(id)}
            title={!eligibleIds.has(id) ? 'Only saved reports that are not running or queued can be deleted' : undefined}
            onChange={event => select([id], event.target.checked)} /></td>
          <th scope="row">{name}</th>
          <td>{report ? <>{report.arena.domain}<small>{report.arena.locale}</small></> : '—'}</td>
          <td>{status ? <span className={`status-badge ${status}`}>{testStatusLabel({ status })}</span> : 'Updating status…'}
            {position > 0 && <small>Arena queue #{position}</small>}
            {retry && <small>{retryCount ? `Automatic retry ${retryCount}` : 'Retry'}</small>}
          </td>
          <td><ScriptNames arena={scriptsFor(id, report)} /></td>
          <td>{report ? new Date(report.createdAt).toLocaleString() : '—'}</td>
          <td>{report ? `${report.eligibleVoices} / ${report.voices}` : '—'}</td>
          <td><button className="text-button" disabled={busy} onClick={() => onOpen(id)}>Open report</button></td>
        </tr>)}</tbody>
      </table></div>}</>}
  </section>;
}
