import { createContext, useContext, useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { activeDimensions, assessmentGaps, dimensionLabel, dimensions, ISSUE_RATING_THRESHOLD, summarize, type Dimension, type Job, type JudgeResult, type StoredClip, type Summary } from '../shared/domain';
import { AudioPlayer } from './AudioPlayer';
import { DisclosureControls, setDetailsOpen } from './DisclosureControls';

type WindowEvidence = { clip: StoredClip; results: (JudgeResult | undefined)[] };
type FileEvidence = { file: string; windows: WindowEvidence[] };
type ExpansionCommand = { revision: number; open: boolean };
const EvidenceExpansionContext = createContext<ExpansionCommand>({ revision: 0, open: false });
const evidenceKey = ({ voice, role }: Pick<Summary, 'voice' | 'role'>) => JSON.stringify([voice, role]);

export function voiceEvidenceGroups(job: Job) {
  const results = new Map(job.results.map(result => [JSON.stringify([result.clipId, result.judgeId]), result]));
  const groups = new Map<string, { voice: string; role: StoredClip['role']; files: Map<string, FileEvidence> }>();
  for (const clip of job.clips) {
    const key = evidenceKey(clip);
    if (!groups.has(key)) groups.set(key, { voice: clip.voice, role: clip.role, files: new Map() });
    const files = groups.get(key)!.files;
    if (!files.has(clip.file)) files.set(clip.file, { file: clip.file, windows: [] });
    files.get(clip.file)!.windows.push({ clip, results: job.judges.map(judge => results.get(JSON.stringify([clip.id, judge.id]))) });
  }
  return [...groups.values()].sort((a, b) => a.voice.localeCompare(b.voice) || a.role.localeCompare(b.role))
    .map(group => ({ ...group, files: [...group.files.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }))
      .map(file => ({ ...file, windows: file.windows.sort((a, b) => a.clip.start - b.clip.start || a.clip.end - b.clip.end) })) }));
}

function Fold({ label, children, kind }: { label: ReactNode; children: () => ReactNode; kind: string }) {
  const [open, setOpen] = useState(false);
  const expansion = useContext(EvidenceExpansionContext);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (expansion.revision && details.current) details.current.open = expansion.open;
  }, [expansion]);
  return <details ref={details} className={`evidence-branch evidence-${kind}`} onToggle={({ target, currentTarget }) => {
    if (target !== currentTarget) return;
    if (!currentTarget.open) currentTarget.querySelectorAll('audio').forEach(audio => audio.pause());
    setOpen(currentTarget.open);
  }}>
    <summary>{label}</summary>
    {open && <div className="evidence-branch-body">{children()}</div>}
  </details>;
}

function changeExpansion(setExpansion: Dispatch<SetStateAction<ExpansionCommand>>, open: boolean) {
  setExpansion(previous => ({ revision: previous.revision + 1, open }));
}

function VoiceRecordingGroup({ job, voice, role, files, summary, sectionExpansion }: {
  job: Job; voice: string; role: StoredClip['role']; files: FileEvidence[]; summary: Summary | undefined;
  sectionExpansion: ExpansionCommand;
}) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const panelId = `voice-recordings-${useId()}`;
  const pauseAudio = () => content.current?.querySelectorAll('audio').forEach(audio => audio.pause());
  useEffect(() => {
    if (!sectionExpansion.revision) return;
    if (!sectionExpansion.open) pauseAudio();
    setOpen(sectionExpansion.open);
  }, [sectionExpansion]);
  return <EvidenceExpansionContext.Provider value={sectionExpansion}>
    <div className="evidence-voice-group">
      <div className="evidence-voice-row">
        <button type="button" className="evidence-voice-toggle" aria-expanded={open} aria-controls={panelId}
          onClick={() => {
            if (open) pauseAudio();
            setOpen(!open);
          }}>
          <span className="evidence-voice-label"><strong>{voice}</strong>{role !== 'speaker' && ` / ${role}`} · {files.length} audio {files.length === 1 ? 'file' : 'files'} · Voice average: {rating(summary?.score)}</span>
        </button>
      </div>
      <div id={panelId} className="evidence-branch-body evidence-voice-content" ref={content} hidden={!open}>
        {open && <VoiceRecordingList job={job} files={files} />}
      </div>
    </div>
  </EvidenceExpansionContext.Provider>;
}

const windowLabel = (clip: StoredClip) => `${clip.start.toFixed(2)}–${clip.end.toFixed(2)} s · ${clip.channel}`;
const rating = (value: number | null | undefined) => value == null ? 'Not assessed' : `${value.toFixed(2)}/5`;

function JudgeComments({ job, window, dimension, detailed = false }: { job: Job; window: WindowEvidence; dimension: Dimension; detailed?: boolean }) {
  return <ul className="evidence-judge-comments">{job.judges.map((judge, index) => {
    const result = window.results[index];
    const assessment = result?.status === 'completed' ? result.assessment : undefined;
    const cases = detailed ? assessment?.rehearsalCases?.filter(item => item.dimension === dimension) ?? [] : [];
    const gaps = detailed ? assessmentGaps(result, job.profile, window.clip.role) : [];
    return <li key={judge.id}>
      <strong>{judge.name} ({rating(assessment?.scores[dimension])}):</strong>{' '}
      {assessment ? assessment.reasons[dimension]?.trim() || 'No reason saved.' : `No assessment saved (${result?.status ?? 'missing'}).`}
      {(cases.length > 0 || gaps.length > 0) && <details className="evidence-judge-details">
        <summary>Listening cues &amp; assessment details</summary>
        {cases.length > 0 && <ul className="evidence-cases">{cases.map((item, index) => <li key={index}>
          <p><strong>{item.observation}</strong></p>
          <dl><div><dt>Listening cue</dt><dd>{item.cue}</dd></div>
            <div><dt>Adjustment</dt><dd>{item.direction}</dd></div>
            <div><dt>Pass check</dt><dd>{item.check}</dd></div></dl>
        </li>)}</ul>}
        {gaps.length > 0 && <p className="hint">Scoring gaps: {gaps.join(' ')}</p>}
      </details>}
    </li>;
  })}</ul>;
}

const summarizeWindows = (job: Job, windows: WindowEvidence[]) => summarize({
  ...job, clips: windows.map(({ clip }) => clip),
  results: windows.flatMap(({ results }) => results.filter(result => result !== undefined)),
})[0];

const lowestFirst = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? Infinity) - (b ?? Infinity);

export function VoiceFilePlayback({ file }: { file: FileEvidence }) {
  const [selected, setSelected] = useState(file.windows[0].clip.id);
  const playback = useRef<HTMLDivElement>(null);
  const window = file.windows.find(({ clip }) => clip.id === selected) ?? file.windows[0];
  const { clip } = window;
  return <div className="evidence-playback" ref={playback}>
    {file.windows.length > 1 ? <label>Evaluated audio window
      <select value={clip.id} onChange={event => {
        playback.current?.querySelector('audio')?.pause();
        setSelected(event.target.value);
      }}>
        {file.windows.map(({ clip: item }) => <option key={item.id} value={item.id}>{windowLabel(item)}</option>)}
      </select>
    </label> : <small>Evaluated audio · {windowLabel(clip)}</small>}
    <AudioPlayer key={clip.id} preload="none" src={`/api/clips/${clip.id}/audio`} label={`Evaluated audio: ${file.file}, ${windowLabel(clip)}`} />
  </div>;
}

const belowThreshold = (score: number | null | undefined): score is number =>
  score != null && score < ISSUE_RATING_THRESHOLD;
const issueRating = (score: number) => Number(score.toFixed(2)) >= ISSUE_RATING_THRESHOLD
  ? `Below ${ISSUE_RATING_THRESHOLD.toFixed(2)}/5` : rating(score);

export function VoiceTopIssues({ job, files, summary }: { job: Job; files: FileEvidence[]; summary: Summary | undefined }) {
  const issues = activeDimensions(job.profile).flatMap(dimension => {
    const score = summary?.dimensions[dimension];
    return belowThreshold(score) ? [{ dimension, score }] : [];
  }).sort((a, b) => a.score - b.score);
  if (!issues.length) return <p className="hint">No assessed dimension averages below 4.0 / 5.0.</p>;

  const windows = files.flatMap(file => file.windows.map(window => ({
    window, ratings: summarizeWindows(job, [window])?.dimensions,
  })));

  return <table className="evidence-comment-table evidence-top-issues">
    <caption>Top issues · Average below 4.0 / 5.0</caption>
    <thead><tr><th scope="col">Rubric dimension</th><th scope="col">All below-threshold audio &amp; judge comments</th></tr></thead>
    <tbody>{issues.map(({ dimension, score }) => {
      const label = dimensionLabel(job.profile, dimension);
      const examples = windows.flatMap(({ window, ratings }) => {
        const windowScore = ratings?.[dimension];
        return belowThreshold(windowScore) ? [{ window, windowScore }] : [];
      }).sort((a, b) => a.windowScore - b.windowScore);
      return <tr key={dimension}>
        <th scope="row"><strong>{label}</strong><small>{issueRating(score)} voice average</small></th>
        <td>{examples.map(({ window, windowScore }, index) => {
          const { clip } = window;
          const name = clip.file.split(/[\\/]/).at(-1) || clip.file;
          return <div className="evidence-top-example" key={clip.id}>
            <strong>Example {index + 1}: <span title={clip.file}>{name}</span></strong>
            <p className="hint">{issueRating(windowScore)} window average · {windowLabel(clip)}</p>
            <AudioPlayer preload="none" src={`/api/clips/${clip.id}/audio`} label={`${label}: ${name}, ${windowLabel(clip)}`} />
            <JudgeComments job={job} window={window} dimension={dimension} />
          </div>;
        })}{!examples.length && <p className="hint">No evaluated audio window below 4.0 / 5.0 is available for this dimension.</p>}</td>
      </tr>;
    })}</tbody>
  </table>;
}

export function VoiceRecordingList({ job, files }: { job: Job; files: FileEvidence[] }) {
  const recordings = files.map(file => ({ file, score: summarizeWindows(job, file.windows)?.score }))
    .sort((a, b) => lowestFirst(a.score, b.score));
  return <>{recordings.map(({ file, score }) =>
    <Fold kind="file" key={file.file}
      label={<><strong>{file.file}</strong> · Recording average: {rating(score)}</>}>{() =>
      <VoiceRecordingEvidence file={file} />
    }</Fold>
  )}</>;
}

export function VoiceRecordingEvidence({ file }: { file: FileEvidence }) {
  return <VoiceFilePlayback file={file} />;
}

export function VoiceEvidenceTree({ job, compact = false }: { job: Job; compact?: boolean }) {
  const issuesSection = useRef<HTMLElement>(null);
  const [recordingExpansion, setRecordingExpansion] = useState<ExpansionCommand>({ revision: 0, open: false });
  const summaries = new Map(summarize(job).map(summary => [evidenceKey(summary), summary]));
  const groups = voiceEvidenceGroups(job).map(group => ({ ...group, summary: summaries.get(evidenceKey(group)) }))
    .sort((a, b) => lowestFirst(a.summary?.score, b.summary?.score));
  const issueGroups = groups.filter(({ summary }) =>
    activeDimensions(job.profile).some(dimension => belowThreshold(summary?.dimensions[dimension])));
  return <>
    {!!issueGroups.length && <section ref={issuesSection} id="voice-judge-evidence" className={`card voice-evidence evidence-tree${compact ? ' evidence-tree--compact' : ''}`} aria-label="Voice top issues & judge evidence">
      <div className="evidence-section-heading">
        <h2>Voice top issues &amp; judge evidence</h2>
        <DisclosureControls label="Voice top issues & judge evidence" onChange={open => setDetailsOpen(issuesSection.current, open)} />
      </div>
      {issueGroups.map(({ voice, role, files, summary }) => <Fold kind="voice" key={JSON.stringify([job.id, voice, role])}
        label={<><strong>{voice}</strong>{role !== 'speaker' && ` / ${role}`} · {files.length} audio {files.length === 1 ? 'file' : 'files'} · Voice average: {rating(summary?.score)}</>}>{() =>
        <div className="evidence-panel evidence-top-panel"><VoiceTopIssues job={job} files={files} summary={summary} /></div>
      }</Fold>)}
    </section>}
    <section id="all-recordings-per-voice" className={`card voice-evidence evidence-tree${compact ? ' evidence-tree--compact' : ''}`} aria-label="All recordings per voice">
      <div className="evidence-section-heading">
        <h2>All recordings per voice</h2>
        <DisclosureControls label="All recordings per voice" onChange={open => changeExpansion(setRecordingExpansion, open)} />
      </div>
      {job.profile.speakerMode === 'automatic' && <p className="hint">Audio contains the conversation, not an isolated target speaker.</p>}
      {!groups.length && <p>No recordings are available yet.</p>}
      {voiceEvidenceGroups(job).map(({ voice, role, files }) =>
        <VoiceRecordingGroup key={JSON.stringify([job.id, voice, role])} job={job} voice={voice} role={role}
          files={files} summary={summaries.get(evidenceKey({ voice, role }))} sectionExpansion={recordingExpansion} />
      )}
    </section>
  </>;
}
