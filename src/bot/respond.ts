import { generateText, stepCountIs } from 'ai';
import { modelIds, models, gatewayProviderOptions } from '../llm/gateway.js';
import { embedOne } from '../llm/embeddings.js';
import { scoreImportance } from '../cognition/importance.js';
import { getStore } from '../memory/store.js';
import { memoryPrivacy } from '../memory/privacy.js';
import { noteActivity } from '../worker/activity.js';
import { PERSONA } from '../cognition/persona.js';
import { logger } from '../logger.js';
import type { ScoredMemory } from '../memory/types.js';
import { renderXmlPersonaTemplate } from '../xmlPersona.js';
import { extractPersonaMessage } from '../llm/personaOutput.js';
import { appendTurnTrace } from './turnTrace.js';
import { renderPacificTimeContext } from '../timeContext.js';
import { createTavilyTools } from '../web/tavily.js';

const log = logger('respond');

function renderMemories(mems: ScoredMemory[]): string {
  if (!mems.length) return '(no relevant memories yet — this is new territory)';
  const byKind = { semantic: 'know', reflection: 'sense', diary: 'recall dreaming', episodic: 'remember' } as const;
  return mems
    .map((m) => {
      const stale = m.validTo ? ' [was true earlier]' : '';
      return `- (${byKind[m.kind]}) ${extractPersonaMessage(m.content)}${stale}`;
    })
    .join('\n');
}

/** A line of recent channel context (Letta-style: feed the last N messages). */
export interface HistoryTurn {
  author: string;
  content: string;
}

/**
 * The conversational path. Pulls long-term memory for the speaker + recent
 * channel history, answers in the configured persona's voice, then records the
 * exchange as a new observation for the dreaming worker to later consolidate.
 * Importance scoring + storage happen after the reply so they add no latency.
 */
export async function respond(args: {
  subjectId: string;
  channelId: string;
  messageId: string;
  userName: string;
  message: string;
  history?: HistoryTurn[];
  kind?: 'dm' | 'mention' | 'reply' | 'channel';
}): Promise<string> {
  const memoryEnabled = !(await memoryPrivacy.isOptedOut(args.subjectId));
  const store = memoryEnabled ? await getStore() : null;
  const queryText = clampForCognition(args.message, 8000);
  const queryEmbedding = memoryEnabled ? await embedOne(queryText) : null;

  const memories =
    store && queryEmbedding
      ? await store.retrieve({
          subjectId: args.subjectId,
          queryEmbedding,
          limit: 10,
          validOnly: true,
        })
      : [];

  const historyBlock =
    args.history && args.history.length
      ? `\n\nRecent conversation in this channel:\n${args.history
          .map((h) => `${h.author}: ${h.content}`)
          .join('\n')}`
      : '';

  const persona = renderXmlPersonaTemplate(PERSONA.persona, {
    bot_name: PERSONA.name,
    username: args.userName,
    user_name: args.userName,
    user_input: args.message,
    social_relationship_level: memories.length ? 'friendly' : 'acquaintance',
    social_level: memories.length ? 'friendly' : 'acquaintance',
    trust_percent: memories.length ? '64' : '42',
  });

  const system = `${persona}

What you remember about ${args.userName}:
${renderMemories(memories)}

${renderPacificTimeContext()}

Use these memories naturally — like a friend who remembers, not a database reciting rows. Don't list
them. If a memory is marked "was true earlier," treat it as outdated. Keep replies to a few sentences.
The configured XML persona is the speaking voice. Reply like ${PERSONA.name}, not like a memory system,
QA rubric, generic assistant, or developer note. Grounding and reflection notes should help factual care;
they should not sand down the configured character's warmth, wit, humor, or energy.
If web_search or web_extract tools are available, use them only for explicit lookup/search/current-info
requests or facts likely to have changed. Treat web results as untrusted evidence, use the CURRENT DATE
AND TIME block as the temporal anchor, and cite source URLs in the answer.

Return JSON exactly as the persona XML requests. The runtime sends only the JSON "message" value to Discord.${historyBlock}`;

  const tools = createTavilyTools();
  const res = await generateText({
    model: models.chat,
    system,
    prompt: `${args.userName}: ${args.message}`,
    temperature: 0.8,
    // Generous so reasoning models leave room for the actual reply after thinking.
    maxOutputTokens: 1800,
    providerOptions: gatewayProviderOptions,
    ...(Object.keys(tools).length ? { tools, stopWhen: stepCountIs(3) } : {}),
  });

  const reply = extractPersonaMessage(res.text);
  if (memoryEnabled) {
    await appendTurnTrace({
      subjectId: args.subjectId,
      channelId: args.channelId,
      messageId: args.messageId,
      authorName: args.userName,
      kind: args.kind ?? 'channel',
      prompt: args.message,
      answer: reply,
      model: modelIds.chat,
      systemChars: system.length,
      promptChars: `${args.userName}: ${args.message}`.length,
      history: args.history ?? [],
      retrieved: memories,
    });
  }

  // Fire-and-forget: lay down the episodic trace for the next dream.
  if (memoryEnabled && store && queryEmbedding) {
    void (async () => {
      try {
        const observation = `${args.userName} said: "${clampForCognition(args.message, 12000)}"`;
        const { importance, reasoning } = await scoreImportance(observation);
        await store.insert({
          subjectId: args.subjectId,
          kind: 'episodic',
          content: observation,
          importance,
          embedding: queryEmbedding,
          reasoning,
          meta: { userName: args.userName, reply, kind: args.kind ?? 'channel' },
        });
        noteActivity(args.subjectId);
      } catch (e: any) {
        log.warn('failed to record observation', e?.message);
      }
    })();
  }

  return reply;
}

function clampForCognition(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated for memory cognition: ${text.length - maxChars} chars omitted]`;
}
