import {
  activeDimensions, assessmentGaps, dimensionLabel, summarize, summarizeVoiceEvidence,
  type EvidenceNote, type Job,
} from '../shared/domain';
import { AudioPlayer } from './AudioPlayer';
import { summarizeTtsIssues } from '../shared/ttsIssues';
import { TtsIssueSummary } from './TtsIssueSummary';
import { unassessedDescriptor, voiceDescriptorFields, voiceDescriptorKeys } from '../shared/voiceDescriptors';
import { voiceDescriptorRows } from '../shared/voiceDescriptorResults';

const rating = (value: number | null) => value === null ? 'Not assessed' : `${value.toFixed(2)} / 5`;

function Notes({ notes }: { notes: EvidenceNote[] }) {
  return <ul>{notes.map(note => <li key={note.text}>{note.text}
    <small className="evidence-files">Source files: {note.files.join(' · ')}</small>
  </li>)}</ul>;
}

import { useTableSort } from './TableSort';

export function ArenaVoiceReport({ job, voice, busy, onOpen }: {
  job: Job; voice: string; busy: boolean; onOpen: (id: string) => void;
}) {
  const sorting = useTableSort({ key: 'panel', direction: 'ascending' });
  const clips = job.clips.filter(clip => clip.voice === voice && clip.role === 'speaker');
  const selected = { ...job, clips };
  const descriptors = voiceDescriptorRows(selected)[0]?.labels;
  const summary = summarize(selected)[0];
  const evidence = summarizeVoiceEvidence(selected)[0];
  if (!job.arena || !summary || !evidence)
    return <p role="alert">This Arena report has no saved single-speaker evidence for the selected voice.</p>;
  const orderedDimensions = activeDimensions(job.profile).sort((a, b) => {
    const left = summary.dimensions[a], right = summary.dimensions[b];
    return left === null ? right === null ? 0 : 1 : right === null ? -1 : left - right;
  });
  const scoreRows = sorting.rows(orderedDimensions, {
    dimension: dimension => dimensionLabel(job.profile, dimension),
    panel: dimension => summary.dimensions[dimension],
    ...Object.fromEntries(evidence.judges.map(judge => [`judge:${judge.judgeId}`,
      (dimension: typeof orderedDimensions[number]) => judge.dimensions.find(item => item.dimension === dimension)?.score])),
  });
  const files = [...new Set(clips.map(clip => clip.file))].map(file => {
    const fileClips = clips.filter(clip => clip.file === file);
    return { file, clips: fileClips, summary: summarize({ ...selected, clips: fileClips })[0] };
  }).sort((a, b) => {
    const left = a.summary.score, right = b.summary.score;
    return left === null ? right === null ? a.file.localeCompare(b.file) : 1 : right === null ? -1 : left - right;
  });
  return <div className="arena-detail-report">
    <section className="card arena-card" aria-label="Selected voice report">
      <div className="section-with-action"><h2>{voice} · {job.arena.locale}</h2>
        <button className="secondary" disabled={busy} onClick={() => onOpen(job.id)}>Open full test report</button>
      </div>
      <p>{job.arena.domain} · {job.name || 'Arena test'} · {new Date(job.createdAt).toLocaleString()} · {job.status}</p>
      <p><strong>Overall preference: {rating(summary.score)}</strong> · {summary.eligibleFiles}/{summary.files} fully assessed files</p>
      {(job.status !== 'completed' || summary.eligibleFiles !== summary.files) &&
        <p role="status" className="hint">Incomplete coverage. This report is not currently eligible for the scorecard; any displayed averages use eligible files only.</p>}
      <p className="hint">Saved rubric: {job.profile.rubric?.name ?? job.rubric}. Panel: {job.judges.map(judge => `${judge.name} (${judge.deployment})`).join(', ')}.</p>
      <p className="hint">Scores are uncalibrated AI opinions, not MOS. Lowest scores are shown first, not an absolute failure threshold. These are saved assessments, not a new AI evaluation. Judges hear audio only; script omissions and text accuracy are not checked.</p>
    </section>
    {descriptors && <section className="card arena-card" aria-label="Top voice descriptors">
      <h2>Top voice descriptors</h2>
      <p className="hint">One best-fit label per category from the saved listening results. Perceived age describes the synthetic voice, not a person’s actual age.</p>
      <dl className="arena-voice-descriptors">{voiceDescriptorKeys.map(key => <div key={key}>
        <dt>{voiceDescriptorFields[key].label}</dt><dd>{descriptors[key] ?? unassessedDescriptor}</dd>
      </div>)}</dl>
    </section>}
    {job.profile.stage === 'tts' && <TtsIssueSummary voices={summarizeTtsIssues(selected)} />}
    <section className="card arena-card" aria-label="Dimension breakdown">
      <h2>Dimension breakdown</h2>
      <p className="hint">Full-panel averages use the same duration-weighted windows and equal-weight files as the scorecard. Each judge column is a single-judge average, not panel consensus. Missing ratings are not zero.</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Dimension scores"><table>
        <caption>{voice} · {job.arena.locale} · scores out of 5</caption>
        <thead><tr>{sorting.header('dimension', 'Dimension')}{sorting.header('panel', 'Full panel')}
          {job.judges.map(judge => sorting.header(`judge:${judge.id}`, <>{judge.name}<small>{judge.deployment}</small></>))}
        </tr></thead>
        <tbody>{scoreRows.map(dimension => <tr key={dimension}>
          <th scope="row"><a href={`#arena-dimension-${dimension}`}>{dimensionLabel(job.profile, dimension)}</a></th>
          <td>{rating(summary.dimensions[dimension])}</td>
          {evidence.judges.map(judge => <td key={judge.judgeId}>{rating(judge.dimensions.find(item => item.dimension === dimension)?.score ?? null)}</td>)}
        </tr>)}</tbody>
      </table></div>
    </section>
    <section className="card arena-card" aria-label="Low score evidence">
      <h2>Why these scores · defects &amp; improvements</h2>
      <p className="hint">Dimensions are ordered from lowest to highest. Original judge reasons stay separate; comments may include excluded files. Check each source file and its scoring gaps below. No precise defect timestamp is inferred from a window-level comment.</p>
      {orderedDimensions.map((dimension, index) => <details id={`arena-dimension-${dimension}`} key={dimension} open={index === 0}>
        <summary><strong>{dimensionLabel(job.profile, dimension)}</strong> · {rating(summary.dimensions[dimension])}</summary>
        {evidence.judges.map((judge, judgeIndex) => {
          const item = judge.dimensions.find(item => item.dimension === dimension);
          return <article key={judge.judgeId}>
            <h3>{job.judges[judgeIndex].name} · {rating(item?.score ?? null)}</h3>
            <h4>Original reasons</h4>
            {item?.reasons.length ? <Notes notes={item.reasons} /> : <p>No scored reason saved for this dimension.</p>}
            <h4>Defects &amp; improvements</h4>
            {item?.improvements.length ? <Notes notes={item.improvements} /> : <p>No specific improvement case was saved. This does not establish a perfect performance.</p>}
          </article>;
        })}
      </details>)}
    </section>
    <section className="card arena-card" aria-label="Recording breakdown">
      <h2>Recording breakdown · lowest first</h2>
      <p className="hint">Expand a file to locate lower-scoring listening windows, read each judge’s original evidence and play the exact evaluated audio. Times are source-file window boundaries, not exact defect locations.</p>
      {files.map(file => <details key={file.file}>
        <summary><strong>{file.file}</strong> · {rating(file.summary.score)} · {file.clips.length} listening windows</summary>
        {file.clips.map(clip => <article className="arena-recording-window" key={clip.id}>
          <h3>{clip.start.toFixed(1)}–{clip.end.toFixed(1)}s · {clip.channel}</h3>
          <AudioPlayer src={`/api/clips/${clip.id}/audio`} label={`${voice}, ${job.arena!.locale}, ${clip.file}, ${clip.start} to ${clip.end} seconds`} />
          {job.judges.map(judge => {
            const result = job.results.find(item => item.clipId === clip.id && item.judgeId === judge.id);
            const gaps = assessmentGaps(result, job.profile, clip.role);
            return <details key={judge.id}>
              <summary>{judge.name} · {result?.status ?? 'missing'}{gaps.length > 0 && ' · scoring gaps'}</summary>
              {!!gaps.length && <ul className="error-text">{gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
              {result?.assessment && <dl>{orderedDimensions.map(dimension => <div key={dimension}>
                <dt><strong>{dimensionLabel(job.profile, dimension)} · {rating(result.assessment!.scores[dimension])}</strong></dt>
                <dd>{result.assessment!.reasons[dimension] || 'No reason saved.'}</dd>
              </div>)}</dl>}
            </details>;
          })}
        </article>)}
      </details>)}
    </section>
    <section className="card arena-card" aria-label="Judge limitations and gaps">
      <h2>Scoring gaps &amp; limitations</h2>
      {evidence.judges.map((judge, index) => <details key={judge.judgeId} open={judge.gaps.length > 0}>
        <summary>{job.judges[index].name} · {judge.scoredFiles}/{summary.files} files scored by this judge</summary>
        <h3>Scoring gaps</h3>{judge.gaps.length ? <Notes notes={judge.gaps} /> : <p>No scoring gaps reported.</p>}
        <h3>Limitations</h3>{judge.limitations.length ? <Notes notes={judge.limitations} /> : <p>No limitations saved.</p>}
        <h3>Observations</h3>{judge.observations.length ? <Notes notes={judge.observations} /> : <p>No observations saved.</p>}
      </details>)}
    </section>
  </div>;
}
