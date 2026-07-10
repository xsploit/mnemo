import {
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
} from 'discord.js';

export interface OwnerInviteOptions {
  channelId?: string;
  maxAgeSeconds?: number;
  maxUses?: number;
}

export async function listBotGuilds(client: Client, limit = 100): Promise<Record<string, unknown>[]> {
  return [...client.guilds.cache.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, clamp(limit, 1, 100))
    .map(serializeGuildSummary);
}

export async function inspectBotGuild(client: Client, guildId: string): Promise<Record<string, unknown>> {
  const guild = await resolveBotGuild(client, guildId);
  await Promise.allSettled([guild.channels.fetch(), guild.roles.fetch()]);
  const botMember = await resolveBotMember(guild);
  const channels = [...guild.channels.cache.values()]
    .sort(compareChannels)
    .map((channel) => serializeChannelAccess(channel, botMember));
  const roles = [...guild.roles.cache.values()]
    .sort((left, right) => right.position - left.position)
    .slice(0, 100)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed,
      permissions: role.permissions.toArray().sort(),
    }));

  return {
    guild: serializeGuildSummary(guild),
    botMember: botMember
      ? {
          id: botMember.id,
          displayName: botMember.displayName,
          joinedAt: botMember.joinedAt?.toISOString() ?? null,
          permissions: botMember.permissions.toArray().sort(),
          highestRole: botMember.roles.highest.name,
        }
      : null,
    channels,
    roles,
  };
}

export async function readBotGuildActivity(
  client: Client,
  guildId: string,
  channelLimit = 8,
  messagesPerChannel = 10,
): Promise<Record<string, unknown>> {
  const guild = await resolveBotGuild(client, guildId);
  await guild.channels.fetch().catch(() => null);
  const botMember = await resolveBotMember(guild);
  if (!botMember) throw new Error(`Could not resolve the bot member in guild ${guild.id}.`);

  const candidates = [...guild.channels.cache.values()]
    .filter(isHistoryChannel)
    .filter((channel) => canReadHistory(channel, botMember))
    .sort(compareRecentChannels)
    .slice(0, clamp(channelLimit, 1, 20));

  const activity: Record<string, unknown>[] = [];
  for (const channel of candidates) {
    try {
      const fetched = await channel.messages.fetch({ limit: clamp(messagesPerChannel, 1, 25) });
      const messages = [...fetched.values()]
        .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
        .map(serializeMessage);
      activity.push({ channel: serializeChannelAccess(channel, botMember), messages, count: messages.length });
    } catch (error) {
      activity.push({
        channel: serializeChannelAccess(channel, botMember),
        messages: [],
        count: 0,
        error: errorMessage(error),
      });
    }
  }

  return { guild: serializeGuildSummary(guild), activity, channelCount: activity.length };
}

export async function createOwnerGuildInvite(
  client: Client,
  guildId: string,
  ownerUserId: string,
  options: OwnerInviteOptions = {},
): Promise<{ guild: Record<string, unknown>; channel: Record<string, unknown>; url: string; code: string; maxAgeSeconds: number; maxUses: number }> {
  const guild = await resolveBotGuild(client, guildId);
  await guild.channels.fetch().catch(() => null);
  const botMember = await resolveBotMember(guild);
  if (!botMember) throw new Error(`Could not resolve the bot member in guild ${guild.id}.`);

  const requestedChannel = options.channelId ? guild.channels.cache.get(options.channelId) : null;
  if (options.channelId && !requestedChannel) {
    throw new Error(`Channel ${options.channelId} is not in guild ${guild.id}.`);
  }

  const candidates = requestedChannel
    ? [requestedChannel]
    : [guild.systemChannel, ...[...guild.channels.cache.values()].sort(compareChannels)].filter(
        (channel): channel is GuildBasedChannel => Boolean(channel),
      );
  const channel = candidates.find((candidate) => isInviteChannel(candidate) && canCreateInvite(candidate, botMember));
  if (!channel || !isInviteChannel(channel)) {
    throw new Error(`The bot has no channel with ViewChannel and CreateInstantInvite in guild ${guild.id}.`);
  }

  const maxAgeSeconds = clamp(options.maxAgeSeconds ?? 86_400, 300, 604_800);
  const maxUses = clamp(options.maxUses ?? 1, 1, 100);
  const invite = await channel.createInvite({
    maxAge: maxAgeSeconds,
    maxUses,
    temporary: false,
    unique: true,
    reason: `Configured owner recovery invite requested by ${ownerUserId}`,
  });

  return {
    guild: serializeGuildSummary(guild),
    channel: serializeChannelAccess(channel, botMember),
    url: invite.url,
    code: invite.code,
    maxAgeSeconds,
    maxUses,
  };
}

export async function deliverOwnerInvite(client: Client, ownerUserId: string, inviteUrl: string, guildName: string): Promise<void> {
  const owner = await client.users.fetch(ownerUserId);
  await owner.send({
    content: `Owner invite for **${guildName}**: ${inviteUrl}`,
    allowedMentions: { parse: [] },
  });
}

async function resolveBotGuild(client: Client, guildId: string): Promise<Guild> {
  const id = guildId.trim();
  if (!id) throw new Error('Guild id is required.');
  const cached = client.guilds.cache.get(id);
  if (cached) return cached;
  const fetched = await client.guilds.fetch(id).catch(() => null);
  if (!fetched) throw new Error(`The bot is not in guild ${id}, or Discord did not expose it.`);
  return fetched;
}

async function resolveBotMember(guild: Guild): Promise<GuildMember | null> {
  if (guild.members.me) return guild.members.me;
  return guild.members.fetchMe().catch(() => null);
}

function serializeGuildSummary(guild: Guild): Record<string, unknown> {
  return {
    id: guild.id,
    name: guild.name,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
    channelCount: guild.channels.cache.size,
    roleCount: guild.roles.cache.size,
    joinedAt: guild.joinedAt?.toISOString() ?? null,
    preferredLocale: guild.preferredLocale,
    features: guild.features.slice(0, 30),
  };
}

function serializeChannelAccess(channel: GuildBasedChannel, botMember: GuildMember | null): Record<string, unknown> {
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  return {
    id: channel.id,
    name: 'name' in channel ? channel.name : null,
    type: channel.type,
    parentId: 'parentId' in channel ? channel.parentId : null,
    position: 'position' in channel ? channel.position : null,
    view: hasPermission(permissions, PermissionsBitField.Flags.ViewChannel),
    readHistory: canReadHistory(channel, botMember),
    sendMessages:
      hasPermission(permissions, PermissionsBitField.Flags.SendMessages) ||
      hasPermission(permissions, PermissionsBitField.Flags.SendMessagesInThreads),
    createInvite: isInviteChannel(channel) && canCreateInvite(channel, botMember),
  };
}

function serializeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    timestamp: message.createdAt.toISOString(),
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.displayName,
      bot: message.author.bot,
    },
    content: clampText(message.cleanContent || message.content, 1200),
    attachmentCount: message.attachments.size,
    replyTo: message.reference?.messageId ?? null,
  };
}

function canReadHistory(channel: GuildBasedChannel, botMember: GuildMember | null): boolean {
  if (!botMember || !isHistoryChannel(channel)) return false;
  const permissions = channel.permissionsFor(botMember);
  return (
    hasPermission(permissions, PermissionsBitField.Flags.ViewChannel) &&
    hasPermission(permissions, PermissionsBitField.Flags.ReadMessageHistory)
  );
}

function canCreateInvite(channel: GuildBasedChannel, botMember: GuildMember | null): boolean {
  if (!botMember) return false;
  const permissions = channel.permissionsFor(botMember);
  return (
    hasPermission(permissions, PermissionsBitField.Flags.ViewChannel) &&
    hasPermission(permissions, PermissionsBitField.Flags.CreateInstantInvite)
  );
}

function hasPermission(permissions: Readonly<PermissionsBitField> | null, flag: bigint): boolean {
  return Boolean(permissions?.has(flag));
}

type HistoryChannel = GuildBasedChannel & {
  messages: { fetch(options: { limit: number }): Promise<{ values(): IterableIterator<Message> }> };
  lastMessageId?: string | null;
};

type InviteChannel = GuildBasedChannel & {
  createInvite(options: {
    maxAge: number;
    maxUses: number;
    temporary: boolean;
    unique: boolean;
    reason: string;
  }): Promise<{ url: string; code: string }>;
};

function isHistoryChannel(channel: GuildBasedChannel): channel is HistoryChannel {
  return 'messages' in channel && typeof channel.messages?.fetch === 'function';
}

function isInviteChannel(channel: GuildBasedChannel): channel is InviteChannel {
  return 'createInvite' in channel && typeof channel.createInvite === 'function';
}

function compareChannels(left: GuildBasedChannel, right: GuildBasedChannel): number {
  const leftParent = 'parentId' in left ? left.parentId ?? '' : '';
  const rightParent = 'parentId' in right ? right.parentId ?? '' : '';
  if (leftParent !== rightParent) return leftParent.localeCompare(rightParent);
  const leftPosition = 'position' in left ? left.position : 0;
  const rightPosition = 'position' in right ? right.position : 0;
  return leftPosition - rightPosition;
}

function compareRecentChannels(left: HistoryChannel, right: HistoryChannel): number {
  const leftId = left.lastMessageId ?? '0';
  const rightId = right.lastMessageId ?? '0';
  try {
    const difference = BigInt(rightId) - BigInt(leftId);
    return difference > 0n ? 1 : difference < 0n ? -1 : 0;
  } catch {
    return rightId.localeCompare(leftId);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function errorMessage(error: unknown): string {
  return clampText(error instanceof Error ? error.message : String(error), 300);
}
