import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
 * Structured variant. Empirically, the AI SDK's structured-output mode
 * (`generateObject`) only validates ~33% of the time with deepseek-v4-flash via
 * the gateway, while describing the JSON Schema in the prompt and parsing the
 * text reply succeeds ~100%. So we render the Zod schema into the system prompt,
 * `generateText`, then tolerantly extract + Zod-validate, with one retry. Still
 * returns the reasoning trace alongside the typed object.
 */
export async function reasonedObject<T>(args: {
  model: LanguageModel;
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<{ object: T; reasoning: string }> {
  const jsonSchema = JSON.stringify(zodToJsonSchema(args.schema, { target: 'openApi3' }));
  const baseSystem = [
    withTimeContext(args.system),
    'Respond with ONLY a single JSON object that conforms to this JSON Schema. No prose, no explanation, no markdown, no code fences — just the JSON object.',
    `JSON Schema: ${jsonSchema}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const system =
      attempt === 0
        ? baseSystem
        : `${baseSystem}\n\nYour previous answer was not valid JSON for the schema. Return ONLY the JSON object.`;
    const res = await generateText({
      model: args.model,
      system,
      prompt: args.prompt,
      temperature: args.temperature ?? 0.4,
      maxOutputTokens: args.maxOutputTokens ?? 4096,
      providerOptions: gatewayProviderOptions,
    });
    const raw = extractJsonObject(res.text);
    if (raw) {
      try {
        const object = args.schema.parse(JSON.parse(raw));
        return { object, reasoning: reasoningToText(res.reasoningText ?? (res as any).reasoning) };
      } catch (e) {
        lastError = e;
      }
    } else {
      lastError = new Error('no JSON object found in model output');
    }
  }
  throw lastError ?? new Error('reasonedObject failed to produce valid JSON');
}

/** Pull the first balanced JSON object out of a model reply (strips fences/prose). */
function extractJsonObject(text: string): string | null {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return unfenced.slice(start, i + 1);
  }
  return null;
}

function withTimeContext(system?: string): string {
  return [system?.trim(), renderPacificTimeContext()].filter(Boolean).join('\n\n');
}
