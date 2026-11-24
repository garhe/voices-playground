import { claimsMissingAudio, hasScoringSpeaker, resolveLanguageHint, type Job, type StoredClip } from './domain.js';
import { studioVoiceModel } from './studioVoices.js';
import { rankVoiceDescriptors, type DescriptorVote, type VoiceDescriptors } from './voiceDescriptors.js';

function descriptorVotes(job: Job) {
  const votesByClip = new Map<string, VoiceDescriptors[]>();
  const clips = new Map(job.clips.map(clip => [clip.id, clip]));
  for (const result of job.results) {
    const clip = clips.get(result.clipId);
    const assessment = result.assessment;
    if (!clip || result.status !== 'completed' || !assessment?.voiceDescriptors ||
        claimsMissingAudio(assessment) || !hasScoringSpeaker(assessment, job.profile, clip.role)) continue;
    const votes = votesByClip.get(clip.id) ?? [];
    votes.push(assessment.voiceDescriptors);
    votesByClip.set(clip.id, votes);
  }
  return (clips: StoredClip[]): VoiceDescriptors => rankVoiceDescriptors(clips.flatMap(clip =>
    (votesByClip.get(clip.id) ?? []).map((labels): DescriptorVote => ({ file: clip.file, weight: clip.end - clip.start, labels }))));
}

export function voiceDescriptorRows(job: Job) {
  if (!job.collectVoiceDescriptors) return [];
  const rows = new Map<string, { voice: string; model: string; locale: string; role: StoredClip['role']; clips: StoredClip[] }>();
  for (const clip of job.clips) {
    const locale = job.arena?.locale ?? resolveLanguageHint(clip.language, job.profile.language);
    const key = JSON.stringify([clip.voice, locale, clip.role]);
    const group = rows.get(key) ?? { voice: clip.voice, model: studioVoiceModel({ ShortName: clip.voice }), locale, role: clip.role, clips: [] };
    group.clips.push(clip);
    rows.set(key, group);
  }
  const rank = descriptorVotes(job);
  return [...rows].map(([key, { clips, ...row }]) => ({ key, ...row, labels: rank(clips) }));
}
