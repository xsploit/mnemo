const LIMIT = 2000;

/**
 * Split a reply into Discord-sized (<=2000 char) chunks, preferring to break on
 * blank lines / newlines and never splitting in the middle of a ``` code fence
 * (we reopen the fence on the next chunk). Mirrors the Letta example's
 * markdown-preserving auto-split.
 */
export function splitMessage(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let buf = '';
  let fence: string | null = null; // current open code fence, e.g. "```ts"

  const flush = () => {
    if (!buf) return;
    out.push(fence ? `${buf}\n\`\`\`` : buf);
    buf = fence ? `${fence}\n` : '';
  };

  for (const line of text.split('\n')) {
    const m = line.match(/^```(\w*)/);
    if (m) fence = fence ? null : line; // toggle fence state

    if (buf.length + line.length + 1 > limit) flush();

    // A single line longer than the limit: hard-wrap it.
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) {
        if (buf) flush();
        out.push(line.slice(i, i + limit));
      }
      continue;
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}
