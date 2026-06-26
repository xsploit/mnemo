export interface PersonaAffect {
  mood?: string;
  /** Pleasantness, -1 negative to +1 positive. */
  valence?: number;
  /** Activation level, 0 calm to 1 highly activated. */
  arousal?: number;
  /** Felt agency/control, 0 low to 1 high. */
  dominance?: number;
  socialEnergy?: number;
  confidence?: number;
}

export interface PersonaOutput {
  message: string;
  affect: PersonaAffect | null;
}

export function parsePersonaOutput(text: string): PersonaOutput {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(unfenced) as { message?: unknown; mood?: unknown; affect?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return { message: parsed.message.trim(), affect: normalizeAffect(parsed.affect, parsed.mood) };
    }
  } catch {
    // Fall through to tolerant extraction for model output with invalid JSON string newlines.
  }

  const message = extractStringField(unfenced, 'message');
  if (message.trim()) {
    return { message: message.trim(), affect: extractAffect(unfenced) };
  }
  return { message: trimmed, affect: null };
}

export function extractPersonaMessage(text: string): string {
  return parsePersonaOutput(text).message;
}

function extractAffect(text: string): PersonaAffect | null {
  try {
    const mood = extractStringField(text, 'mood');
    const affectBlock = extractObjectField(text, 'affect');
    const affect = affectBlock ? JSON.parse(affectBlock) : undefined;
    return normalizeAffect(affect, mood || undefined);
  } catch {
    const mood = extractStringField(text, 'mood');
    return normalizeAffect(undefined, mood || undefined);
  }
}

function normalizeAffect(value: unknown, fallbackMood?: unknown): PersonaAffect | null {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const affect: PersonaAffect = {};
  const mood = typeof source.mood === 'string' ? source.mood : typeof fallbackMood === 'string' ? fallbackMood : undefined;
  if (mood?.trim()) affect.mood = mood.trim();
  const valence = numberField(source, 'valence');
  const arousal = numberField(source, 'arousal');
  const dominance = numberField(source, 'dominance');
  const socialEnergy = numberField(source, 'social_energy') ?? numberField(source, 'socialEnergy');
  const confidence = numberField(source, 'confidence');
  if (valence !== undefined) affect.valence = clampNumber(valence, -1, 1);
  if (arousal !== undefined) affect.arousal = clampNumber(arousal, 0, 1);
  if (dominance !== undefined) affect.dominance = clampNumber(dominance, 0, 1);
  if (socialEnergy !== undefined) affect.socialEnergy = clampNumber(socialEnergy, 0, 1);
  if (confidence !== undefined) affect.confidence = clampNumber(confidence, 0, 1);
  return Object.keys(affect).length ? affect : null;
}

function extractStringField(text: string, fieldName: string): string {
  const match = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"`).exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  let value = '';
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) break;
      value += decodeEscape(next);
      index++;
      continue;
    }
    if (char === '"' && looksLikeFieldTerminator(text.slice(index + 1))) return value;
    value += char;
  }
  return value;
}

function extractObjectField(text: string, fieldName: string): string | null {
  const match = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*\\{`).exec(text);
  if (!match) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = match.index + match[0].lastIndexOf('{'); index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(match.index + match[0].lastIndexOf('{'), index + 1);
    }
  }
  return null;
}

function looksLikeFieldTerminator(rest: string): boolean {
  return /^\s*(?:,\s*"[\w-]+"\s*:|})/.test(rest);
}

function decodeEscape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '"':
      return '"';
    case '\\':
      return '\\';
    default:
      return char;
  }
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
