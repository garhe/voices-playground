import { TTS_ISSUE_THRESHOLD, ttsIssueStatus, type TtsIssueSummary as IssueSummary } from '../shared/ttsIssues';

export function TtsIssueSummary({ voices, onExport }: { voices: IssueSummary[]; onExport?: () => void }) {
  return <section className="card voice-coaching" aria-label="Top TTS issues">
    <div className="section-with-action"><h2>Top TTS issues by voice</h2>
      {onExport && <button className="secondary" onClick={onExport}>Export TTS issues CSV</button>}
    </div>
    <p className="hint">Active scoring dimensions below {TTS_ISSUE_THRESHOLD}/5, lowest first. Scores use fully assessed files only.
      Examples are saved judge observations, not a new evaluation. The cutoff is for review, not a pass/fail standard.</p>
    {!voices.length && <p>No voices to summarize yet.</p>}
    {voices.map(voice => <article key={JSON.stringify([voice.voice, voice.role])}>
      <h3>{voice.voice}{voice.role !== 'speaker' && ` / ${voice.role}`}</h3>
      <p className="hint">{voice.domain && <>Domain: {voice.domain} · </>}{voice.locale && <>Script locale: {voice.locale} · </>}
        {voice.eligibleFiles}/{voice.files} fully assessed audio files</p>
      {!voice.issues.length ? <p>{ttsIssueStatus(voice)}</p> : <ol>
        {voice.issues.map(issue => <li key={issue.dimension}>
          <strong>{issue.label} · {issue.score.toFixed(2)}/5</strong>
          {issue.examples.length ? <ul>{issue.examples.map(example => <li key={example.file}>
            {example.observation}
            <small className="evidence-files">{example.file} · {example.start.toFixed(2)}–{example.end.toFixed(2)}s listening window
              {' · '}{example.judge} ({example.rating.toFixed(2)}/5)
              {example.cue && <> · Cue: {example.cue}</>}
            </small>
          </li>)}</ul> : <p>No specific observation was saved for the low rating.</p>}
        </li>)}
      </ol>}
    </article>)}
  </section>;
}
