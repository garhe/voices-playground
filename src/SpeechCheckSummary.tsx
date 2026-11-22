import type { SpeechCheck } from '../shared/domain';

export function SpeechCheckSummary({ result, requested }: { result?: SpeechCheck; requested: boolean }) {
  if (!result) return requested ? <p className="hint">Azure Speech review check has not completed for this window.</p> : null;
  if (result.status === 'failed') return <div className="callout" role="status">
    <strong>Azure Speech review check failed</strong><p>{result.error}</p>
    <p>These checks are unavailable; the judge scores do not establish script or speaker consistency.</p>
  </div>;
  return <div className="callout">
    <strong>Azure Speech review flags</strong>
    {result.text.status === 'unavailable'
      ? <p>Script comparison unavailable: {result.text.reason}</p>
      : <p>{result.text.missing || result.text.added || result.text.substituted
        ? `Possible differences: ${result.text.missing} missing, ${result.text.added} added, ${result.text.substituted} substituted. First difference near reference word ${result.text.firstReferenceWord}.`
        : 'No text differences detected by speech recognition.'}</p>}
    <p>{result.speaker.status === 'possible_change'
      ? 'Possible speaker change detected.'
      : result.speaker.status === 'no_change_detected'
        ? 'No speaker change detected.'
        : 'Speaker-change check unavailable.'}</p>
    <p className="hint">Review the audio and script. Recognition, formatting, style changes and speaker labeling can cause false alarms or missed defects. These flags do not change scores; no detected difference is not proof of correctness.</p>
  </div>;
}
