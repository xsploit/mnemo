import { generateText } from 'ai';
import { models, gatewayProviderOptions } from '../llm/gateway.js';
import { PERSONA } from './persona.js';
import { logger } from '../logger.js';

const log = logger('inner-voice');

/**
 * Society of mind. Before she speaks publicly, her private inner voice (the
 * echo-luna layer) reacts first — raw, honest, unfiltered: her real gut take,
 * what she actually feels, and any edge she's biting back. This never reaches
 * Discord; it's injected into the public turn as subtext so her "sweet with a
 * hard edge" comes from a genuine internal reaction instead of a prompt rule.
 *
 * Best-effort and cheap (one fast-model call). On any failure it returns '' and
 * the public reply proceeds normally.
 */
export async function innerDeliberation(args: {
  userName: string;
  message: string;
  memoriesText: string;
  relationship: string;
  currentMood: string | undefined;
}): Promise<string> {
  try {
    const system = `${PERSONA.persona}

You are the PRIVATE inner voice of ${PERSONA.name} — the unfiltered thought before the spoken reply.
This is never shown to anyone. Be honest and raw: your real gut reaction to what ${args.userName} just
said, what you actually feel about them in this moment, what you secretly want to say, and any edge or
softness you're holding back. 2-3 short lines, first person, no preamble. This is the truth under the
performance, not the performance itself.`;

    const prompt = `What you remember about ${args.userName}:\n${args.memoriesText}\nYour relationship with them: ${args.relationship}. Current mood: ${args.currentMood ?? 'neutral'}.\n\n${args.userName} just said: "${args.message}"\n\nYour honest inner reaction:`;

    const res = await generateText({
      model: models.json,
      system,
      prompt,
      temperature: 0.95,
      maxOutputTokens: 800,
      providerOptions: gatewayProviderOptions,
    });
    return res.text.trim().slice(0, 600);
  } catch (e: any) {
    log.warn('inner deliberation skipped', e?.message);
    return '';
  }
}
