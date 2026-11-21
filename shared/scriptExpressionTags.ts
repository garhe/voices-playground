const EXPRESSION_TAGS = 'amazed, amused, angry, annoyed, anxious, appreciative, calm, cautious, concerned, confident, confused, curious, defeated, defensive, defiant, determined, disappointed, disgusted, doubtful, ecstatic, encouraging, excited, fast, fearful, frustrated, happy, hesitant, hurt, impatient, impressed, intrigued, joking, laughing, optimistic, painful, panicked, panting, pleading, proud, quiet, reassuring, reflective, relieved, remorseful, resigned, sad, sarcastic, secretive, serious, shocked, shouting, shy, skeptical, slow, struggling, surprised, suspicious, sympathetic, terrified, upset, urgent, whispering';
export const EXPRESSION_TAG_NAMES = EXPRESSION_TAGS.split(', ');
export const SOUND_TAG_NAMES = ['laughter', 'coughing', 'throat_clearing', 'breathing', 'sighing', 'yawning'];
export const CALM_TAG_LIMIT = 4;

const tagNameSchema = z.string().trim().toLowerCase().max(40).regex(
  /^\p{L}[\p{L}\p{N}_-]*$/u, 'Tag names must start with a letter and contain only letters, numbers, underscores, or hyphens.',
);
export const expressionTagListsSchema = z.object({
  styles: z.array(tagNameSchema).min(1, 'Add at least one style tag.').max(100),
  sounds: z.array(tagNameSchema).max(100),
}).strict().refine(({ styles, sounds }) =>
  new Set([...styles, ...sounds]).size === styles.length + sounds.length, 'Tag names must be unique across both lists.');
export type ExpressionTagLists = z.infer<typeof expressionTagListsSchema>;

export const DEFAULT_EXPRESSION_TAG_LISTS: ExpressionTagLists = {
  styles: EXPRESSION_TAG_NAMES,
  sounds: SOUND_TAG_NAMES,
};

export function expressionTagRules({ styles, sounds }: ExpressionTagLists): string[] {
  const first = styles.includes('concerned') ? 'concerned' : styles[0];
  const second = styles.includes('curious') ? 'curious' : styles.find(name => name !== first) ?? first;
  return [
    'Expression tags are ON. Apply these tag rules even if the content brief gives conflicting tag instructions.',
    `Prefix every spoken sentence with exactly 1 emotion/style tag in square brackets: [${first}] I can help. [${second}] Is the eSIM inactive?`,
    `Use only these style names: ${styles.join(', ')}.${styles.includes('calm') ? ` Use [calm] at most ${CALM_TAG_LIMIT} times per locale.` : ''}${styles.length > 1 ? ' Vary styles naturally.' : ''}`,
    sounds.length ? `Optional sound tags: ${sounds.map(name => `[${name}]`).join(', ')}. Use sparingly where the sound occurs, separate from the style tag.`
      : 'Do not include sound tags.',
    'Tags are non-spoken. Apart from tags, use spoken words and punctuation without asterisks.',
  ];
}
import { z } from 'zod';
