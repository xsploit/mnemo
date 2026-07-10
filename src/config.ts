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
// Default: vercel (broadest model choice). Switch to 'zai' for fully-free GLM on
// every role when a coding-plan window (5hr/weekly) is exhausted, or 'zai-coding'
// to spend plan quota on chat only. Mix per-role with a provider: prefix on any
// model id. Embeddings default to local regardless (see config.embed below).
const rawProvider = opt('LLM_PROVIDER', 'vercel').toLowerCase().replace('_', '-');
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
const embedProvider = (opt('EMBED_PROVIDER', 'local').toLowerCase() === 'vercel' ? 'vercel' : 'local') as 'vercel' | 'local';

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
    /** Let the sleep worker drift her own affect baseline + self-concept over time. */
    selfEvolution: bool('SELF_EVOLUTION', true),
    /** Occasionally react to the user's message with a mood-matched emoji. */
    reactionsEnabled: bool('REACTIONS_ENABLED', true),
    /** Probability of reacting on an emotionally charged reply (0-1). */
    reactionChance: num('REACTION_CHANCE', 0.35),
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
    /** 'low' | 'medium' | 'high' | 'off' — reasoning effort for deepseek thinking models. */
    deepseekReasoningEffort: opt('DEEPSEEK_REASONING_EFFORT', 'low'),
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
    // The Vercel embedding model id, used only if config.embed.provider is 'vercel'.
    embed: opt('EMBEDDING_MODEL', opt('MODEL_EMBED', 'openai/text-embedding-3-small')),
    embedDim: num('EMBED_DIM', embedProvider === 'local' ? 384 : 1536),
  },
  vc: {
    /** Streaming fast path: streamText → per-sentence Fish TTS → immediate playback. */
    fastPipeline: bool('VC_FAST', true),
    /** Fast-first-token model for live voice (reasoning models think for seconds
     *  before their first token, which kills streaming). Empty = use chat model. */
    model: opt('VC_MODEL', 'google/gemini-3.1-flash-lite'),
    /** She only *responds* to utterances containing this word (case-insensitive). */
    wakeWord: opt('VC_WAKE_WORD', botName.split(/[-\s]/)[0] ?? botName).toLowerCase(),
    /** Extra accepted forms — STT mangles names ("hikaru", "hey kari", "hickory"). */
    wakeAliases: csv('VC_WAKE_ALIASES').map((a) => a.toLowerCase()),
    /** After being woken, she converses freely (no wake word needed) until the
     *  channel is quiet this long — then she goes idle again. */
    attentionMinutes: num('VC_ATTENTION_MIN', 5),
    /** Saying any of these sends her back to idle immediately. */
    sleepPhrases: (opt('VC_SLEEP_PHRASES', 'go to sleep,stop listening,go idle,shut up hikari')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)),
    /** How many recent VC lines (all speakers) to feed as context into her replies. */
    contextLines: num('VC_CONTEXT_LINES', 10),
    /** Drop VC context lines older than this (minutes). */
    contextMaxAgeMin: num('VC_CONTEXT_MAX_AGE_MIN', 5),
    /** Respond to everything said in VC instead of wake-word only (chatty + costly). */
    respondAll: bool('VC_RESPOND_ALL', false),
    /** Trailing silence that ends an utterance (ms). */
    silenceMs: num('VC_SILENCE_MS', 1200),
    /** Ignore blips shorter than this (coughs, key clicks). */
    minUtteranceMs: num('VC_MIN_UTTERANCE_MS', 600),
    /** Hard cap per utterance so a monologue can't run away (ms). */
    maxUtteranceMs: num('VC_MAX_UTTERANCE_MS', 45_000),
    /** Mirror transcripts + her replies into the linked text channel. */
    textMirror: bool('VC_TEXT_MIRROR', true),
  },
  media: {
    // Multimodal perception (image description + voice-message transcription).
    // gemini-3.5-flash via the Vercel gateway handles both; 3.1-flash-lite
    // hallucinated speech in a pure tone during probing, so prefer 3.5.
    enabled: bool('MEDIA_PERCEPTION', true),
    model: opt('MEDIA_MODEL', opt('VISION_MODEL', 'google/gemini-3.5-flash')),
    // Generous: big screenshots get ffmpeg-downscaled before the model call anyway.
    imageMaxBytes: num('MEDIA_IMAGE_MAX_BYTES', 24 * 1024 * 1024),
    audioMaxBytes: num('MEDIA_AUDIO_MAX_BYTES', 16 * 1024 * 1024),
    /** Max image/audio attachments perceived per message (cost guard). */
    maxItems: num('MEDIA_MAX_ITEMS', 3),
    /** Fall back to local Whisper (transformers.js ONNX) when gateway transcription fails. */
    localWhisperBackup: bool('WHISPER_LOCAL_BACKUP', true),
    /** Local Whisper model (downloaded once, offline). base ≈ 74MB, good accuracy. */
    localWhisperModel: opt('WHISPER_LOCAL_MODEL', 'Xenova/whisper-base'),
  },
  embed: {
    // Local (transformers.js) is the default, unconditionally — no Vercel spend or
    // outage can ever break memory retrieval. Set EMBED_PROVIDER=vercel to opt back in.
    provider: embedProvider,
    /** When on Vercel, fall back to the local model if the embedding call fails. */
    localBackup: bool('EMBED_LOCAL_BACKUP', true),
    /** Local model (downloaded once, runs offline). 384-dim by default. */
    localModel: opt('EMBED_LOCAL_MODEL', 'Xenova/all-MiniLM-L6-v2'),
  },
  development: {
    /** Master switch for Hikari's experimental cognition/event loop. */
    enabled: bool('DEVELOPMENT_ENABLED', true),
    eventPath: path.resolve(opt('DEVELOPMENT_EVENT_PATH', path.join('data', 'development', 'events.jsonl'))),
    /** Structured replacement for the older free-form inner-voice pass. */
    cognitivePrepass: bool('DEVELOPMENT_COGNITIVE_PREPASS', bool('INNER_VOICE', true)),
    /** Adaptive uses the model only for socially complex turns plus a stable sample. */
    cognitiveMode: (() => {
      const value = opt('DEVELOPMENT_COGNITIVE_MODE', 'deterministic').toLowerCase();
      return value === 'always' || value === 'deterministic' ? value : 'adaptive';
    })() as 'adaptive' | 'always' | 'deterministic',
    cognitiveSampleRate: Math.max(0, Math.min(1, num('DEVELOPMENT_COGNITIVE_SAMPLE_RATE', 0.05))),
    cognitiveTimeoutMs: Math.max(500, Math.min(30_000, num('DEVELOPMENT_COGNITIVE_TIMEOUT_MS', 2500))),
    /** A later message/reaction may resolve the latest response inside this window. */
    outcomeWindowHours: Math.max(1, num('DEVELOPMENT_OUTCOME_WINDOW_HOURS', 24)),
    /** Unreferenced follow-ups only attach implicitly for a short conversational window. */
    implicitOutcomeWindowMinutes: Math.max(1, num('DEVELOPMENT_IMPLICIT_OUTCOME_WINDOW_MINUTES', 30)),
    /** Maximum observable hypotheses compiled for one turn. */
    maxPredictions: Math.max(1, Math.min(5, num('DEVELOPMENT_MAX_PREDICTIONS', 3))),
    /** EMA step used for memory/strategy/prediction utility updates. */
    utilityAlpha: Math.max(0.01, Math.min(1, num('DEVELOPMENT_UTILITY_ALPHA', 0.2))),
    /** Maximum multiplicative influence learned utility has on semantically relevant recall. */
    utilityWeight: Math.max(0, Math.min(0.5, num('DEVELOPMENT_UTILITY_WEIGHT', 0.2))),
    /** Utility cannot boost a memory below this semantic relevance gate. */
    utilityMinRelevance: Math.max(0, Math.min(1, num('DEVELOPMENT_UTILITY_MIN_RELEVANCE', 0.2))),
    simulationsPerDream: Math.max(0, Math.min(5, num('DEVELOPMENT_SIMULATIONS_PER_DREAM', 3))),
    /** Slow identity changes require repeated evidence across independent sleep cycles. */
    selfDeltaMinEvidence: Math.max(2, num('DEVELOPMENT_SELF_DELTA_MIN_EVIDENCE', 3)),
    selfDeltaMinCycles: Math.max(2, num('DEVELOPMENT_SELF_DELTA_MIN_CYCLES', 2)),
    policyLabEnabled: bool('DEVELOPMENT_POLICY_LAB', true),
    /** No external service by default. Letta and other adapters are explicit opt-ins later. */
    shadowProvider: opt('DEVELOPMENT_SHADOW_PROVIDER', 'local-diversity').toLowerCase(),
  },
  db: {
    url: opt('DATABASE_URL') || undefined,
  },
  dream: {
    redisUrl: opt('REDIS_URL') || undefined,
    intervalMin: num('DREAM_INTERVAL_MIN', 30),
    idleMin: num('DREAM_IDLE_MIN', 10),
    /** After a salient dream, post a fancy embed to the subject's last channel. */
    announce: bool('DREAM_ANNOUNCE', true),
    /** Minimum hours between dream announcements for the same person. */
    announceCooldownHours: num('DREAM_ANNOUNCE_COOLDOWN_HOURS', 6),
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
