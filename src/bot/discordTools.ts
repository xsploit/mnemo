import { tool, type ToolSet } from 'ai';
import {
  AuditLogEvent,
  ChannelType,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
  type User,
} from 'discord.js';
import { z } from 'zod';
import { config } from '../config.js';
import { pacificTimeSnapshot } from '../timeContext.js';
import {
  createOwnerGuildInvite,
  deliverOwnerInvite,
  inspectBotGuild,
  listBotGuilds,
  readBotGuildActivity,
} from './guildOps.js';
import {
  ownerClaimAdministrator,
  ownerManageChannel,
  ownerManageMember,
  ownerManageMessage,
  ownerManageRole,
  ownerManageThread,
  ownerManageWebhook,
  ownerSendDm,
} from './ownerDiscordOps.js';

export interface DiscordToolScope {
  channelId: string;
  guildId?: string | null;
  messageId?: string | null;
  authorId: string;
  authorName?: string;
  authorPermissions?: PermissionsBitField | null;
  client?: Client;
  guild?: Guild | null;
  channel?: unknown;
}

export const discordToolNames = [
  'discord_current_context',
  'discord_get_guild',
  'discord_get_bot_user',
  'discord_list_channels',
  'discord_list_roles',
  'discord_get_permissions',
  'discord_can_do',
  'discord_read_channel_history',
  'discord_search_channel_history',
  'discord_fetch_message',
  'discord_list_threads',
  'discord_list_emojis_stickers',
] as const;

export function createDiscordReadTools(scope: DiscordToolScope): ToolSet {
  if (!config.bot.discordToolsEnabled || !scope.client) return {};

  const tools: ToolSet = {
    discord_current_context: tool({
      description:
        'Read-only. Return current Discord guild, channel, requester, bot identity, and available Discord read tools as untrusted evidence.',
      inputSchema: z.object({}),
      execute: async () => ({
        currentTime: pacificTimeSnapshot(),
        guild: serializeGuild(scope.guild ?? null),
        channel: serializeChannel(scope.channel),
        requester: { id: scope.authorId, username: scope.authorName ?? null, owner: isOwner(scope.authorId) },
        bot: scope.client?.user ? serializeUser(scope.client.user) : null,
        readOnlyTools: [
          ...discordToolNames,
          ...(canInspectMembers(scope)
            ? [
                'discord_audit_permissions',
                'discord_get_channel_overwrites',
                'discord_get_audit_log',
                'discord_list_voice_states',
                'discord_list_invites',
                'discord_list_members',
                'discord_search_members',
                'discord_get_member',
              ]
            : []),
          ...(isOwner(scope.authorId)
            ? [
                'discord_list_bot_guilds',
                'discord_inspect_bot_guild',
                'discord_read_bot_guild_activity',
                'discord_create_owner_invite',
                'discord_send_dm',
                'discord_manage_message',
                'discord_manage_channel',
                'discord_manage_thread',
                'discord_manage_role',
                'discord_manage_member',
                'discord_manage_webhook',
                'discord_claim_administrator',
                'discord_get_application_info',
              ]
            : []),
        ],
      }),
    }),
    discord_get_guild: tool({
      description: 'Read-only. Return safe metadata for the current guild.',
      inputSchema: z.object({}),
      execute: async () => ({ guild: serializeGuild(requireCurrentGuild(scope)) }),
    }),
    discord_get_bot_user: tool({
      description: 'Read-only. Return this Discord bot user and current guild member identity.',
      inputSchema: z.object({}),
      execute: async () => {
        const guild = scope.guild ?? null;
        const botMember = guild ? await resolveBotMember(scope, guild) : null;
        return {
          botUser: scope.client?.user ? serializeUser(scope.client.user) : null,
          botMember: botMember ? serializeMember(botMember) : null,
        };
      },
    }),
    discord_list_channels: tool({
      description:
        'Read-only. List channels/threads the bot knows in the current guild, including whether message history is readable.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
      execute: async ({ limit }) => {
        const guild = requireCurrentGuild(scope);
        const channels = knownGuildChannels(scope, guild)
          .slice(0, limit)
          .map((channel) => ({ ...serializeChannel(channel), canReadHistory: canReadHistory(scope, channel) }));
        return { guild: serializeGuild(guild), channels, count: channels.length };
      },
    }),
    discord_list_roles: tool({
      description: 'Read-only. List roles in the current guild with position, color, flags, and permissions.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
      execute: async ({ limit }) => {
        const guild = requireCurrentGuild(scope);
        const roles = [...guild.roles.cache.values()]
          .sort((left, right) => right.position - left.position)
          .slice(0, limit)
          .map(serializeRole);
        return { guild: serializeGuild(guild), roles, count: roles.length };
      },
    }),
    discord_get_permissions: tool({
      description:
        'Read-only. Return channel and guild permissions for the requester, bot, or selected member. Inspecting another member requires admin or owner.',
      inputSchema: z.object({
        channel_id: z.string().optional().describe('Defaults to the current channel.'),
        user_id: z.string().optional().describe('Defaults to the requester.'),
      }),
      execute: async ({ channel_id, user_id }) => {
        const guild = requireCurrentGuild(scope);
        const channel = await resolveChannel(scope, channel_id ?? scope.channelId);
        assertSameGuildOrOwner(scope, channel);
        const targetId = user_id ?? scope.authorId;
        if (targetId !== scope.authorId && !canInspectMembers(scope)) {
          throw new Error("Inspecting another member's permissions requires guild admin or configured bot owner.");
        }
        const [member, botMember] = await Promise.all([resolveMember(guild, targetId), resolveBotMember(scope, guild)]);
        return {
          guild: serializeGuild(guild),
          channel: serializeChannel(channel),
          member: member ? serializeMember(member) : null,
          bot: botMember ? serializeMember(botMember) : scope.client?.user ? serializeUser(scope.client.user) : null,
          memberGuildPermissions: serializePermissions(member?.permissions),
          botGuildPermissions: serializePermissions(botMember?.permissions),
          memberPermissions: serializePermissions(permissionsFor(channel, member ?? targetId)),
          botPermissions: serializePermissions(permissionsFor(channel, botMember ?? scope.client?.user)),
        };
      },
    }),
    discord_can_do: tool({
      description:
        'Read-only dry run. Check whether the requester and bot have permissions for a Discord action. Does not perform the action.',
      inputSchema: z.object({
        action: z.string().min(1).max(80).describe('Examples: read_history, send, react, manage_messages, timeout_member.'),
        channel_id: z.string().optional().describe('Defaults to the current channel.'),
        user_id: z.string().optional().describe('Optional target member for hierarchy-sensitive checks.'),
      }),
      execute: async ({ action, channel_id, user_id }) => {
        const requirements = actionRequirements(action);
        const channel = await resolveChannel(scope, channel_id ?? scope.channelId);
        assertSameGuildOrOwner(scope, channel);
        const guild = requireCurrentGuild(scope);
        const [actorMember, botMember, targetMember] = await Promise.all([
          resolveMember(guild, scope.authorId),
          resolveBotMember(scope, guild),
          user_id ? resolveMember(guild, user_id) : Promise.resolve(null),
        ]);
        const actorPerms = permissionsFor(channel, actorMember ?? scope.authorId) ?? actorMember?.permissions ?? null;
        const botPerms = permissionsFor(channel, botMember ?? scope.client?.user) ?? botMember?.permissions ?? null;
        const owner = isOwner(scope.authorId);
        const actorMissing = owner ? [] : missingPermissions(actorPerms, requirements);
        const botMissing = missingPermissions(botPerms, requirements);
        const hierarchy = targetMember ? hierarchyCheck({ owner, actorMember, botMember, targetMember, action }) : { ok: true };
        return {
          action: normalizeAction(action),
          requirements,
          guild: serializeGuild(guild),
          channel: serializeChannel(channel),
          targetMember: targetMember ? serializeMember(targetMember) : null,
          actorAllowed: actorMissing.length === 0 && hierarchy.actorOk !== false,
          botAllowed: botMissing.length === 0 && hierarchy.botOk !== false,
          allowed: actorMissing.length === 0 && botMissing.length === 0 && hierarchy.ok,
          actorMissing,
          botMissing,
          hierarchy,
        };
      },
    }),
    discord_read_channel_history: tool({
      description:
        'Read-only. Fetch recent Discord messages from the current channel or another readable channel in the current guild. Includes bot messages by default.',
      inputSchema: z.object({
        channel_id: z.string().optional().describe('Defaults to the current channel.'),
        limit: z.number().int().min(1).max(50).default(20),
        include_bots: z.boolean().default(true),
      }),
      execute: async ({ channel_id, limit, include_bots }) => {
        const channel = await resolveReadableMessageChannel(scope, channel_id);
        const fetched = await channel.messages.fetch({ limit });
        const messages = [...fetched.values()]
          .filter((message) => include_bots || !message.author.bot)
          .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
          .map(serializeMessage);
        return { channel: serializeChannel(channel), messages, count: messages.length };
      },
    }),
    discord_search_channel_history: tool({
      description:
        'Read-only. Search recent Discord channel history by text or author name. Use when live context may be missing earlier human or bot messages.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        channel_id: z.string().optional().describe('Defaults to the current channel.'),
        scan_limit: z.number().int().min(1).max(100).default(50),
        result_limit: z.number().int().min(1).max(20).default(10),
        include_bots: z.boolean().default(true),
      }),
      execute: async ({ query, channel_id, scan_limit, result_limit, include_bots }) => {
        const channel = await resolveReadableMessageChannel(scope, channel_id);
        const needle = query.toLowerCase();
        const fetched = await channel.messages.fetch({ limit: scan_limit });
        const messages = [...fetched.values()]
          .filter((message) => include_bots || !message.author.bot)
          .filter((message) => messageSearchText(message).includes(needle))
          .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
          .slice(-result_limit)
          .map(serializeMessage);
        return { channel: serializeChannel(channel), query, messages, count: messages.length };
      },
    }),
    discord_fetch_message: tool({
      description: 'Read-only. Fetch one specific Discord message from a channel both the requester and bot can read.',
      inputSchema: z.object({
        channel_id: z.string().describe('Channel id containing the message.'),
        message_id: z.string().describe('Message id to fetch.'),
      }),
      execute: async ({ channel_id, message_id }) => {
        const channel = await resolveReadableMessageChannel(scope, channel_id);
        const message = await channel.messages.fetch(message_id);
        return { channel: serializeChannel(channel), message: serializeMessage(message) };
      },
    }),
    discord_list_threads: tool({
      description: 'Read-only. List known threads in the current guild or under a selected parent channel.',
      inputSchema: z.object({
        channel_id: z.string().optional().describe('Optional parent channel id. Defaults to all known guild threads.'),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: async ({ channel_id, limit }) => {
        const guild = requireCurrentGuild(scope);
        const parent = channel_id ? await resolveChannel(scope, channel_id) : null;
        if (parent) assertSameGuildOrOwner(scope, parent);
        const threads = knownGuildChannels(scope, guild)
          .filter((channel) => isThreadChannel(channel))
          .filter((channel) => !parent || stringProp(channel, 'parentId') === stringProp(parent, 'id'))
          .slice(0, limit)
          .map((channel) => ({
            ...serializeChannel(channel),
            archived: booleanProp(channel, 'archived'),
            locked: booleanProp(channel, 'locked'),
            canReadHistory: canReadHistory(scope, channel),
          }));
        return { guild: serializeGuild(guild), threads, count: threads.length };
      },
    }),
    discord_list_emojis_stickers: tool({
      description: 'Read-only. List custom emojis and stickers in the current guild.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
      execute: async ({ limit }) => {
        const guild = requireCurrentGuild(scope);
        const emojis = [...guild.emojis.cache.values()].slice(0, limit).map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          animated: emoji.animated,
          available: emoji.available,
          managed: emoji.managed,
          requiresColons: emoji.requiresColons,
          text: emoji.toString(),
        }));
        const stickers = [...guild.stickers.cache.values()].slice(0, limit).map((sticker) => ({
          id: sticker.id,
          name: sticker.name,
          description: sticker.description,
          format: sticker.format,
          available: sticker.available,
          guildId: sticker.guildId,
        }));
        return { guild: serializeGuild(guild), emojis, stickers, emojiCount: emojis.length, stickerCount: stickers.length };
      },
    }),
  };

  if (canInspectMembers(scope)) addAdminReadTools(tools, scope);
  if (isOwner(scope.authorId)) addOwnerReadTools(tools, scope);
  return tools;
}

function addAdminReadTools(tools: ToolSet, scope: DiscordToolScope): void {
  tools.discord_audit_permissions = tool({
    description: 'Admin/owner read-only. Audit bot guild permissions and per-channel capabilities. Does not change Discord state.',
    inputSchema: z.object({
      channel_id: z.string().optional().describe('Optional single channel; defaults to known guild channels.'),
      include_channels: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    execute: async ({ channel_id, include_channels, limit }) => {
      const guild = requireCurrentGuild(scope);
      const botMember = await resolveBotMember(scope, guild);
      const channels: Record<string, unknown>[] = [];
      if (include_channels) {
        const candidates = channel_id ? [await resolveChannel(scope, channel_id)] : knownGuildChannels(scope, guild);
        for (const channel of candidates.slice(0, limit)) {
          const guildId = stringProp(channel, 'guildId') ?? stringProp(objectProp(channel, 'guild'), 'id');
          if (guildId && guildId !== guild.id) continue;
          const perms = permissionsFor(channel, botMember ?? scope.client?.user);
          channels.push({
            ...serializeChannel(channel),
            botPermissions: serializePermissions(perms),
            canView: hasPermission(perms, 'ViewChannel'),
            canReadHistory: hasReadHistory(perms),
            canSend: hasPermission(perms, 'SendMessages'),
            canAttachFiles: hasPermission(perms, 'AttachFiles'),
            canManageMessages: hasPermission(perms, 'ManageMessages'),
          });
        }
      }
      return {
        guild: serializeGuild(guild),
        botMember: botMember ? serializeMember(botMember) : null,
        botGuildPermissions: serializePermissions(botMember?.permissions),
        channels,
        channelCount: channels.length,
      };
    },
  });

  tools.discord_get_channel_overwrites = tool({
    description: 'Admin/owner read-only. Read permission overwrites for a channel to debug Discord visibility.',
    inputSchema: z.object({
      channel_id: z.string().optional().describe('Defaults to the current channel.'),
    }),
    execute: async ({ channel_id }) => {
      const channel = await resolveChannel(scope, channel_id ?? scope.channelId);
      assertSameGuildOrOwner(scope, channel);
      assertCanViewChannel(scope, channel);
      return { channel: serializeChannel(channel), overwrites: serializeChannelOverwrites(scope, channel) };
    },
  });

  tools.discord_get_audit_log = tool({
    description: 'Admin/owner read-only. Read recent guild audit-log entries when both requester and bot can view the audit log.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(25).default(10),
      action: z.string().optional().describe('Optional AuditLogEvent name, e.g. MessageDelete, MemberUpdate.'),
    }),
    execute: async ({ limit, action }) => {
      const guild = requireCurrentGuild(scope);
      const [actorMember, botMember] = await Promise.all([resolveMember(guild, scope.authorId), resolveBotMember(scope, guild)]);
      if (!hasPermission(botMember?.permissions, 'ViewAuditLog')) throw new Error('Bot lacks ViewAuditLog in this guild.');
      if (!isOwner(scope.authorId) && !hasPermission(actorMember?.permissions, 'ViewAuditLog')) {
        throw new Error('Requester lacks ViewAuditLog in this guild.');
      }
      const logs = await guild.fetchAuditLogs({ limit, type: action ? auditLogAction(action) : undefined });
      const entries = [...logs.entries.values()].map(serializeAuditLogEntry);
      return { guild: serializeGuild(guild), entries, count: entries.length };
    },
  });

  tools.discord_list_voice_states = tool({
    description: 'Admin/owner read-only. List visible voice states in the current guild.',
    inputSchema: z.object({
      channel_id: z.string().optional().describe('Optional voice channel id filter.'),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async ({ channel_id, limit }) => {
      const guild = requireCurrentGuild(scope);
      const voiceStates = [...guild.voiceStates.cache.values()]
        .filter((state) => !channel_id || state.channelId === channel_id)
        .slice(0, limit)
        .map((state) => ({
          userId: state.id,
          channelId: state.channelId,
          channelName: state.channel?.name ?? null,
          selfMute: state.selfMute,
          selfDeaf: state.selfDeaf,
          serverMute: state.serverMute,
          serverDeaf: state.serverDeaf,
          streaming: state.streaming,
          suppress: state.suppress,
        }));
      return { guild: serializeGuild(guild), voiceStates, count: voiceStates.length };
    },
  });

  tools.discord_list_invites = tool({
    description: 'Admin/owner read-only. List guild or channel invites when requester and bot have invite-management visibility.',
    inputSchema: z.object({
      channel_id: z.string().optional().describe('Optional channel id.'),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async ({ channel_id, limit }) => {
      const guild = requireCurrentGuild(scope);
      const botMember = await resolveBotMember(scope, guild);
      const actorMember = await resolveMember(guild, scope.authorId);
      if (!hasPermission(botMember?.permissions, 'ManageGuild')) throw new Error('Bot lacks ManageGuild for invite listing.');
      if (!isOwner(scope.authorId) && !hasPermission(actorMember?.permissions, 'ManageGuild')) {
        throw new Error('Requester lacks ManageGuild for invite listing.');
      }
      const invites = channel_id
        ? await (await resolveChannel(scope, channel_id) as { fetchInvites?: () => Promise<Map<string, unknown>> }).fetchInvites?.()
        : await guild.invites.fetch();
      const rows = [...(invites?.values() ?? [])].slice(0, limit).map(serializeInvite);
      return { guild: serializeGuild(guild), invites: rows, count: rows.length };
    },
  });

  tools.discord_list_members = tool({
    description: 'Admin/owner read-only. List cached guild members. Requires Guild Members intent for reliable output.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(50),
      include_bots: z.boolean().default(true),
    }),
    execute: async ({ limit, include_bots }) => {
      const guild = requireCurrentGuild(scope);
      const members = [...guild.members.cache.values()]
        .filter((member) => include_bots || !member.user.bot)
        .slice(0, limit)
        .map(serializeMember);
      return { guild: serializeGuild(guild), members, count: members.length, cachedOnly: true };
    },
  });

  tools.discord_search_members = tool({
    description: 'Admin/owner read-only. Search guild members by id, username, display name, nickname, or global name.',
    inputSchema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(50).default(25),
      include_bots: z.boolean().default(true),
    }),
    execute: async ({ query, limit, include_bots }) => {
      const guild = requireCurrentGuild(scope);
      const needle = query.toLowerCase();
      let matched = [...guild.members.cache.values()].filter((member) => {
        if (!include_bots && member.user.bot) return false;
        return memberSearchText(member).includes(needle);
      });
      if (matched.length === 0) {
        const searched = await guild.members.search({ query, limit }).catch(() => null);
        matched = searched ? [...searched.values()] : [];
        if (!include_bots) matched = matched.filter((member) => !member.user.bot);
      }
      const members = matched.slice(0, limit).map(serializeMember);
      return { guild: serializeGuild(guild), query, members, count: members.length };
    },
  });

  tools.discord_get_member = tool({
    description: 'Admin/owner read-only. Return details for one guild member by Discord user id.',
    inputSchema: z.object({
      user_id: z.string().min(1).max(40),
    }),
    execute: async ({ user_id }) => {
      const guild = requireCurrentGuild(scope);
      const member = await resolveMember(guild, user_id);
      if (!member) throw new Error(`Member ${user_id} was not found in this guild.`);
      return { guild: serializeGuild(guild), member: serializeMember(member) };
    },
  });
}

function addOwnerReadTools(tools: ToolSet, scope: DiscordToolScope): void {
  tools.discord_list_bot_guilds = tool({
    description: 'Owner-only read-only. List guilds this Discord bot is currently in.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async ({ limit }) => {
      const guilds = scope.client ? await listBotGuilds(scope.client, limit) : [];
      return { guilds, count: guilds.length };
    },
  });
  tools.discord_inspect_bot_guild = tool({
    description:
      'Owner-only read-only. Inspect any guild this bot is in, including bot permissions, roles, and per-channel read/send/invite access.',
    inputSchema: z.object({
      guild_id: z.string().min(1).max(40).describe('Guild id from discord_list_bot_guilds'),
    }),
    execute: async ({ guild_id }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return inspectBotGuild(scope.client, guild_id);
    },
  });
  tools.discord_read_bot_guild_activity = tool({
    description:
      'Owner-only read-only. Read bounded recent activity across readable channels in any guild this bot is in. Includes human and bot messages.',
    inputSchema: z.object({
      guild_id: z.string().min(1).max(40).describe('Guild id from discord_list_bot_guilds'),
      channel_limit: z.number().int().min(1).max(20).default(8),
      messages_per_channel: z.number().int().min(1).max(25).default(10),
    }),
    execute: async ({ guild_id, channel_limit, messages_per_channel }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return readBotGuildActivity(scope.client, guild_id, channel_limit, messages_per_channel);
    },
  });
  tools.discord_create_owner_invite = tool({
    description:
      'Owner-only write. Create a one-use expiring invite in another guild and DM it to the configured owner. Never repeat the invite URL in a public reply.',
    inputSchema: z.object({
      guild_id: z.string().min(1).max(40).describe('Target guild id from discord_list_bot_guilds'),
      channel_id: z.string().min(1).max(40).optional().describe('Optional invite channel id'),
      max_age_hours: z.number().int().min(1).max(168).default(24),
    }),
    execute: async ({ guild_id, channel_id, max_age_hours }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      const invite = await createOwnerGuildInvite(scope.client, guild_id, scope.authorId, {
        ...(channel_id ? { channelId: channel_id } : {}),
        maxAgeSeconds: max_age_hours * 3600,
        maxUses: 1,
      });
      const guildName = String(invite.guild.name ?? guild_id);
      await deliverOwnerInvite(scope.client, scope.authorId, invite.url, guildName);
      return {
        created: true,
        deliveredToOwnerDm: true,
        guild: invite.guild,
        channel: invite.channel,
        maxAgeSeconds: invite.maxAgeSeconds,
        maxUses: invite.maxUses,
      };
    },
  });
  tools.discord_send_dm = tool({
    description: 'Owner-only write. Send a DM from the bot only when the configured owner explicitly asks for it.',
    inputSchema: z.object({
      user_id: z.string().min(1).max(40),
      message: z.string().min(1).max(1900),
    }),
    execute: async ({ user_id, message }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerSendDm(scope.client, user_id, message);
    },
  });
  tools.discord_manage_message = tool({
    description:
      'Owner-only write. Send, edit, delete, or react to a Discord message in any accessible channel. Use only for an explicit owner request.',
    inputSchema: z.object({
      action: z.enum(['send', 'edit', 'delete', 'react']),
      channel_id: z.string().min(1).max(40),
      message_id: z.string().min(1).max(40).optional(),
      content: z.string().min(1).max(1900).optional(),
      emoji: z.string().min(1).max(100).optional(),
    }),
    execute: async ({ action, channel_id, message_id, content, emoji }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageMessage(scope.client, { action, channelId: channel_id, messageId: message_id, content, emoji });
    },
  });
  tools.discord_manage_channel = tool({
    description:
      'Owner-only write. Create, edit, or delete a text channel in any guild the bot is in. Deletion requires an explicit owner request and Discord ManageChannels.',
    inputSchema: z.object({
      action: z.enum(['create', 'edit', 'delete']),
      guild_id: z.string().min(1).max(40),
      channel_id: z.string().min(1).max(40).optional(),
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      parent_id: z.string().min(1).max(40).optional(),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ action, guild_id, channel_id, name, topic, parent_id, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageChannel(scope.client, {
        action,
        guildId: guild_id,
        channelId: channel_id,
        name,
        topic,
        parentId: parent_id,
        reason,
      });
    },
  });
  tools.discord_manage_thread = tool({
    description: 'Owner-only write. Create, archive, unarchive, lock, or unlock a thread after checking channel permissions.',
    inputSchema: z.object({
      action: z.enum(['create', 'archive', 'unarchive', 'lock', 'unlock']),
      channel_id: z.string().min(1).max(40),
      name: z.string().min(1).max(100).optional(),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ action, channel_id, name, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageThread(scope.client, { action, channelId: channel_id, name, reason });
    },
  });
  tools.discord_manage_role = tool({
    description:
      'Owner-only write. Create/edit/delete roles or add/remove a role from a member. Discord ManageRoles and role hierarchy are enforced.',
    inputSchema: z.object({
      action: z.enum(['create', 'edit', 'delete', 'add_to_member', 'remove_from_member']),
      guild_id: z.string().min(1).max(40),
      role_id: z.string().min(1).max(40).optional(),
      user_id: z.string().min(1).max(40).optional(),
      name: z.string().min(1).max(100).optional(),
      color: z.string().max(7).optional(),
      permissions: z.array(z.string().min(1).max(60)).max(50).optional(),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ action, guild_id, role_id, user_id, name, color, permissions, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageRole(scope.client, {
        action,
        guildId: guild_id,
        roleId: role_id,
        userId: user_id,
        name,
        color,
        permissions,
        reason,
      });
    },
  });
  tools.discord_manage_member = tool({
    description:
      'Owner-only write. Timeout, clear timeout, kick, ban, unban, or change a nickname. Discord permissions and role hierarchy are enforced.',
    inputSchema: z.object({
      action: z.enum(['timeout', 'clear_timeout', 'kick', 'ban', 'unban', 'nickname']),
      guild_id: z.string().min(1).max(40),
      user_id: z.string().min(1).max(40),
      duration_minutes: z.number().int().min(1).max(40320).optional(),
      nickname: z.string().max(32).optional(),
      delete_message_seconds: z.number().int().min(0).max(604800).optional(),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ action, guild_id, user_id, duration_minutes, nickname, delete_message_seconds, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageMember(scope.client, {
        action,
        guildId: guild_id,
        userId: user_id,
        durationMinutes: duration_minutes,
        nickname,
        deleteMessageSeconds: delete_message_seconds,
        reason,
      });
    },
  });
  tools.discord_manage_webhook = tool({
    description:
      'Owner-only write. List/create/send/delete webhooks in accessible channels. ManageWebhooks is checked for channel operations.',
    inputSchema: z.object({
      action: z.enum(['list', 'create', 'send', 'delete']),
      channel_id: z.string().min(1).max(40).optional(),
      webhook_id: z.string().min(1).max(40).optional(),
      name: z.string().min(1).max(80).optional(),
      content: z.string().min(1).max(1900).optional(),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ action, channel_id, webhook_id, name, content, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerManageWebhook(scope.client, {
        action,
        channelId: channel_id,
        webhookId: webhook_id,
        name,
        content,
        reason,
      });
    },
  });
  tools.discord_claim_administrator = tool({
    description:
      'Owner-only write. From the configured owner DM, grant that same owner Administrator in a target guild by assigning a manageable admin role or creating one when Discord permits. Execute directly when the owner asks; do not add an extra confirmation step.',
    inputSchema: z.object({
      guild_id: z.string().min(1).max(40),
      role_id: z.string().min(1).max(40).optional().describe('Optional existing Administrator role id'),
      reason: z.string().max(400).optional(),
    }),
    execute: async ({ guild_id, role_id, reason }) => {
      if (!scope.client) throw new Error('Discord client is unavailable.');
      return ownerClaimAdministrator(scope.client, {
        guildId: guild_id,
        ownerUserId: scope.authorId,
        roleId: role_id,
        reason,
      });
    },
  });
  tools.discord_get_application_info = tool({
    description: 'Owner-only read-only. Return safe Discord application metadata without token or credential material.',
    inputSchema: z.object({}),
    execute: async () => {
      const application = await scope.client?.application?.fetch().catch(() => scope.client?.application ?? null);
      return { application: serializeApplication(application) };
    },
  });
}

function isOwner(userId: string): boolean {
  return config.bot.ownerUserIds.length === 0 || config.bot.ownerUserIds.includes(userId);
}

function canInspectMembers(scope: DiscordToolScope): boolean {
  return isOwner(scope.authorId) || isGuildAdmin(scope);
}

function isGuildAdmin(scope: DiscordToolScope): boolean {
  const permissions =
    scope.authorPermissions ?? scope.guild?.members.cache.get(scope.authorId)?.permissions ?? permissionsFor(scope.channel, scope.authorId);
  return Boolean(permissions?.has(PermissionsBitField.Flags.Administrator));
}

function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function actionRequirements(action: string): string[] {
  const normalized = normalizeAction(action);
  const aliases: Record<string, string[]> = {
    read: ['ViewChannel', 'ReadMessageHistory'],
    read_history: ['ViewChannel', 'ReadMessageHistory'],
    send: ['ViewChannel', 'SendMessages'],
    send_message: ['ViewChannel', 'SendMessages'],
    send_file: ['ViewChannel', 'SendMessages', 'AttachFiles'],
    react: ['ViewChannel', 'ReadMessageHistory', 'AddReactions'],
    create_thread: ['ViewChannel', 'CreatePublicThreads'],
    manage_messages: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'],
    manage_threads: ['ViewChannel', 'ManageThreads'],
    manage_channels: ['ManageChannels'],
    manage_roles: ['ManageRoles'],
    create_invite: ['ViewChannel', 'CreateInstantInvite'],
    manage_webhooks: ['ViewChannel', 'ManageWebhooks'],
    audit_log: ['ViewAuditLog'],
    list_invites: ['ManageGuild'],
    timeout_member: ['ModerateMembers'],
    kick_member: ['KickMembers'],
    ban_member: ['BanMembers'],
    move_voice: ['MoveMembers'],
    disconnect_voice: ['MoveMembers'],
  };
  const direct = aliases[normalized] ?? pascalPermissionName(normalized);
  if (!direct) throw new Error(`Unknown Discord action or permission: ${action}`);
  return Array.isArray(direct) ? direct : [direct];
}

function pascalPermissionName(value: string): string | null {
  const name = value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
  return name in PermissionsBitField.Flags ? name : null;
}

function missingPermissions(permissions: PermissionsBitField | null, requirements: string[]): string[] {
  return requirements.filter((requirement) => !hasPermission(permissions, requirement));
}

function hasPermission(permissions: PermissionsBitField | null | undefined, permission: string): boolean {
  if (!permissions) return false;
  const flag = PermissionsBitField.Flags[permission as keyof typeof PermissionsBitField.Flags];
  return flag != null && permissions.has(flag);
}

function hierarchyCheck(input: {
  owner: boolean;
  actorMember: GuildMember | null;
  botMember: GuildMember | null;
  targetMember: GuildMember;
  action: string;
}): Record<string, unknown> {
  const normalized = normalizeAction(input.action);
  if (!['timeout_member', 'kick_member', 'ban_member', 'move_voice', 'disconnect_voice'].includes(normalized)) {
    return { ok: true };
  }
  const actorOk = input.owner || memberCanModerateTarget(input.actorMember, input.targetMember);
  const botOk = memberCanModerateTarget(input.botMember, input.targetMember);
  return {
    ok: actorOk && botOk,
    actorOk,
    botOk,
    reason:
      actorOk && botOk
        ? null
        : 'Discord role hierarchy requires the actor and bot to be above the target member, unless the actor is the configured owner.',
  };
}

function memberCanModerateTarget(actor: GuildMember | null, target: GuildMember): boolean {
  if (!actor) return false;
  if (actor.id === target.id) return false;
  if (actor.guild.ownerId === actor.id) return true;
  if (target.guild.ownerId === target.id) return false;
  return actor.roles.highest.position > target.roles.highest.position;
}

function requireCurrentGuild(scope: DiscordToolScope): Guild {
  if (!scope.guild) throw new Error('This Discord read tool requires a guild context.');
  return scope.guild;
}

function knownGuildChannels(scope: DiscordToolScope, guild: Guild): unknown[] {
  const byId = new Map<string, unknown>();
  for (const channel of guild.channels.cache.values()) byId.set(channel.id, channel);
  for (const channel of scope.client?.channels.cache.values() ?? []) {
    const guildId = 'guildId' in channel ? channel.guildId : null;
    if (guildId === guild.id) byId.set(channel.id, channel);
  }
  return [...byId.values()].sort((left, right) => {
    const leftParent = stringProp(left, 'parentId') ?? '';
    const rightParent = stringProp(right, 'parentId') ?? '';
    if (leftParent !== rightParent) return leftParent.localeCompare(rightParent);
    return numberProp(left, 'position') - numberProp(right, 'position');
  });
}

async function resolveReadableMessageChannel(
  scope: DiscordToolScope,
  channelId: string | undefined,
): Promise<MessageFetchChannel & { id: string }> {
  const channel = await resolveChannel(scope, channelId ?? scope.channelId);
  assertSameGuildOrOwner(scope, channel);
  if (!isMessageFetchChannel(channel)) throw new Error(`Channel ${stringProp(channel, 'id') ?? channelId} does not expose message history.`);
  if (!canReadHistory(scope, channel)) throw new Error(`Channel ${channel.id} is not readable by both the requester and bot.`);
  return channel;
}

async function resolveChannel(scope: DiscordToolScope, channelId: string): Promise<unknown> {
  if (scope.channel && stringProp(scope.channel, 'id') === channelId) return scope.channel;
  const cached = scope.client?.channels.cache.get(channelId);
  if (cached) return cached;
  const fetched = await scope.client?.channels.fetch(channelId).catch(() => null);
  if (fetched) return fetched;
  throw new Error(`Channel ${channelId} was not found in the bot cache.`);
}

function assertSameGuildOrOwner(scope: DiscordToolScope, channel: unknown): void {
  const guildId = stringProp(channel, 'guildId') ?? stringProp(objectProp(channel, 'guild'), 'id');
  if (!guildId || !scope.guild?.id || guildId === scope.guild.id) return;
  if (!isOwner(scope.authorId)) throw new Error('Reading another guild requires configured bot owner.');
}

function canReadHistory(scope: DiscordToolScope, channel: unknown): boolean {
  if (!isMessageFetchChannel(channel)) return false;
  const botSubject = botSubjectForChannel(scope, channel);
  const botPerms = permissionsFor(channel, botSubject);
  if (!hasReadHistory(botPerms)) return false;
  if (isOwner(scope.authorId)) return true;
  const actorPerms = permissionsFor(channel, scope.authorId);
  return hasReadHistory(actorPerms);
}

function assertCanViewChannel(scope: DiscordToolScope, channel: unknown): void {
  const botSubject = botSubjectForChannel(scope, channel);
  if (!hasPermission(permissionsFor(channel, botSubject), 'ViewChannel')) {
    throw new Error(`Bot cannot view channel ${stringProp(channel, 'id') ?? scope.channelId}.`);
  }
  if (isOwner(scope.authorId)) return;
  if (!hasPermission(permissionsFor(channel, scope.authorId), 'ViewChannel')) {
    throw new Error(`Requester cannot view channel ${stringProp(channel, 'id') ?? scope.channelId}.`);
  }
}

function botSubjectForChannel(scope: DiscordToolScope, channel: unknown): unknown {
  const guildId = stringProp(channel, 'guildId') ?? stringProp(objectProp(channel, 'guild'), 'id');
  const targetGuild = guildId ? scope.client?.guilds.cache.get(guildId) : null;
  return targetGuild?.members.me ?? scope.client?.user?.id ?? null;
}

function permissionsFor(channel: unknown, subject: unknown): PermissionsBitField | null {
  if (!channel || typeof channel !== 'object') return null;
  if (!subject) return null;
  const fn = (channel as { permissionsFor?: (target: unknown) => PermissionsBitField | null }).permissionsFor;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(channel, subject);
  } catch {
    return null;
  }
}

async function resolveMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  return guild.members.fetch(userId).catch(() => null);
}

async function resolveBotMember(scope: DiscordToolScope, guild: Guild): Promise<GuildMember | null> {
  if (guild.members.me) return guild.members.me;
  const botId = scope.client?.user?.id;
  return botId ? resolveMember(guild, botId) : null;
}

function hasReadHistory(permissions: PermissionsBitField | null): boolean {
  return Boolean(permissions?.has(PermissionsBitField.Flags.ViewChannel) && permissions.has(PermissionsBitField.Flags.ReadMessageHistory));
}

type MessageFetchChannel = {
  id: string;
  messages: {
    fetch(options: { limit: number }): Promise<Map<string, Message>>;
    fetch(message: string): Promise<Message>;
  };
};

function isMessageFetchChannel(channel: unknown): channel is MessageFetchChannel {
  if (!channel || typeof channel !== 'object') return false;
  const messages = (channel as Partial<MessageFetchChannel>).messages;
  return Boolean(messages) && typeof messages?.fetch === 'function' && typeof (channel as { id?: unknown }).id === 'string';
}

function isThreadChannel(channel: unknown): boolean {
  return [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(numberProp(channel, 'type'));
}

function serializeGuild(guild: Guild | null): Record<string, unknown> | null {
  if (!guild) return null;
  return {
    id: guild.id,
    name: guild.name,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
    channelCount: guild.channels.cache.size,
    roleCount: guild.roles.cache.size,
    features: guild.features.slice(0, 30),
  };
}

function serializeChannel(channel: unknown): Record<string, unknown> | null {
  if (!channel) return null;
  return {
    id: stringProp(channel, 'id'),
    name: stringProp(channel, 'name'),
    type: numberProp(channel, 'type'),
    guildId: stringProp(channel, 'guildId') ?? stringProp(objectProp(channel, 'guild'), 'id'),
    parentId: stringProp(channel, 'parentId'),
    position: numberProp(channel, 'position'),
    topic: clampString(stringProp(channel, 'topic'), 240),
    nsfw: booleanProp(channel, 'nsfw'),
  };
}

function serializeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    timestamp: message.createdAt.toISOString(),
    author: serializeUser(message.author),
    authorIsBot: message.author.bot,
    content: clampString(message.cleanContent || message.content, 1200),
    attachmentCount: message.attachments.size,
    attachments: [...message.attachments.values()].slice(0, 8).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      contentType: attachment.contentType,
    })),
    replyTo: message.reference?.messageId ?? null,
  };
}

function serializeRole(role: Role): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    managed: role.managed,
    mentionable: role.mentionable,
    hoist: role.hoist,
    color: role.hexColor === '#000000' ? null : role.hexColor,
    permissions: serializePermissions(role.permissions),
  };
}

function serializeMember(member: GuildMember): Record<string, unknown> {
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .sort((left, right) => right.position - left.position)
    .slice(0, 30)
    .map((role) => ({ id: role.id, name: role.name, position: role.position }));
  return {
    id: member.id,
    username: member.user.username,
    globalName: member.user.globalName,
    displayName: member.displayName,
    nickname: member.nickname,
    bot: member.user.bot,
    roles,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    premiumSince: member.premiumSince?.toISOString() ?? null,
    permissions: serializePermissions(member.permissions),
  };
}

function serializeUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName,
    bot: user.bot,
  };
}

function serializeApplication(application: unknown): Record<string, unknown> | null {
  if (!application || typeof application !== 'object') return null;
  const owner = objectProp(application, 'owner');
  const ownerUser = owner && typeof owner === 'object' && typeof (owner as { username?: unknown }).username === 'string' ? (owner as User) : null;
  return {
    id: stringProp(application, 'id'),
    name: stringProp(application, 'name'),
    description: stringProp(application, 'description'),
    botPublic: booleanProp(application, 'botPublic'),
    botRequireCodeGrant: booleanProp(application, 'botRequireCodeGrant'),
    owner: ownerUser ? serializeUser(ownerUser) : null,
    team: stringProp(objectProp(application, 'team'), 'name'),
  };
}

function serializeChannelOverwrites(scope: DiscordToolScope, channel: unknown): Record<string, unknown>[] {
  const cache = objectProp(objectProp(channel, 'permissionOverwrites'), 'cache') as { values?: () => Iterable<unknown> } | undefined;
  if (!cache || typeof cache.values !== 'function') return [];
  return [...cache.values()].map((overwrite) => {
    const id = stringProp(overwrite, 'id') ?? '';
    const role = scope.guild?.roles.cache.get(id);
    const member = scope.guild?.members.cache.get(id);
    const typeValue = objectProp(overwrite, 'type');
    return {
      target: role
        ? { id: role.id, name: role.name, type: 'role' }
        : member
          ? { id: member.id, name: member.displayName, type: 'member' }
          : { id, name: id, type: typeValue === 0 ? 'role' : typeValue === 1 ? 'member' : String(typeValue ?? 'unknown') },
      allow: serializePermissions(objectProp(overwrite, 'allow') as PermissionsBitField | null | undefined)?.names ?? [],
      deny: serializePermissions(objectProp(overwrite, 'deny') as PermissionsBitField | null | undefined)?.names ?? [],
    };
  });
}

function auditLogAction(action: string): AuditLogEvent {
  const normalized = action.trim().toLowerCase().replace(/[-_\s]+/g, '');
  for (const [name, value] of Object.entries(AuditLogEvent)) {
    if (name.toLowerCase() === normalized && typeof value === 'number') return value;
  }
  throw new Error(`Unknown audit log action: ${action}`);
}

function auditLogEventName(action: unknown): string {
  if (typeof action === 'number') return Object.entries(AuditLogEvent).find(([, value]) => value === action)?.[0] ?? String(action);
  return String(action ?? '');
}

function serializeAuditLogEntry(entry: unknown): Record<string, unknown> {
  const executor = objectProp(entry, 'executor');
  const target = objectProp(entry, 'target');
  return {
    id: stringProp(entry, 'id'),
    action: auditLogEventName(objectProp(entry, 'action')),
    executor: isUserLike(executor) ? serializeUser(executor) : null,
    targetId: stringProp(entry, 'targetId') ?? stringProp(target, 'id'),
    target: clampString(stringProp(target, 'name') ?? stringProp(target, 'username') ?? String(target ?? ''), 120),
    reason: clampString(stringProp(entry, 'reason'), 300),
    changes: serializeAuditChanges(objectProp(entry, 'changes')),
    createdAt: objectProp(entry, 'createdAt') instanceof Date ? (objectProp(entry, 'createdAt') as Date).toISOString() : null,
  };
}

function serializeInvite(invite: unknown): Record<string, unknown> {
  const inviter = objectProp(invite, 'inviter');
  const channel = objectProp(invite, 'channel');
  const createdAt = objectProp(invite, 'createdAt');
  const expiresAt = objectProp(invite, 'expiresAt');
  return {
    code: stringProp(invite, 'code'),
    url: stringProp(invite, 'url'),
    channelId: stringProp(channel, 'id') ?? stringProp(invite, 'channelId'),
    channelName: stringProp(channel, 'name'),
    inviter: isUserLike(inviter) ? serializeUser(inviter) : null,
    uses: numberProp(invite, 'uses'),
    maxUses: numberProp(invite, 'maxUses'),
    maxAge: numberProp(invite, 'maxAge'),
    temporary: booleanProp(invite, 'temporary'),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : null,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : null,
  };
}

function serializeAuditChanges(changes: unknown): Record<string, unknown>[] {
  const values = Array.isArray(changes)
    ? changes
    : changes && typeof changes === 'object' && typeof (changes as { values?: unknown }).values === 'function'
      ? [...((changes as { values: () => Iterable<unknown> }).values())]
      : [];
  return values.slice(0, 20).map((change) => ({
    key: stringProp(change, 'key') ?? stringProp(change, 'attribute'),
    old: clampString(String(objectProp(change, 'old') ?? objectProp(change, 'before') ?? ''), 300),
    new: clampString(String(objectProp(change, 'new') ?? objectProp(change, 'after') ?? ''), 300),
  }));
}

function serializePermissions(permissions: PermissionsBitField | null | undefined): Record<string, unknown> | null {
  if (!permissions) return null;
  return {
    bitfield: permissions.bitfield.toString(),
    names: permissions.toArray(),
  };
}

function messageSearchText(message: Message): string {
  return [message.content, message.cleanContent, message.author.username, message.author.globalName ?? '', message.author.displayName ?? '']
    .join('\n')
    .toLowerCase();
}

function memberSearchText(member: GuildMember): string {
  return [member.id, member.user.username, member.user.globalName ?? '', member.displayName, member.nickname ?? ''].join('\n').toLowerCase();
}

function isUserLike(value: unknown): value is User {
  return Boolean(value && typeof value === 'object' && typeof (value as { username?: unknown }).username === 'string');
}

function objectProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringProp(value: unknown, key: string): string | undefined {
  const prop = objectProp(value, key);
  return typeof prop === 'string' ? prop : undefined;
}

function numberProp(value: unknown, key: string): number {
  const prop = objectProp(value, key);
  return typeof prop === 'number' ? prop : 0;
}

function booleanProp(value: unknown, key: string): boolean | undefined {
  const prop = objectProp(value, key);
  return typeof prop === 'boolean' ? prop : undefined;
}

function clampString(value: string | undefined, max = 1000): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
