import { activeDimensions, dimensionLabel, eligibleScore, hasScoringSpeaker, summarize, type Dimension, type Job, type StoredClip } from './domain.js';

export const TTS_ISSUE_THRESHOLD = 4;

export function summarizeTtsIssues(job: Job) {
  const active = activeDimensions(job.profile);
  const resultsByClip = new Map<string, Job['results']>();
  const judges = new Map(job.judges.map(judge => [judge.id, judge]));
  for (const result of job.results) {
    if (!resultsByClip.has(result.clipId)) resultsByClip.set(result.clipId, []);
    resultsByClip.get(result.clipId)!.push(result);
  }
  const groups = new Map<string, Map<string, StoredClip[]>>();
  for (const clip of job.clips) {
    const key = JSON.stringify([clip.voice, clip.role]);
    if (!groups.has(key)) groups.set(key, new Map());
    const files = groups.get(key)!;
    if (!files.has(clip.file)) files.set(clip.file, []);
    files.get(clip.file)!.push(clip);
  }
  return [...groups.values()].map(files => {
    const allClips = [...files.values()].flat();
    const eligibleClips = [...files.values()].flatMap(clips => {
      const results = clips.flatMap(clip => resultsByClip.get(clip.id) ?? []);
      return summarize({ ...job, clips, results })[0]?.eligibleFiles ? clips : [];
    });
    const results = eligibleClips.flatMap(clip => resultsByClip.get(clip.id) ?? []);
    const summary = summarize({ ...job, clips: eligibleClips, results })[0];
    const issues = active.flatMap(dimension => {
      const score = summary?.dimensions[dimension];
      if (score == null || score >= TTS_ISSUE_THRESHOLD) return [];
      return [{ dimension, label: dimensionLabel(job.profile, dimension), score, examples: examplesFor(dimension) }];
    }).sort((a, b) => a.score - b.score);
    return {
      voice: allClips[0].voice, role: allClips[0].role, domain: job.arena?.domain, locale: job.arena?.locale,
      files: files.size, eligibleFiles: summary?.eligibleFiles ?? 0,
      assessedDimensions: active.filter(dimension => summary?.dimensions[dimension] != null).length,
      issues,
    };

    function examplesFor(dimension: Dimension) {
      const candidates = eligibleClips.flatMap(clip => (resultsByClip.get(clip.id) ?? []).flatMap(result => {
        const { assessment } = result;
        const judge = judges.get(result.judgeId);
        const rating = assessment?.scores[dimension];
        if (result.status !== 'completed' || !judge || !assessment || rating == null || rating >= TTS_ISSUE_THRESHOLD ||
            !hasScoringSpeaker(assessment, job.profile, clip.role) || eligibleScore(assessment, job.profile) === null) return [];
        const issue = assessment.rehearsalCases?.find(item => item.dimension === dimension);
        const observation = (issue?.observation || assessment.reasons[dimension]).trim();
        return observation ? [{
          file: clip.file, start: clip.start, end: clip.end, judge: judge.name,
          rating, observation, cue: issue?.cue,
        }] : [];
      })).sort((a, b) => a.rating - b.rating || Number(!a.cue) - Number(!b.cue) || a.file.localeCompare(b.file) || a.start - b.start);
      const seen = new Set<string>();
      return candidates.filter(example => {
        if (seen.has(example.file)) return false;
        seen.add(example.file);
        return true;
      }).slice(0, 2);
    }
  });
}

export type TtsIssueSummary = ReturnType<typeof summarizeTtsIssues>[number];

export function ttsIssueStatus(voice: TtsIssueSummary) {
  if (!voice.assessedDimensions) return 'Insufficient scored evidence';
  return voice.issues.length ? `${voice.issues.length} low-scoring areas` : `No assessed dimension below ${TTS_ISSUE_THRESHOLD}/5`;
}
