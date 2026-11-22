import {
  activeDimensions, dimensionLabel, summarize, summarizeVoiceEvidence,
  type EvidenceNote, type Job,
} from '../shared/domain';
import { VoiceEvidenceTree } from './VoiceEvidenceTree';
import { TtsDetailsExport } from './TtsDetailsExport';
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
  const speechFlags = clips.filter(clip => {
    const check = clip.speechCheck;
    return check?.status === 'completed' && (check.speaker.status === 'possible_change' ||
      (check.text.status === 'compared' && !!(check.text.missing || check.text.added || check.text.substituted)));
  }).length;
  const speechUnavailable = clips.filter(clip => {
    const check = clip.speechCheck;
    return !check || check.status === 'failed' || check.text.status === 'unavailable' || check.speaker.status === 'unavailable';
  }).length;
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
  return <div className="arena-detail-report">
    <section className="card arena-card" aria-label="Selected voice report">
      <div className="section-with-action"><h2>{voice} · {job.arena.locale}</h2>
        <div className="button-row">
          {job.profile.stage === 'tts' && <TtsDetailsExport job={selected} />}
          <button className="secondary" disabled={busy} onClick={() => onOpen(job.id)}>Open full test report</button>
        </div>
      </div>
      <p>{job.arena.domain} · {job.name || 'Arena test'} · {new Date(job.createdAt).toLocaleString()} · {job.status}</p>
      <p><strong>Overall preference: {rating(summary.score)}</strong> · {summary.eligibleFiles}/{summary.files} fully assessed files</p>
      {(job.status !== 'completed' || summary.eligibleFiles !== summary.files) &&
        <p role="status" className="hint">Incomplete coverage. This report is not currently eligible for the scorecard; any displayed averages use eligible files only.</p>}
      <p className="hint">Saved rubric: {job.profile.rubric?.name ?? job.rubric}. Panel: {job.judges.map(judge => `${judge.name} (${judge.deployment})`).join(', ')}.</p>
      <p className="hint">Scores are uncalibrated AI opinions, not MOS. Lowest scores are shown first, not an absolute failure threshold. These are saved assessments, not a new AI evaluation. When a reference is available, judges can compare it with the audio; their findings are not independently guaranteed.</p>
      {job.profile.arenaSpeechCheck && <p role="status">Azure Speech review: {speechFlags} window(s) flagged; {speechUnavailable} window(s) have an incomplete or unavailable check. See the detailed export for the flags. They do not change scores.</p>}
    </section>
    {descriptors && <section className="card arena-card" aria-label="Top voice descriptors">
      <h2>Top voice descriptors</h2>
      <p className="hint">One best-fit label per category from the saved listening results. Perceived age describes the synthetic voice, not a person’s actual age.</p>
      <dl className="arena-voice-descriptors">{voiceDescriptorKeys.map(key => <div key={key}>
        <dt>{voiceDescriptorFields[key].label}</dt><dd>{descriptors[key] ?? unassessedDescriptor}</dd>
      </div>)}</dl>
    </section>}
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
    <VoiceEvidenceTree job={selected} />
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
