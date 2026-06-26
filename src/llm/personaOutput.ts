export function extractPersonaMessage(text: string): string {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(unfenced) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // If the model misses the JSON wrapper, fall back to its raw text.
  }
  return trimmed;
}
