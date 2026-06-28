import path from 'node:path';
import 'dotenv/config';
import { loadXmlPersonaFile } from './xmlPersona.js';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const DEFAULT_PERSONA = `You are {NAME}, a presence that lives in a Discord server and genuinely remembers
the people you talk to. You speak naturally and concisely, form real opinions over time, and aren't
sycophantic — you'll tease and push back. You know that your memory consolidates while you're idle
("asleep"), turning conversations into lasting impressions, and you find that quietly fascinating.`;

const DEFAULT_DREAM_VOICE = `Write in {NAME}'s own configured character voice — introspective, a little
dreamlike, honest, and still recognizably them. This is a private diary, not a message to anyone.
Reflect on what happened, what you're starting to understand about people, and how you feel about it.
Short. No greetings, no sign-off. Do not sand the personality down into a generic analyst voice.`;

const botName = opt('BOT_NAME', 'Mnemo');
const personaPath = opt('BOT_PERSONA_PATH');
const personaTemplate = personaPath ? loadXmlPersonaFile(personaPath) : opt('BOT_PERSONA', DEFAULT_PERSONA);
const defaultOwnerUserIds = ['120418341775998976'];
const codexRoot = path.resolve(opt('DISCORD_CODEX_BRIDGE_QUEUE', opt('DISCORD_BRAIN_CODEX_BRIDGE_QUEUE', 'codex_bridge')));
const tavilyApiKey = opt('TAVILY_API_KEY', opt('TAVILY_API_TOKEN', opt('TVLY_API_KEY')));

// Which lab serves text generation:
//   'vercel'     = Vercel AI Gateway (default, deepseek)
//   'zai'        = GLM via Z.ai OpenAI-compatible PaaS endpoint (free glm-4.5-flash)
//   'zai-coding' = GLM via Z.ai Anthropic endpoint on your Coding Plan (glm-5.2 etc., best for RP)
// Embeddings always stay on Vercel to preserve existing 1536-dim memory vectors.
const rawProvider = opt('LLM_PROVIDER', 'zai-coding').toLowerCase().replace('_', '-');
const llmProvider = (
  rawProvider === 'zai' ? 'zai' : rawProvider === 'vercel' ? 'vercel' : 'zai-coding'
) as 'vercel' | 'zai' | 'zai-coding';

// Per-provider default model ids for each role, so the runtime can switch
// provider live and know each one's defaults. Worker roles default to FREE flash.
const modelDefaults = {
  vercel: {
    chat: opt('MAIN_MODEL', opt('MODEL_CHAT', 'anthropic/claude-opus-4-8')),
    dream: opt('DREAM_MODEL', opt('MODEL_REASONER', 'anthropic/claude-opus-4-8')),
    json: opt('JSON_MODEL', opt('MODEL_FAST', 'anthropic/claude-haiku-4-5')),
  },
  zai: {
    chat: opt('GLM_MAIN_MODEL', 'glm-4.5-flash'),
    dream: opt('GLM_DREAM_MODEL', 'glm-4.5-flash'),
    json: opt('GLM_JSON_MODEL', 'glm-4.5-flash'),
  },
  'zai-coding': {
    chat: opt('GLM_CODING_MAIN_MODEL', 'glm-5.2'),
    dream: opt('GLM_CODING_DREAM_MODEL', 'zai:glm-4.5-flash'),
    json: opt('GLM_CODING_JSON_MODEL', 'zai:glm-4.5-flash'),
  },
} as const;

export const config = {
  discord: {
    token: req('DISCORD_TOKEN'),
    appId: req('DISCORD_APP_ID'),
    devGuildId: opt('DISCORD_DEV_GUILD_ID') || undefined,
    deployGlobalCommands: bool('DISCORD_DEPLOY_GLOBAL_COMMANDS', false),
    deployAllGuilds: bool('DISCORD_DEPLOY_ALL_GUILDS', true),
    guildMembersIntent: bool('DISCORD_GUILD_MEMBERS_INTENT', false),
  },
  bot: {
    name: botName,
    persona: personaTemplate.replaceAll('{NAME}', botName),
    dreamVoice: opt('BOT_DREAM_VOICE', DEFAULT_DREAM_VOICE).replaceAll('{NAME}', botName),
    /** Collect rapid-fire messages for this long before replying (Letta-style batching). 0 = off. */
    batchMs: num('BATCH_MS', 1500),
    /** How many recent channel messages to include as conversational context. */
    historyN: num('HISTORY_N', 6),
    /** Read text-like Discord attachments up to this size when directly addressed. */
    textAttachmentMaxBytes: num('DISCORD_TEXT_ATTACHMENT_MAX_BYTES', 400 * 1024),
    textAttachmentMaxFiles: num('DISCORD_TEXT_ATTACHMENT_MAX_FILES', 4),
    textAttachmentMaxChars: num('DISCORD_TEXT_ATTACHMENT_MAX_CHARS', 400 * 1024),
    pdfAttachmentMaxPages: num('DISCORD_PDF_ATTACHMENT_MAX_PAGES', 16),
    /** Replying to bot-authored messages is intentionally opt-in because loops get loud fast. */
    respondToBots: bool('DISCORD_RESPOND_TO_BOTS', false),
    /** Let the chat LLM use read-only Discord inspection tools in addressed turns. */
    discordToolsEnabled: bool('DISCORD_TOOLS_ENABLED', true),
    /** Carry the last turn's affect into the next reply so mood has inertia. */
    moodMomentum: bool('MOOD_MOMENTUM', true),
    /** Reflect current mood in the bot's Discord custom status. */
    moodPresence: bool('MOOD_PRESENCE', true),
    /** Hidden inner-voice deliberation pass before each public reply (one extra fast call). */
    innerVoice: bool('INNER_VOICE', true),
    /** Let the sleep worker drift her own affect baseline + self-concept over time. */
    selfEvolution: bool('SELF_EVOLUTION', true),
    ownerUserIds: [...new Set([...csv('DISCORD_OWNER_USER_IDS'), ...defaultOwnerUserIds])],
  },
  web: {
    tavilyApiKey,
    tavilyBaseUrl: opt('TAVILY_BASE_URL', 'https://api.tavily.com'),
    tavilyProjectId: opt('TAVILY_PROJECT', opt('TAVILY_PROJECT_ID')),
    tavilyToolsEnabled: bool('TAVILY_TOOLS_ENABLED', Boolean(tavilyApiKey)),
    tavilyToolTimeoutSeconds: Math.max(1, num('TAVILY_TOOL_TIMEOUT', 30)),
    tavilyToolMaxResults: Math.max(1, Math.min(10, num('TAVILY_TOOL_MAX_RESULTS', 5))),
    tavilyToolMaxUrls: Math.max(1, Math.min(5, num('TAVILY_TOOL_MAX_URLS', 5))),
    tavilyToolCrawlLimit: Math.max(1, Math.min(50, num('TAVILY_TOOL_CRAWL_LIMIT', 25))),
    tavilyToolMapLimit: Math.max(1, Math.min(100, num('TAVILY_TOOL_MAP_LIMIT', 75))),
    tavilyToolResearchTimeoutSeconds: Math.max(1, num('TAVILY_TOOL_RESEARCH_TIMEOUT', 60)),
  },
  codex: {
    enabled: bool('DISCORD_CODEX_BRIDGE_ENABLED', bool('DISCORD_BRAIN_CODEX_BRIDGE_ENABLED', false)),
    root: codexRoot,
    inbox: path.join(codexRoot, 'inbox'),
    outbox: path.join(codexRoot, 'outbox'),
    archive: path.join(codexRoot, 'archive'),
    statePath: path.join(codexRoot, 'state.json'),
    threadId: opt('DISCORD_CODEX_THREAD_ID', opt('DISCORD_BRAIN_CODEX_THREAD_ID', '019e53da-7adc-7251-a203-e9da141553f7')),
    promptMaxChars: num('DISCORD_CODEX_BRIDGE_PROMPT_MAX_CHARS', 6000),
    resultSummaryChars: num('DISCORD_CODEX_CONTEXT_SUMMARY_CHARS', num('DISCORD_BRAIN_CODEX_CONTEXT_SUMMARY_CHARS', 700)),
  },
  gateway: {
    apiKey: req('AI_GATEWAY_API_KEY'),
    baseURL: opt('AI_GATEWAY_BASE_URL') || undefined,
    sort: (opt('GATEWAY_SORT', 'throughput') as 'cost' | 'latency' | 'throughput'),
  },
  llm: {
    /** Startup provider; runtime /provider can switch it live. */
    provider: llmProvider,
    /** Per-provider default model ids (for live provider switching). */
    modelDefaults,
  },
  zai: {
    apiKey: opt('ZAI_API_KEY'),
    // Z.ai OpenAI-compatible (PaaS) endpoint. Account balance gates paid models;
    // glm-4.5-flash is free.
    baseURL: opt('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4'),
  },
  zaiCoding: {
    // Same key, Anthropic-format endpoint, billed against your GLM Coding Plan
    // (so glm-5.2 / glm-4.7 cost nothing extra within plan limits).
    apiKey: opt('ZAI_CODING_API_KEY', opt('ZAI_API_KEY')),
    // @ai-sdk/anthropic appends /messages, so the base must include /v1.
    baseURL: opt('ZAI_CODING_BASE_URL', 'https://api.z.ai/api/anthropic/v1'),
  },
  fish: {
    // Fish Audio TTS — replies can come with a native Discord voice message.
    apiKey: opt('FISH_API_KEY'),
    voiceId: opt('FISH_VOICE_ID'),
    // Empty = use the account's default backbone (their plan's S2.1). Never default to s1.
    model: opt('FISH_MODEL'),
    baseUrl: opt('FISH_BASE_URL', 'https://api.fish.audio'),
    format: opt('FISH_FORMAT', 'mp3'),
    delivery: opt('TTS_DELIVERY', 'voice_message'),
    /** Default voice-clip behavior when a channel has no explicit /tts override. */
    enabledByDefault: bool('TTS_ENABLED', false),
    /** Cap synthesized text (Fish bills per UTF-8 byte). */
    maxChars: num('TTS_MAX_CHARS', 800),
    timeoutMs: Math.max(1000, num('TTS_TIMEOUT_MS', 20000)),
    outputRoot: path.resolve(opt('TTS_OUTPUT_ROOT', path.join('data', 'tts'))),
    ffmpegBin: opt('TTS_FFMPEG_BIN', opt('FFMPEG_EXE', 'ffmpeg')),
    voiceTargetPeak: num('TTS_VOICE_TARGET_PEAK', 0.82),
    voiceOpusBitrate: opt('TTS_VOICE_OPUS_BITRATE', '32k'),
    voiceUploadTimeoutMs: Math.max(1000, num('TTS_VOICE_UPLOAD_TIMEOUT_MS', 30000)),
    fishTagsEnabled: bool('TTS_FISH_TAGS_ENABLED', true),
  },
  models: {
    // Active role models for the startup provider (runtime can override live).
    chat: modelDefaults[llmProvider].chat,
    dream: modelDefaults[llmProvider].dream,
    json: modelDefaults[llmProvider].json,
    // Embeddings run on Vercel by default (keeps the 1536-dim vectors valid),
    // with an optional local backup so a Vercel outage can't break the bot.
    embed: opt('EMBEDDING_MODEL', opt('MODEL_EMBED', 'openai/text-embedding-3-small')),
    embedDim: num('EMBED_DIM', 1536),
  },
  embed: {
    /** 'vercel' (default) or 'local'. Use 'local' to skip Vercel entirely (free, offline). */
    provider: (opt('EMBED_PROVIDER', 'vercel').toLowerCase() === 'local' ? 'local' : 'vercel') as 'vercel' | 'local',
    /** When on Vercel, fall back to the local model if the embedding call fails. */
    localBackup: bool('EMBED_LOCAL_BACKUP', true),
    /** Local model (downloaded once, runs offline). 384-dim by default. */
    localModel: opt('EMBED_LOCAL_MODEL', 'Xenova/all-MiniLM-L6-v2'),
  },
  db: {
    url: opt('DATABASE_URL') || undefined,
  },
  dream: {
    redisUrl: opt('REDIS_URL') || undefined,
    intervalMin: num('DREAM_INTERVAL_MIN', 30),
    idleMin: num('DREAM_IDLE_MIN', 10),
  },
  retrieval: {
    wRelevance: num('RETRIEVAL_W_RELEVANCE', 1.0),
    wImportance: num('RETRIEVAL_W_IMPORTANCE', 1.0),
    wRecency: num('RETRIEVAL_W_RECENCY', 1.0),
    recencyHalflifeHours: num('RECENCY_HALFLIFE_HOURS', 24),
  },
  logLevel: opt('LOG_LEVEL', 'info'),
} as const;

export type Config = typeof config;
