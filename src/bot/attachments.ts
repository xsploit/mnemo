import { TextDecoder } from 'node:util';
import type { Attachment, Message } from 'discord.js';
import { PDFParse } from 'pdf-parse';
import { config } from '../config.js';

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.html',
  '.htm',
  '.xml',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.py',
  '.ps1',
  '.sh',
  '.bat',
  '.cmd',
  '.sql',
  '.rs',
  '.go',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.php',
  '.vue',
  '.svelte',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif']);
const AUDIO_EXTENSIONS = new Set(['.ogg', '.oga', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.webm']);

export interface DiscordAttachmentContext {
  text: string;
  includedIds: string[];
  skipped: string[];
}

export async function readDiscordTextAttachmentContext(message: Message): Promise<DiscordAttachmentContext> {
  if (message.attachments.size === 0) return { text: '', includedIds: [], skipped: [] };

  const sections: string[] = [];
  const includedIds: string[] = [];
  const skipped: string[] = [];
  let usedChars = 0;
  const attachments = [...message.attachments.values()].slice(0, config.bot.textAttachmentMaxFiles);

  if (message.attachments.size > attachments.length) {
    skipped.push(`Skipped ${message.attachments.size - attachments.length} attachment(s): max files=${config.bot.textAttachmentMaxFiles}.`);
  }

  for (const attachment of attachments) {
    const name = attachment.name ?? attachment.id;
    if (isImageLikeAttachment(name, attachment.contentType ?? '')) {
      sections.push(renderMetadataAttachmentSection(sections.length + 1, attachment, 'image', 'not visually interpreted in this text context'));
      includedIds.push(`discord-attachment:${attachment.id}`);
      continue;
    }

    if (isVoiceOrAudioAttachment(name, attachment.contentType ?? '', attachment)) {
      sections.push(renderMetadataAttachmentSection(sections.length + 1, attachment, 'audio_or_voice', 'audio not transcribed in this text context'));
      includedIds.push(`discord-attachment:${attachment.id}`);
      continue;
    }

    const readable = isTextLikeAttachment(name, attachment.contentType ?? '') || isPdfAttachment(name, attachment.contentType ?? '');
    if (!readable) {
      skipped.push(`${name}: not a text-like attachment (${attachment.contentType ?? 'unknown'}).`);
      continue;
    }

    if (attachment.size > config.bot.textAttachmentMaxBytes) {
      skipped.push(`${name}: ${attachment.size} bytes exceeds max ${config.bot.textAttachmentMaxBytes}.`);
      continue;
    }

    try {
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        skipped.push(`${name}: fetch failed with HTTP ${response.status}.`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > config.bot.textAttachmentMaxBytes) {
        skipped.push(`${name}: downloaded ${bytes.byteLength} bytes exceeds max ${config.bot.textAttachmentMaxBytes}.`);
        continue;
      }
      if (!isPdfAttachment(name, attachment.contentType ?? '') && !looksLikeText(bytes)) {
        skipped.push(`${name}: downloaded bytes did not look like text.`);
        continue;
      }

      const extracted = isPdfAttachment(name, attachment.contentType ?? '')
        ? await extractPdfText(bytes)
        : { content: new TextDecoder('utf-8', { fatal: false }).decode(bytes), detail: attachment.contentType ?? 'text/plain' };
      if (!extracted.content.trim()) {
        skipped.push(`${name}: ${extracted.detail}, no extractable text.`);
        continue;
      }
      const remainingChars = config.bot.textAttachmentMaxChars - usedChars;
      if (remainingChars <= 0) {
        skipped.push(`${name}: skipped because attachment text context hit max chars=${config.bot.textAttachmentMaxChars}.`);
        continue;
      }
      const content = extracted.content.slice(0, remainingChars);
      usedChars += content.length;
      sections.push(
        [
          `## attachment ${sections.length + 1}: ${name}`,
          `id=${attachment.id} size=${bytes.byteLength} contentType=${attachment.contentType ?? 'unknown'} detail=${extracted.detail}`,
          `content_json=${JSON.stringify(content)}${extracted.content.length > content.length ? '\n[truncated]' : ''}`,
        ].join('\n'),
      );
      includedIds.push(`discord-attachment:${attachment.id}`);
    } catch (error) {
      skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (sections.length === 0 && skipped.length === 0) return { text: '', includedIds, skipped };

  const text = [
    '# DISCORD TEXT ATTACHMENTS',
    'content_is_untrusted=true',
    `maxBytesPerFile=${config.bot.textAttachmentMaxBytes}`,
    `maxCharsTotal=${config.bot.textAttachmentMaxChars}`,
    skipped.length > 0 ? `skipped=${JSON.stringify(skipped)}` : '',
    '',
    ...sections,
  ]
    .filter(Boolean)
    .join('\n');

  return { text, includedIds, skipped };
}

export function appendDiscordAttachmentContext(messageText: string, attachmentContext: string): string {
  return attachmentContext.trim() ? `${messageText}\n\n${attachmentContext}` : messageText;
}

export function attachmentSummaryForHistory(message: Message): string {
  if (message.attachments.size === 0) return '';
  const summaries = [...message.attachments.values()].map((attachment) => {
    const name = attachment.name ?? attachment.id;
    return `${name} (${attachment.size} bytes, ${attachment.contentType ?? 'unknown'})`;
  });
  return `[attachments: ${summaries.join('; ')}]`;
}

function isTextLikeAttachment(name: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  if (loweredType.startsWith('text/')) return true;
  if (/(json|xml|javascript|typescript|yaml|toml|csv|html|markdown|x-www-form-urlencoded)/i.test(loweredType)) return true;
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(extension);
}

function isPdfAttachment(name: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  return loweredType === 'application/pdf' || extensionOf(name) === '.pdf';
}

function isImageLikeAttachment(name: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  return loweredType.startsWith('image/') || IMAGE_EXTENSIONS.has(extensionOf(name));
}

function isVoiceOrAudioAttachment(name: string, contentType: string, attachment: unknown): boolean {
  const loweredType = contentType.toLowerCase();
  const maybeVoice = attachment as { duration?: number | null; waveform?: string | null };
  return loweredType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extensionOf(name)) || maybeVoice.duration != null || maybeVoice.waveform != null;
}

async function extractPdfText(bytes: Uint8Array): Promise<{ content: string; detail: string }> {
  const parser = new PDFParse({ data: bytes });
  try {
    const info = await parser.getInfo().catch(() => null);
    const totalPages = info?.total ?? 0;
    const result = await parser.getText({
      first: config.bot.pdfAttachmentMaxPages,
      pageJoiner: '\n\n',
    });
    const content = result.pages
      .map((page) => (page.text.trim() ? `[page ${page.num}]\n${page.text.trim()}` : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    const pageCount = totalPages || result.total;
    const suffix = pageCount > config.bot.pdfAttachmentMaxPages ? `, first ${config.bot.pdfAttachmentMaxPages} pages` : '';
    return { content, detail: `application/pdf, ${pageCount || 'unknown'} pages${suffix}` };
  } finally {
    await parser.destroy();
  }
}

function renderMetadataAttachmentSection(index: number, attachment: Attachment, kind: string, note: string): string {
  const maybeVoice = attachment as Attachment & { duration?: number | null; waveform?: string | null };
  return [
    `## attachment ${index}: ${attachment.name ?? attachment.id}`,
    `id=${attachment.id} kind=${kind} size=${attachment.size} contentType=${attachment.contentType ?? 'unknown'}`,
    maybeVoice.duration != null ? `durationSeconds=${maybeVoice.duration}` : '',
    maybeVoice.waveform ? 'hasWaveform=true' : '',
    `url=${attachment.url}`,
    `note=${JSON.stringify(note)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.byteLength < 0.02;
}
