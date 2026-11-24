import { activeDimensions, dimensionLabel, eligibleScore, hasScoringSpeaker, ISSUE_RATING_THRESHOLD, summarize, type Dimension, type Job, type SpeechCheck, type StoredClip } from './domain.js';

export const TTS_ISSUE_THRESHOLD = ISSUE_RATING_THRESHOLD;
const PRIORITY_DIMENSIONS = ['articulation', 'pace', 'naturalness'] as const satisfies readonly Dimension[];
type CompletedSpeechCheck = Extract<SpeechCheck, { status: 'completed' }>;
type ActionSupport = { direction: string; judges: Set<string>; windows: Set<string> };

export function speechReviewFlagText(check: CompletedSpeechCheck): string {
  const findings: string[] = [];
  if (check.text.status === 'compared' && (check.text.missing || check.text.added || check.text.substituted)) {
    findings.push(`Possible text differences: ${check.text.missing} missing, ${check.text.added} added, ${check.text.substituted} substituted` +
      (check.text.firstReferenceWord === null ? '' : `; first difference near reference word ${check.text.firstReferenceWord}`));
  }
  if (check.speaker.status === 'possible_change') findings.push('Possible speaker change');
  return findings.join('. ');
}

export function summarizeTtsIssues(job: Job) {
  const domains = activeDimensions(job.profile).map(dimension => ({ dimension, label: dimensionLabel(job.profile, dimension) }));
  const active = domains.map(({ dimension }) => dimension);
  const voiceKey = ({ voice, role }: { voice: string; role: string }) => JSON.stringify([voice, role]);
  const scorecard = new Map(summarize(job).map(voice => [voiceKey(voice), voice]));
  const resultsByClip = new Map<string, Job['results']>();
  const judges = new Map(job.judges.map(judge => [judge.id, judge]));
  for (const result of job.results) {
    if (!resultsByClip.has(result.clipId)) resultsByClip.set(result.clipId, []);
    resultsByClip.get(result.clipId)!.push(result);
  }
  const groups = new Map<string, Map<string, StoredClip[]>>();
  for (const clip of job.clips) {
    const key = voiceKey(clip);
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
    const eligibleClipIds = new Set(eligibleClips.map(clip => clip.id));
    const flagCounts = new Map<Dimension, number>();
    const actionsByDomain = new Map<Dimension, Map<string, ActionSupport>>();
    for (const clip of allClips) {
      const windowFlags = new Map<Dimension, Set<string>>();
      for (const result of resultsByClip.get(clip.id) ?? []) {
        if (result.status !== 'completed' || !judges.has(result.judgeId)) continue;
        for (const { dimension, direction } of result.assessment?.rehearsalCases ?? []) {
          if (!windowFlags.has(dimension)) windowFlags.set(dimension, new Set());
          windowFlags.get(dimension)!.add(result.judgeId);
          if (!active.includes(dimension)) continue;
          const text = direction.trim().replace(/\s+/g, ' ');
          const key = text.toLowerCase().replace(/[.!?]+$/u, '');
          if (!key) continue;
          if (!actionsByDomain.has(dimension)) actionsByDomain.set(dimension, new Map());
          const actions = actionsByDomain.get(dimension)!;
          if (!actions.has(key)) actions.set(key, { direction: text, judges: new Set(), windows: new Set() });
          const action = actions.get(key)!;
          action.judges.add(result.judgeId);
          action.windows.add(clip.id);
        }
      }
      for (const [dimension, flaggedBy] of windowFlags)
        flagCounts.set(dimension, (flagCounts.get(dimension) ?? 0) + flaggedBy.size);
    }
    const recommendedActions = new Map<string, { labels: string[]; direction: string }>();
    const actionOrder = [...domains].sort((a, b) => (flagCounts.get(b.dimension) ?? 0) - (flagCounts.get(a.dimension) ?? 0));
    for (const { dimension, label } of actionOrder) {
      const [top] = [...(actionsByDomain.get(dimension) ?? [])].sort(([, a], [, b]) =>
        b.judges.size - a.judges.size || b.windows.size - a.windows.size || a.direction.localeCompare(b.direction, 'en'));
      if (!top) continue;
      const [key, { direction }] = top;
      const existing = recommendedActions.get(key);
      if (existing) existing.labels.push(label);
      else recommendedActions.set(key, { labels: [label], direction });
    }
    const results = eligibleClips.flatMap(clip => resultsByClip.get(clip.id) ?? []);
    const summary = summarize({ ...job, clips: eligibleClips, results })[0];
    const scoredAssessments = results.flatMap(result => {
      const a = result.assessment;
      return a && result.status === 'completed' && judges.has(result.judgeId) &&
        hasScoringSpeaker(a, job.profile, allClips[0].role) && eligibleScore(a, job.profile) !== null ? [a] : [];
    });
    const priorityFeedback = PRIORITY_DIMENSIONS.flatMap(dimension => {
      const feedback = allClips.flatMap(clip => (resultsByClip.get(clip.id) ?? []).flatMap(result => {
        const { assessment } = result;
        const judge = judges.get(result.judgeId);
        if (result.status !== 'completed' || !judge || !assessment) return [];
        const reason = assessment.reasons[dimension].trim();
        const cases = (assessment.rehearsalCases ?? []).filter(item => item.dimension === dimension)
          .map(({ cue, observation }) => ({ cue, observation }));
        if (!reason && !cases.length) return [];
        return [{
          clipId: clip.id, judgeId: judge.id, file: clip.file, start: clip.start, end: clip.end,
          judge: judge.name, rating: assessment.scores[dimension], reason, cases,
          fullyAssessed: eligibleClipIds.has(clip.id),
        }];
      })).sort((a, b) => Number(!a.cases.length) - Number(!b.cases.length) ||
        (a.rating ?? 6) - (b.rating ?? 6) || a.file.localeCompare(b.file) || a.start - b.start || a.judge.localeCompare(b.judge));
      const score = summary?.dimensions[dimension] ?? null;
      const ratings = { total: 0, belowThreshold: 0 };
      if (score !== null) for (const assessment of scoredAssessments) {
        const rating = assessment.scores[dimension];
        if (rating === null) continue;
        ratings.total++;
        if (rating < TTS_ISSUE_THRESHOLD) ratings.belowThreshold++;
      }
      return feedback.length || (active.includes(dimension) && score !== null && score < TTS_ISSUE_THRESHOLD) ? [{
        dimension, label: dimensionLabel(job.profile, dimension), score,
        includedInScore: active.includes(dimension), feedback, ratings,
      }] : [];
    });
    const speechReview = job.arena ? {
      requested: job.profile.arenaSpeechCheck === true,
      flags: allClips.flatMap(clip => {
        const check = clip.speechCheck;
        return check?.status === 'completed' && speechReviewFlagText(check) ? [{
          clipId: clip.id, file: clip.file, start: clip.start, end: clip.end, check,
          fullyAssessed: eligibleClipIds.has(clip.id),
        }] : [];
      }),
      unavailable: allClips.flatMap(clip => {
        const check = clip.speechCheck;
        if (!check && !job.profile.arenaSpeechCheck) return [];
        const reasons = !check ? ['Check not completed.'] : check.status === 'failed' ? [`Check failed: ${check.error}`] : [
          ...(check.text.status === 'unavailable' ? [`Script comparison unavailable: ${check.text.reason}`] : []),
          ...(check.speaker.status === 'unavailable' ? ['Speaker-change check unavailable.'] : []),
        ];
        return reasons.length ? [{
          clipId: clip.id, file: clip.file, start: clip.start, end: clip.end, reasons,
          fullyAssessed: eligibleClipIds.has(clip.id),
        }] : [];
      }),
    } : undefined;
    const issues = active.flatMap(dimension => {
      const score = summary?.dimensions[dimension];
      if (score == null || score >= TTS_ISSUE_THRESHOLD) return [];
      return [{ dimension, label: dimensionLabel(job.profile, dimension), score, examples: examplesFor(dimension) }];
    }).sort((a, b) => a.score - b.score);
    return {
      voice: allClips[0].voice, role: allClips[0].role, domain: job.arena?.domain, locale: job.arena?.locale,
      files: files.size, eligibleFiles: summary?.eligibleFiles ?? 0,
      assessedDimensions: active.filter(dimension => summary?.dimensions[dimension] != null).length,
      priorityFeedback, speechReview, issues, recommendedActions: [...recommendedActions.values()],
      domainStats: domains.map(domain => ({
        ...domain, flags: flagCounts.get(domain.dimension) ?? 0,
        average: scorecard.get(voiceKey(allClips[0]))?.dimensions[domain.dimension] ?? null,
      })),
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

export function otherTtsIssues(voice: TtsIssueSummary) {
  const prioritized = new Set<Dimension>(voice.priorityFeedback.map(area => area.dimension));
  return voice.issues.filter(issue => !prioritized.has(issue.dimension));
}

export type TtsIssueDetail = {
  reviewType: string; dimension?: string; score?: number | null; file?: string; start?: number; end?: number;
  judge?: string; rating?: number | null; observation?: string; cue?: string; fullyAssessed?: boolean;
};

export function* ttsIssueDetails(voice: TtsIssueSummary): Generator<TtsIssueDetail> {
  if (voice.speechReview) {
    const dimension = 'Azure Speech review';
    if (!voice.speechReview.requested) yield { reviewType: 'speech_not_requested', dimension,
      observation: 'Additional Azure Speech review was not requested for this test.' };
    for (const { file, start, end, check, fullyAssessed } of voice.speechReview.flags) yield {
      reviewType: 'speech_flag', dimension, file, start, end, judge: 'Azure Speech', fullyAssessed,
      observation: speechReviewFlagText(check),
    };
    if (voice.speechReview.requested && !voice.speechReview.flags.length) yield { reviewType: 'speech_no_flags', dimension,
      observation: 'No Speech flags recorded. Unavailable checks do not establish a pass.' };
    for (const { file, start, end, reasons, fullyAssessed } of voice.speechReview.unavailable) yield {
      reviewType: 'speech_unavailable', dimension, file, start, end, judge: 'Azure Speech', fullyAssessed,
      observation: reasons.join(' '),
    };
  }
  for (const area of voice.priorityFeedback) {
    const { label: dimension, score } = area;
    if (!area.feedback.length) yield { reviewType: 'priority_low_average', dimension, score,
      observation: 'No specific judge feedback was saved for this low rating.' };
    for (const { file, start, end, judge, rating, fullyAssessed, cases, reason } of area.feedback) {
      const base = { dimension, score, file, start, end, judge, rating, fullyAssessed };
      for (const detail of cases) yield { ...base, reviewType: 'priority_case', ...detail };
      if (reason) yield { ...base, reviewType: 'priority_feedback', observation: reason };
    }
  }
  for (const issue of otherTtsIssues(voice)) {
    const base = { reviewType: 'low_average', dimension: issue.label, score: issue.score };
    if (!issue.examples.length) yield base;
    for (const example of issue.examples) yield { ...base, ...example, fullyAssessed: true };
  }
}

export function ttsIssueStatus(voice: TtsIssueSummary) {
  if (!voice.assessedDimensions) return 'Insufficient scored evidence';
  return voice.issues.length ? `${voice.issues.length} low-scoring areas` : `No assessed dimension below ${TTS_ISSUE_THRESHOLD}/5`;
}
