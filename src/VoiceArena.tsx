import { useEffect, useRef, useState, type ReactNode } from 'react';
import { arenaData, type ArenaCell, type ArenaData, type ArenaReport } from '../shared/arena';
import { voiceGenders, type Job, type TestQueueState } from '../shared/domain';
import { startPolling } from './polling';
import { ArenaVoiceReport } from './ArenaVoiceReport';
import { ArenaTestStatus } from './ArenaTestStatus';
import { ArenaDimensionComparison, type ArenaComparisonView } from './ArenaDimensionComparison';
import { MultiFilter } from './MultiFilter';
import { ArenaScoreMatrix } from './ArenaScoreMatrix';
import { filterValues, matchesFilter } from '../shared/filterSelection';
import { arenaDetailKey, arenaDetailMatches, arenaDetailOptions, arenaDetailSelectionForCell, type ArenaDetailSelection } from './arenaDetails';

type Request = <T>(url: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;
export type ArenaPage = 'new' | 'scorecard' | 'details';
export function VoiceArena({ active, page = 'scorecard', request, busy, onOpen, onPageChange, newTest, queue, onDelete, deletedIds }: {
  active: boolean; page?: ArenaPage; request: Request; busy: boolean; queue?: TestQueueState;
  onOpen: (id: string) => void; onPageChange?: (page: ArenaPage) => void; newTest?: ReactNode;
  onDelete: (reports: Pick<ArenaReport, 'id' | 'name'>[]) => void;
  deletedIds: ReadonlySet<string>;
}) {
  const [loadedData, setData] = useState<ArenaData>();
  const data = {
    cells: loadedData?.cells.filter(cell => !deletedIds.has(cell.jobId)) ?? [],
    reports: loadedData?.reports.filter(report => !deletedIds.has(report.id)) ?? [],
  };
  const [pollError, setPollError] = useState('');
  const [domainFilter, setDomain] = useState<string[]>([]);
  const [language, setLanguage] = useState<string[]>([]);
  const [model, setModel] = useState<string[]>([]);
  const [gender, setGender] = useState<string[]>([]);
  const [comparisonView, setComparisonView] = useState<ArenaComparisonView>('scores');
  const [selectedDetail, setDetailSelection] = useState<ArenaDetailSelection>({ domain: [], voice: [], model: [], locale: [] });
  const [inspectedKey, setInspectedKey] = useState<string>();
  const reportTarget = useRef<HTMLDivElement>(null);
  const [detailJob, setDetailJob] = useState<Job>();
  const [detailError, setDetailError] = useState('');
  const [dimensionSources, setDimensionSources] = useState<Record<string, ArenaCell[]>>({});
  const [dimensionError, setDimensionError] = useState('');
  const [activity, setActivity] = useState<{ id: string; job?: Job; error?: string }>();
  const activeTestId = active && page === 'details' ? queue?.active?.id : undefined;
  useEffect(() => {
    setActivity(undefined);
    if (!activeTestId) return;
    return startPolling(signal => request<Job>(`/api/jobs/${activeTestId}`, undefined, 'GET', signal),
      job => setActivity({ id: activeTestId, job }),
      error => setActivity({ id: activeTestId, error: error instanceof Error ? error.message : 'Unexpected Arena activity error.' }));
  }, [activeTestId, request]);
  useEffect(() => {
    if (!active || page === 'new') return;
    return startPolling(signal => request<ArenaData>('/api/arena', undefined, 'GET', signal),
      value => { setData(value); setPollError(''); },
      error => setPollError(error instanceof Error ? error.message : 'Unexpected Arena error.'), 3000);
  }, [active, page, request, deletedIds]);
  const legacySourceIds = JSON.stringify([...new Set(data.cells.filter(cell => !cell.dimensionScores).map(cell => cell.jobId))].sort());
  useEffect(() => {
    setDimensionSources(previous => {
      const ids: string[] = JSON.parse(legacySourceIds);
      return Object.fromEntries(ids.filter(id => previous[id]).map(id => [id, previous[id]]));
    });
  }, [legacySourceIds]);
  const pendingDimensionIds = JSON.stringify(active && page === 'details'
    ? [...new Set(data.cells.filter(cell => !cell.dimensionScores && !dimensionSources[cell.jobId]).map(cell => cell.jobId))].sort()
    : []);
  useEffect(() => {
    setDimensionError('');
    const ids: string[] = JSON.parse(pendingDimensionIds);
    if (!ids.length) return;
    return startPolling(signal => Promise.allSettled(ids.map(async id => {
      const job = await request<Job>(`/api/jobs/${id}`, undefined, 'GET', signal);
      if (job.id !== id || !job.arena || job.status !== 'completed')
        throw new Error('A saved Arena source report is not complete or no longer matches.');
      return [id, arenaData([job]).cells] as const;
    })), results => {
      const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (loaded.length) setDimensionSources(previous => ({ ...previous, ...Object.fromEntries(loaded) }));
      const failure = results.find(result => result.status === 'rejected');
      setDimensionError(failure ? (failure.reason instanceof Error ? failure.reason.message : 'Could not load the saved Arena source report.') : '');
    }, error => setDimensionError(error instanceof Error ? error.message : 'Could not load the saved Arena source reports.'), 3000);
  }, [pendingDimensionIds, request]);
  const domains = [...new Set([...data.cells.map(cell => cell.domain), ...data.reports.map(report => report.arena.domain)])].sort();
  const scoreDomains = domains.filter(domain => matchesFilter(domainFilter, selected => selected === domain));
  const scoreOptions = arenaDetailOptions(data.cells.filter(cell => scoreDomains.includes(cell.domain)));
  const detailDomainCells = data.cells.filter(cell => matchesFilter(selectedDetail.domain, domain => cell.domain === domain));
  const detailOptions = arenaDetailOptions(detailDomainCells);
  const matchingCells = arenaDetailMatches(detailDomainCells, selectedDetail);
  const comparisonCells = matchingCells.map(cell => {
    if (cell.dimensionScores) return cell;
    const source = dimensionSources[cell.jobId]?.find(candidate => arenaDetailKey(candidate) === arenaDetailKey(cell));
    return source?.dimensionScores ? { ...cell, dimensionScores: source.dimensionScores } : cell;
  });
  const selectedCell = matchingCells.length === 1 ? matchingCells[0] : matchingCells.find(cell => arenaDetailKey(cell) === inspectedKey);
  const updateDetail = (change: Partial<ArenaDetailSelection>) => {
    setDetailSelection({ ...selectedDetail, ...change, identity: undefined });
    setInspectedKey(undefined);
  };
  const detailJobId = selectedCell?.jobId;
  useEffect(() => {
    setDetailJob(undefined); setDetailError('');
    if (!active || page !== 'details' || !detailJobId) return;
    return startPolling(signal => request<Job>(`/api/jobs/${detailJobId}`, undefined, 'GET', signal),
      value => { setDetailJob(value); setDetailError(''); },
      error => setDetailError(error instanceof Error ? error.message : 'Unexpected report error.'), 3000);
  }, [active, page, detailJobId, request]);
  const scoreCells = arenaDetailMatches(data.cells, { domain: domainFilter, locale: language, model, gender, voice: [] });
  return <section className="voice-arena" aria-label="Voice Arena">
    <div hidden={page !== 'new'}>
      <div className="page-title"><h1>New Arena test</h1></div>
      {newTest}
    </div>
    <div hidden={page !== 'scorecard'}>
      <div className="page-title"><h1>Arena scorecard</h1></div>
      <p>Compare each voice and model across content languages, dialects and accents. Each domain has its own matrix.</p>
      {pollError && <p role="alert" className="error-text">Matrix refresh failed: {pollError}. Retrying automatically.</p>}
      <section className="card arena-card" aria-label="Arena scorecard filters">
        <h2>Voice × language / accent</h2>
        <p className="hint">Overall preference, 1–5. Each cell uses the newest fully assessed test for that voice/model, locale and domain. Incomplete newer tests do not replace a score. Click a score to inspect voice/locale details.</p>
        <div className="field-row filter-bar">
          <MultiFilter label="Domain" all="All domains" options={domains} value={domainFilter} onChange={setDomain} />
          <MultiFilter label="Language / accent" all="All languages / accents" options={scoreOptions.locales} value={language} onChange={setLanguage} searchable />
          <MultiFilter label="Voice model" all="All models" options={scoreOptions.models} value={model} onChange={setModel} />
          <MultiFilter label="Gender" all="All genders" options={voiceGenders} value={gender} onChange={setGender} />
        </div>
        {!scoreDomains.length && <p>No matching domains. Use New test to populate the scorecard or clear the domain filter.</p>}
      </section>
      {scoreDomains.map(domain => <ArenaScoreMatrix key={domain} domain={domain} busy={busy}
        cells={scoreCells.filter(cell => cell.domain === domain)}
        locales={[...new Set(data.cells.filter(cell => cell.domain === domain && matchesFilter(language, locale => cell.locale === locale)).map(cell => cell.locale))].sort()}
        load={id => request<Job>(`/api/jobs/${id}`, undefined, 'GET', AbortSignal.timeout(15_000))}
        onInspect={cell => {
          setDetailSelection(arenaDetailSelectionForCell(cell));
          setInspectedKey(arenaDetailKey(cell));
          if (onPageChange) onPageChange('details');
          else onOpen(cell.jobId);
        }} />)}
    </div>
    <div hidden={page !== 'details'}>
      <div className="page-title"><h1>Arena detailed reports</h1></div>
      {pollError && <p role="alert" className="error-text">Report list refresh failed: {pollError}. Retrying automatically.</p>}
      {page === 'details' && <ArenaTestStatus reports={data.reports} reportsLoaded={!!loadedData} queue={queue}
        activity={activity?.id === activeTestId ? activity : undefined} busy={busy} onOpen={onOpen} onDelete={onDelete} />}
      <section className="card arena-card" aria-label="Detailed report selection">
        <h2>Voice and locale breakdown</h2>
        <div className="field-row filter-bar">
          <MultiFilter label="Report domain" all="All domains" value={filterValues(selectedDetail.domain)} options={domains} onChange={domain => updateDetail({ domain })} />
          <MultiFilter label="Voice" all="All voices" value={filterValues(selectedDetail.voice)} options={detailOptions.voices} onChange={voice => updateDetail({ voice })} searchable />
          <MultiFilter label="Model" all="All models" value={filterValues(selectedDetail.model)} options={detailOptions.models} onChange={model => updateDetail({ model })} />
          <MultiFilter label="Script locale" all="All script locales" value={filterValues(selectedDetail.locale)} options={detailOptions.locales} onChange={locale => updateDetail({ locale })} searchable />
          <MultiFilter label="Gender" all="All genders" value={filterValues(selectedDetail.gender)} options={detailOptions.genders} onChange={gender => updateDetail({ gender })} />
          <label>Comparison view<select value={comparisonView} onChange={event => setComparisonView(event.target.value === 'descriptors' ? 'descriptors' : 'scores')}>
            <option value="scores">Scores</option><option value="descriptors">Voice descriptors</option>
          </select></label>
        </div>
        {page === 'details' && matchingCells.length > 0 && <ArenaDimensionComparison cells={comparisonCells} busy={busy} view={comparisonView}
          loadingDimensions={pendingDimensionIds !== '[]' && !dimensionError} dimensionError={dimensionError} onInspect={cell => {
          setInspectedKey(arenaDetailKey(cell));
          reportTarget.current?.focus({ preventScroll: true });
          reportTarget.current?.scrollIntoView({ block: 'start' });
        }} />}
      </section>
      <div ref={reportTarget} tabIndex={-1} role="region" aria-label="Selected combination details">
        {!loadedData ? <p role="status">Loading voice breakdowns…</p> :
          !detailDomainCells.length ? <p>No fully assessed report for the selected domains. Run a test or check the test status list above.</p> :
          !matchingCells.length ? <p role="status">No fully assessed report matches the selected filters. Change a filter or open a full report from the test status list.</p> :
          !selectedCell ? <p>Select Details in the comparison table to inspect an individual combination.</p> :
          detailError ? <p role="alert" className="error-text">Detailed report refresh failed: {detailError}. Retrying automatically.</p> :
          !detailJob || detailJob.id !== detailJobId ? <p role="status">Loading detailed report…</p> :
          <ArenaVoiceReport key={JSON.stringify([detailJob.id, arenaDetailKey(selectedCell)])} job={detailJob} voice={selectedCell.voice} busy={busy} onOpen={onOpen} />}
      </div>
    </div>
  </section>;
}
