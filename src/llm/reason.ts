import { generateText, generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { gatewayProviderOptions } from './gateway.js';
import { renderPacificTimeContext } from '../timeContext.js';

/** Normalize a model's reasoning (string, parts array, or absent) to plain text. */
function reasoningToText(r: unknown): string {
  if (!r) return '';
  if (typeof r === 'string') return r.trim();
  if (Array.isArray(r)) {
    return r
      .map((p) => (typeof p === 'string' ? p : typeof (p as any)?.text === 'string' ? (p as any).text : ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * A generation that captures the model's *reasoning trace* alongside its output.
 *
 * This is the heart of the "thoughts on thoughts" idea: when the dreaming worker
 * decides to store, merge, or forget a memory, we keep the chain of thought that
 * led there. The trace itself becomes metadata on the resulting memory, so the
 * diary can later answer not just "what does it remember" but "why did it
 * decide it mattered."
 */
export interface ReasonedText {
  text: string;
  /** The model's surfaced reasoning, when the chosen model exposes it. */
  reasoning: string;
  usage: { input: number; output: number; reasoning?: number };
}

export async function reasonedText(args: {
  model: LanguageModel;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<ReasonedText> {
  const res = await generateText({
    model: args.model,
    system: withTimeContext(args.system),
    prompt: args.prompt,
    temperature: args.temperature ?? 0.7,
    // Reasoning models spend tokens thinking before any visible output, so keep
    // this generous — too low and the answer comes back empty.
    maxOutputTokens: args.maxOutputTokens ?? 2048,
    providerOptions: gatewayProviderOptions,
  });

  return {
    text: res.text.trim(),
    reasoning: reasoningToText(res.reasoningText ?? (res as any).reasoning),
    usage: {
      input: res.usage?.inputTokens ?? 0,
      output: res.usage?.outputTokens ?? 0,
      reasoning: res.usage?.reasoningTokens,
    },
  };
}

/**
 * Structured variant: forces the model to emit JSON matching `schema` while still
 * returning the reasoning that produced it. Used by consolidation (ADD/UPDATE/
 * DELETE decisions) and reflection (insight extraction).
 */
export async function reasonedObject<T>(args: {
  model: LanguageModel;
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<{ object: T; reasoning: string }> {
  const res = await generateObject({
    model: args.model,
    schema: args.schema,
    system: withTimeContext(args.system),
    prompt: args.prompt,
    temperature: args.temperature ?? 0.4,
    // Headroom for reasoning tokens + the JSON payload (reasoning models).
    maxOutputTokens: args.maxOutputTokens ?? 4096,
    providerOptions: gatewayProviderOptions,
  });

  return {
    object: res.object,
    reasoning: reasoningToText((res as any).reasoning),
  };
}

function withTimeContext(system?: string): string {
  return [system?.trim(), renderPacificTimeContext()].filter(Boolean).join('\n\n');
}
