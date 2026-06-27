import { generateObject } from 'ai';
import { z } from 'zod';
import { models, gatewayProviderOptions } from '../llm/gateway.js';
import type { PersonaAffect } from '../llm/personaOutput.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('tts:fish-tags');

const taggedSpeechSchema = z.object({
  voice_text: z.string().min(1).max(1600),
});

const displayTagPattern =
  /\[(?:angry|annoyed|sad|happy|excited|surprised|curious|playful|teasing|frustrated|tired|calm|content|nervous|confident|sarcastic|deadpan|softly|quietly|loudly|whisper(?:ing)?|laugh(?:ing)?|giggle|chuckle|sigh(?:ing)?|gasp|breath(?:ing)?|inhale|exhale|pause|long pause|emphasis|speaking slowly|speaking softly|speaking quickly|cry(?:ing)?|warmly|sleepy)\]/gi;

export function stripFishSpeechTags(text: string): string {
  return text.replace(displayTagPattern, '').replace(/\s{2,}/g, ' ').trim();
}

export async function buildTaggedFishSpeechText(args: {
  displayText: string;
  affect: PersonaAffect | null;
  userName: string;
}): Promise<string> {
  const displayText = stripFishSpeechTags(args.displayText);
  if (!config.fish.fishTagsEnabled || !displayText) return displayText;

  try {
    const result = await generateObject({
      model: models.json,
      schema: taggedSpeechSchema,
      system: [
        'Rewrite a Discord reply into Fish Audio / Fish Speech S2.1 TTS script text.',
        'Fish S2/S2.1 uses expressive [bracket] tags. Do NOT use old S1-style (parentheses) tags.',
        'Use the most impactful tags sparingly: [excited], [laugh], [sigh], [whisper], [surprised], [teasing], [pause], [emphasis], [softly], [gasp].',
        'Use 0-3 tags total. Put a tag immediately before the phrase it should color.',
        'Keep the original words and facts. Do not add new content, stage directions, emoji descriptions, or explanations.',
        'If the line is neutral, use no tags. Return only JSON with voice_text.',
      ].join('\n'),
      prompt: [
        `Speaker: Hikari-chan`,
        `Listener username: ${args.userName}`,
        `Affect: ${JSON.stringify(args.affect ?? {})}`,
        `Display text: ${displayText}`,
      ].join('\n'),
      temperature: 0.35,
      maxOutputTokens: 500,
      providerOptions: gatewayProviderOptions,
    });
    const tagged = normalizeTaggedText(result.object.voice_text);
    return tagged || displayText;
  } catch (e: any) {
    log.warn('fish tag generation failed', e?.message ?? e);
    return displayText;
  }
}

function normalizeTaggedText(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\((angry|sad|happy|excited|laugh(?:ing)?|sigh(?:ing)?|whisper(?:ing)?|pause|surprised)\)/gi, '[$1]')
    .replace(/\s+/g, ' ')
    .trim();
}
