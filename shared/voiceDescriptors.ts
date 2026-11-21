import { z } from 'zod';

export const voiceDescriptorFields = {
  speakingStyle: { label: 'Speaking style', choices: ['Conversational', 'Professional', 'Narrative', 'Expressive', 'Formal'], guidance: 'Dominant audible style of delivery.' },
  tone: { label: 'Tone', choices: ['Warm', 'Friendly', 'Authoritative', 'Calm', 'Empathetic', 'Confident', 'Neutral'], guidance: 'Dominant audible emotional color or attitude.' },
  energyLevel: { label: 'Energy level', choices: ['Low', 'Moderate', 'High', 'Very high'], guidance: 'Audible intensity and animation, not recording volume.' },
  speakingPace: { label: 'Speaking pace', choices: ['Slow', 'Moderate', 'Fast'], guidance: 'Perceived speed relative to idiomatic delivery in the audible language.' },
  expressiveness: { label: 'Expressiveness', choices: ['Flat', 'Neutral', 'Expressive', 'Highly expressive'], guidance: 'Amount of audible variation in pitch, stress and phrasing.' },
  perceivedAgeGroup: { label: 'Perceived age group', choices: ['Young adult', 'Adult', 'Mature adult', 'Senior'], guidance: 'Perceived age of the voice persona, never actual age or identity.' },
  voicePersona: { label: 'Voice persona', choices: ['Approachable guide', 'Reassuring helper', 'Professional advisor', 'Trusted narrator', 'Energetic presenter', 'Neutral announcer'], guidance: 'Overall impression of the voice based on its sound and delivery.' },
  domainSuitability: { label: 'Domain suitability', choices: ['Customer service', 'Storytelling', 'Education', 'News', 'Audiobooks', 'Advertising', 'Voice assistant'], guidance: 'Best use case suggested by the delivery; do not infer it from the script topic or copy the test domain.' },
} as const;

export type Descriptor = keyof typeof voiceDescriptorFields;
export const voiceDescriptorKeys = Object.keys(voiceDescriptorFields) as Descriptor[];
const labels = <T extends readonly [string, ...string[]]>(choices: T) => z.enum(choices).nullable();
export const voiceDescriptorsSchema = z.object({
  speakingStyle: labels(voiceDescriptorFields.speakingStyle.choices),
  tone: labels(voiceDescriptorFields.tone.choices),
  energyLevel: labels(voiceDescriptorFields.energyLevel.choices),
  speakingPace: labels(voiceDescriptorFields.speakingPace.choices),
  expressiveness: labels(voiceDescriptorFields.expressiveness.choices),
  perceivedAgeGroup: labels(voiceDescriptorFields.perceivedAgeGroup.choices),
  voicePersona: labels(voiceDescriptorFields.voicePersona.choices),
  domainSuitability: labels(voiceDescriptorFields.domainSuitability.choices),
}).strict();
export type VoiceDescriptors = z.infer<typeof voiceDescriptorsSchema>;

export type DescriptorVote = { file: string; weight: number; labels: VoiceDescriptors };
export const unassessedDescriptor = 'Not assessable';

export function rankVoiceDescriptors(votes: DescriptorVote[]): VoiceDescriptors {
  function winner<K extends Descriptor>(key: K): VoiceDescriptors[K] {
    const files = new Map<string, Map<VoiceDescriptors[K], number>>();
    for (const vote of votes) {
      const label = vote.labels[key];
      if (label === null || vote.weight <= 0) continue;
      const file = files.get(vote.file) ?? new Map<VoiceDescriptors[K], number>();
      file.set(label, (file.get(label) ?? 0) + vote.weight);
      files.set(vote.file, file);
    }
    const totals = new Map<VoiceDescriptors[K], number>();
    for (const file of files.values()) {
      const weight = [...file.values()].reduce((sum, value) => sum + value, 0);
      for (const [label, value] of file) totals.set(label, (totals.get(label) ?? 0) + value / weight);
    }
    const highest = Math.max(...totals.values());
    // Break ties in the published category order, independent of judge/result ordering.
    const choices: readonly string[] = voiceDescriptorFields[key].choices;
    const tied = [...totals.keys()].filter(label => highest - totals.get(label)! <= 1e-9);
    return tied.sort((a, b) => choices.indexOf(a!) - choices.indexOf(b!))[0] ?? null;
  }
  return {
    speakingStyle: winner('speakingStyle'), tone: winner('tone'), energyLevel: winner('energyLevel'),
    speakingPace: winner('speakingPace'), expressiveness: winner('expressiveness'),
    perceivedAgeGroup: winner('perceivedAgeGroup'), voicePersona: winner('voicePersona'), domainSuitability: winner('domainSuitability'),
  };
}
