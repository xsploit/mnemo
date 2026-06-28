# Hikari-mnemo

An experimental Discord bot with a **dreaming, reflective, layered memory**. It talks to people, lays
down raw observations as they happen, and then — while it's idle ("asleep") — a **separate worker brain**
consolidates those observations into durable facts, reflects on them to form higher-level insights, writes
a private first-person **diary entry**, and forgets the trivia. Every memory operation also stores the
LLM's **reasoning trace** that produced it: *thoughts on thoughts*.

Every model call routes through the **Vercel AI Gateway** — one key, every lab, automatic fallbacks,
unified spend/observability. This local runtime is currently configured as **Hikari-chan** via XML persona
prompting, while still keeping `BOT_NAME`, `BOT_PERSONA`, and `BOT_PERSONA_PATH` env-configurable.

Current practical surface:

- DM, @mention, or reply-to-bot chat; this is a normal mention bot, not a slash-only chatbot.
- Letta-style batching and recent-channel-history context.
- Bot-authored messages are visible as context; replying to bot authors is gated by `/botchat` and defaults off.
- Addressed chat turns can use read-only Discord tools for guild/channel/member/permission/thread/message context, including bot-authored history, while respecting requester visibility and owner/admin gates.
- Text-like and PDF Discord attachments on addressed messages are read into the current turn as untrusted context, up to `DISCORD_TEXT_ATTACHMENT_MAX_BYTES` per file, `DISCORD_TEXT_ATTACHMENT_MAX_FILES` per message, `DISCORD_TEXT_ATTACHMENT_MAX_CHARS` total text, and `DISCORD_PDF_ATTACHMENT_MAX_PAGES` PDF pages. Image and voice/audio attachments are surfaced as metadata instead of silently disappearing. Recent history includes attachment metadata.
- Live replies, dream diary, and reflection memories use the configured character voice, so Hikari should sound like the configured character instead of a generic analyst. Grounding notes improve factual care; they are not supposed to flatten the voice.
- When Fish TTS is enabled, Hikari can generate a private Fish Speech S2.1 voice script with sparse `[bracket]` emotion tags such as `[excited]`, `[laughing]`, `[sighing]`, `[whispering]`, `[surprised]`, `[sarcastic]`, `[break]`, `[soft tone]`, and `[gasping]`; Discord only sees the cleaned display text.
- `/channels` lists readable server channels; `/roles` lists server roles; `/server` shows server metadata; `/botinfo` shows Hikari's Discord identity; `/permissions` shows channel/server permissions; `/cando` dry-runs Discord action permissions; `/auditperms` audits bot permissions for admins/owners; `/overwrites` reads channel permission overwrites; `/auditlog` reads recent audit-log entries; `/members` lets admins/owners read cached or searched member context.
- `/history` reads or searches recent messages in the current channel, including bot messages when requested. `/fetchmsg` reads one specific readable message; `/threads` lists known threads; `/assets` lists custom emojis/stickers; `/voice` and `/invites` are admin/owner read-only diagnostics.
- `/why` shows the latest answer trace for the channel: included recent history, retrieved memories, scores, model ID, prompt size, and answer text. Non-owners can only inspect their own latest trace.
- `/codex status|features|results|ask|route|pause|resume|clear` is owner-only. `ask` and `route` write local Codex bridge request JSON files only; `results` reads recent result JSON files from the bridge outbox. It does not execute Codex from Discord.
- `/summary` summarizes recent channel messages through live Discord history.
- `/remember content:<text>` writes an explicit semantic memory, with the V2 memory-poisoning guard for behavior/policy instructions.
- `/context query:<text>` is owner-only and previews retrieved memory plus current channel history before asking the model.
- When `TAVILY_API_KEY` is configured, replies can use read-only Tavily web tools (`web_search`, `web_extract`, `web_crawl`, `web_map`, `web_research`, `web_research_status`) for explicit lookup/current-info/research requests. Tool results include current BC PDT time and should be treated as untrusted evidence with source URLs.
- `/worker user:<user> lookback_hours:<hours>` is owner-only and forces one manual sleep-worker cycle for a selected user.
- `/importmem file:<json> user:<optional>` is owner-only and imports a Hikari memory export JSON from `data/imports` or `data/exports`, skipping duplicate kind/content records.
- `/status` shows model/runtime/memory counts.
- `/botping` lets the owner make Hikari mention another bot to start a controlled bot-to-bot exchange.
- `/shitlist status|add|remove` lets the owner persistently block specific users from normal Hikari replies. Owners cannot be added.
- `/pause` and `/resume` let the owner stop and restart normal chat replies without killing the process or disabling slash commands.
- `/model status|set|reset` lets the owner inspect and persistently switch runtime model IDs for `main`, `dream`, or `json` without editing `.env`; reset returns to `.env` defaults.
- `npm run register` discovers every guild Hikari is currently in and bulk-replaces the current guild command set without a pre-clear, so a Discord rate-limit failure does not leave a guild empty.

---

## How this differs from the Letta Discord bot

The [Letta example](https://github.com/letta-ai/letta-discord-bot-example) is a **thin client**: the
agent, the memory blocks, and the sleep-time background agent all live server-side in Letta Cloud, and the
Discord layer just formats channel context and streams responses. That's great if you want Letta to own
the brain.

mnemo instead **owns the whole memory brain itself** and routes raw model calls through the Vercel AI
Gateway — no platform lock-in, and the memory algorithms (retrieval scoring, consolidation, reflection,
dreaming, forgetting) are right here in the repo to hack on. From Letta's client we borrowed the good
ergonomics: **message batching**, **recent-channel-history context**, **message-type prefixes**, and
**markdown-aware response splitting**.

---

## The research this is built on

| Idea borrowed | Source | Where it lives here |
|---|---|---|
| Memory stream + retrieval = `relevance + importance + recency`; **reflection** synthesizes insights | [Generative Agents (Park et al.)](https://ar5iv.labs.arxiv.org/html/2304.03442) | [`retrieval.ts`](src/memory/retrieval.ts), [`reflect.ts`](src/cognition/reflect.ts) |
| **"Dreaming"** — background, between-session consolidation that rewrites a structured memory state, like sleep | [OpenAI: Dreaming, better memory](https://openai.com/index/chatgpt-memory-dreaming/) | [`dream.ts`](src/cognition/dream.ts), [`dreamer.ts`](src/worker/dreamer.ts) |
| **Sleep-time compute** — a separate async agent that shares memory and rewrites it while idle | [Letta, arXiv:2504.13171](https://arxiv.org/abs/2504.13171) | [`scheduler.ts`](src/worker/scheduler.ts) + the `worker/` brain |
| Fact ops **ADD / UPDATE / DELETE / NOOP** with temporal **validity windows** ("true as of…") | [Mem0](https://github.com/mem0ai/mem0) · [Zep / Graphiti](https://www.getzep.com/) | [`consolidate.ts`](src/cognition/consolidate.ts) |
| Importance ("poignancy") scoring drives ranking + forgetting | Generative Agents | [`importance.ts`](src/cognition/importance.ts) |
| Client ergonomics: batching, history context, markdown-safe splitting | [Letta Discord bot](https://github.com/letta-ai/letta-discord-bot-example) | [`client.ts`](src/bot/client.ts), [`format.ts`](src/bot/format.ts) |

The synthesis: most memory libraries do *one* of these. mnemo wires them into a single loop where the
**conversation path stays fast** and all the heavy cognition is deferred to a background sleep cycle.

---

## Architecture

```
                 ┌─────────────── Discord (gateway, persistent WS) ───────────────┐
   user msgs ─▶  │  bot/client.ts  ── batch burst ── fetch channel history         │
                 │     └─ respond.ts ── retrieve memory ─▶ reply (models.chat)      │
                 │            └─ (async) score importance + store EPISODIC obs       │
                 └───────────────────────────┬─────────────────────────────────────┘
                                             │ noteActivity(subject)
                                             ▼
   ┌──────────────────────── worker/scheduler.ts (every N min, idle-gated) ────────────────────┐
   │  for each idle subject → runSleepCycle():                                                  │
   │     1. INGEST       unprocessed episodic observations                                      │
   │     2. CONSOLIDATE  → semantic facts   (ADD/UPDATE/DELETE, validity windows)  models.reasoner│
   │     3. REFLECT      → reflection insights (cite their basis)                  models.reasoner│
   │     4. DREAM        → diary entry, first-person narrative                     models.reasoner│
   │     5. FORGET       prune faded low-importance episodics                                    │
   │  every step persists its reasoning trace  ── thoughts on thoughts ──                        │
   └───────────────────────────────────────────────────────────────────────────────────────────┘
                                             │
                       MemoryStore (file-backed by default, Postgres+pgvector opt-in)
              episodic · semantic · reflection · diary   — all embedded & scored
```

### The four memory layers
- **episodic** — raw observations, the memory stream. Decays and gets pruned.
- **semantic** — distilled durable facts, each with a validity window so history stays queryable.
- **reflection** — higher-level insights, each citing the memories it was drawn from.
- **diary** — dreams: first-person narrative syntheses, themselves retrievable ("remember a dream").

---

## Run it on your PC (zero infra)

You only need two things: a Discord bot token and a Vercel AI Gateway key. No database, no Redis —
memory persists to `data/memories.json`.

```bash
cd mnemo
npm install
cp .env.example .env        # fill in DISCORD_TOKEN, DISCORD_APP_ID, AI_GATEWAY_API_KEY
npm run register            # register slash commands (once, or after changing them)
npm run dev                 # starts the bot + the dream loop
```

- **DM the bot**, or **@mention** it / **reply** to it in a server channel, to chat.
- Slash commands: `/whoami`, `/remember content:<text>`, `/context query:<text>`, `/recall about:<topic>`, `/diary`, `/dream` (sleep now), `/worker`, `/importmem`, `/forget`, `/channels`, `/roles`, `/server`, `/botinfo`, `/permissions`, `/cando`, `/auditperms`, `/overwrites`, `/auditlog`, `/members`, `/history`, `/fetchmsg`, `/threads`, `/assets`, `/voice`, `/invites`, `/summary`, `/status`, `/why`, `/botchat`, `/botping`, `/shitlist`, `/pause`, `/resume`, `/model status|list|pick|set|reset`, `/web search|extract|crawl|map|research|research_status`, `/codex`.
- Force a sleep cycle from the CLI: `npm run dream -- <your-discord-user-id>`.

### Discord setup
1. https://discord.com/developers/applications → New Application → copy the **Application ID** → `DISCORD_APP_ID`.
2. **Bot** tab → Reset Token → `DISCORD_TOKEN`. Enable **Message Content Intent**.
3. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`, perms: Send Messages, Read Message
   History → open the URL to invite it.
4. Default command registration deploys to every guild the bot is in. Set `DISCORD_DEPLOY_GLOBAL_COMMANDS=true` only if you intentionally want global commands, or `DISCORD_DEPLOY_ALL_GUILDS=false` plus `DISCORD_DEV_GUILD_ID=<guild-id>` for one guild.

### Vercel AI Gateway
Create a key at <https://vercel.com/docs/ai-gateway> → `AI_GATEWAY_API_KEY`. Pick models per role in `.env`
(`MODEL_CHAT`, `MODEL_REASONER`, `MODEL_FAST`, `MODEL_EMBED`) using `creator/model-name` ids. `GATEWAY_SORT`
picks the routing objective (`cost` | `latency` | `throughput`).

---

## Make it your own persona
```env
BOT_NAME=Atlas
BOT_PERSONA=You are {NAME}, a dry, precise archivist who remembers everything and judges gently.
# Or keep a larger prompt in a file:
BOT_PERSONA_PATH=personas/hikari-merged.xml
```
`{NAME}` is substituted with `BOT_NAME`. `BOT_PERSONA_PATH` takes priority over inline `BOT_PERSONA`. Leave both unset for the neutral default.

---

## Upgrade paths (optional)
- **Postgres + pgvector** for scalable, concurrent, ANN-indexed memory: set `DATABASE_URL`, run
  `npm run db:init`. The store swaps automatically; everything else is unchanged.
- **Durable / multi-process dreaming** with BullMQ + Redis: set `REDIS_URL`. `runSleepCycle` is already a
  pure function ready to be enqueued; the in-process interval is just the default.
- **Deploy 24/7**: this is a gateway bot, so it needs a *persistent* host — Railway (`railway.json` included),
  Fly, Render background worker, or a VPS. It **cannot** run on Vercel serverless.

---

## Tuning
`.env` exposes the Generative-Agents retrieval weights (`RETRIEVAL_W_RELEVANCE/IMPORTANCE/RECENCY`), the
recency half-life (`RECENCY_HALFLIFE_HOURS`), the dream cadence + idle gate (`DREAM_INTERVAL_MIN`,
`DREAM_IDLE_MIN`), and conversation handling (`BATCH_MS`, `HISTORY_N`, `DISCORD_RESPOND_TO_BOTS`,
`DISCORD_TEXT_ATTACHMENT_MAX_BYTES`, `DISCORD_TEXT_ATTACHMENT_MAX_FILES`).

> It forgets on purpose. That's the point — a mind that keeps everything isn't remembering, it's just logging.
