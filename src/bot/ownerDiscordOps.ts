import {
  ChannelType,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type Role,
} from 'discord.js';

export async function ownerSendDm(client: Client, userId: string, content: string): Promise<Record<string, unknown>> {
  const user = await client.users.fetch(required(userId, 'user id'));
  const message = await user.send({ content: required(content, 'message'), allowedMentions: { parse: [] } });
  return { sent: true, userId: user.id, messageId: message.id };
}

export async function ownerManageMessage(client: Client, input: {
  action: 'send' | 'edit' | 'delete' | 'react';
  channelId: string;
  messageId?: string;
  content?: string;
  emoji?: string;
}): Promise<Record<string, unknown>> {
  const channel = await resolveChannel(client, input.channelId);
  const botMember = await botMemberForChannel(client, channel);
  if (!isMessageChannel(channel)) throw new Error(`Channel ${input.channelId} does not support messages.`);

  if (input.action === 'send') {
    requireChannelPermissions(channel, botMember, ['ViewChannel', isThread(channel) ? 'SendMessagesInThreads' : 'SendMessages']);
    const message = await channel.send({ content: required(input.content, 'message'), allowedMentions: { parse: [] } });
    return { action: input.action, channelId: channel.id, messageId: message.id, url: message.url };
  }

  requireChannelPermissions(channel, botMember, ['ViewChannel', 'ReadMessageHistory']);
  const message = await channel.messages.fetch(required(input.messageId, 'message id'));
  if (input.action === 'edit') {
    if (message.author.id !== client.user?.id) throw new Error('A bot can only edit its own Discord messages.');
    const edited = await message.edit({ content: required(input.content, 'message'), allowedMentions: { parse: [] } });
    return { action: input.action, channelId: channel.id, messageId: edited.id, url: edited.url };
  }
  if (input.action === 'delete') {
    if (message.author.id !== client.user?.id) requireChannelPermissions(channel, botMember, ['ManageMessages']);
    await message.delete();
    return { action: input.action, channelId: channel.id, messageId: message.id, deleted: true };
  }
  requireChannelPermissions(channel, botMember, ['AddReactions']);
  const reaction = await message.react(required(input.emoji, 'emoji'));
  return { action: input.action, channelId: channel.id, messageId: message.id, emoji: reaction.emoji.toString() };
}

export async function ownerManageChannel(client: Client, input: {
  action: 'create' | 'edit' | 'delete';
  guildId: string;
  channelId?: string;
  name?: string;
  topic?: string;
  parentId?: string;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const guild = await resolveGuild(client, input.guildId);
  const botMember = await resolveBotMember(guild);
  requireGuildPermission(botMember, 'ManageChannels');
  const reason = cleanReason(input.reason);
  if (input.action === 'create') {
    const topic = optional(input.topic);
    const parent = optional(input.parentId);
    const channel = await guild.channels.create({
      name: required(input.name, 'channel name'),
      type: ChannelType.GuildText,
      ...(topic ? { topic } : {}),
      ...(parent ? { parent } : {}),
      ...(reason ? { reason } : {}),
    });
    return { action: input.action, guildId: guild.id, channel: channelSummary(channel) };
  }
  const channel = await resolveGuildChannel(guild, required(input.channelId, 'channel id'));
  if (input.action === 'delete') {
    const summary = channelSummary(channel);
    await channel.delete(reason);
    return { action: input.action, guildId: guild.id, channel: summary, deleted: true };
  }
  if (input.name) await channel.setName(input.name.trim(), reason);
  if (input.parentId) {
    if (!('setParent' in channel) || typeof channel.setParent !== 'function') throw new Error(`Channel ${channel.id} cannot be moved to a parent.`);
    await (channel.setParent as (parentId: string, options?: { reason?: string }) => Promise<unknown>)(
      input.parentId,
      reason ? { reason } : {},
    );
  }
  if (input.topic !== undefined) {
    if (!('setTopic' in channel) || typeof channel.setTopic !== 'function') throw new Error(`Channel ${channel.id} does not support a topic.`);
    await (channel.setTopic as (topic: string | null, reason?: string) => Promise<unknown>)(input.topic.trim() || null, reason);
  }
  return { action: input.action, guildId: guild.id, channel: channelSummary(channel) };
}

export async function ownerManageThread(client: Client, input: {
  action: 'create' | 'archive' | 'unarchive' | 'lock' | 'unlock';
  channelId: string;
  name?: string;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const channel = await resolveChannel(client, input.channelId);
  const botMember = await botMemberForChannel(client, channel);
  const reason = cleanReason(input.reason);
  if (input.action === 'create') {
    requireChannelPermissions(channel, botMember, ['ViewChannel', 'SendMessages', 'CreatePublicThreads']);
    if (!hasThreadsCreate(channel)) throw new Error(`Channel ${input.channelId} cannot create public threads.`);
    const thread = await channel.threads.create({ name: required(input.name, 'thread name'), ...(reason ? { reason } : {}) });
    return { action: input.action, thread: channelSummary(thread) };
  }
  if (!isManageableThread(channel)) throw new Error(`Channel ${input.channelId} is not a manageable thread.`);
  requireChannelPermissions(channel, botMember, ['ViewChannel', 'ManageThreads']);
  if (input.action === 'archive' || input.action === 'unarchive') {
    await channel.setArchived(input.action === 'archive', reason);
  } else {
    await channel.setLocked(input.action === 'lock', reason);
  }
  return { action: input.action, thread: channelSummary(channel) };
}

export async function ownerManageRole(client: Client, input: {
  action: 'create' | 'edit' | 'delete' | 'add_to_member' | 'remove_from_member';
  guildId: string;
  roleId?: string;
  userId?: string;
  name?: string;
  color?: string;
  permissions?: string[];
  reason?: string;
}): Promise<Record<string, unknown>> {
  const guild = await resolveGuild(client, input.guildId);
  const botMember = await resolveBotMember(guild);
  requireGuildPermission(botMember, 'ManageRoles');
  const reason = cleanReason(input.reason);
  if (input.action === 'create') {
    const color = parseColor(input.color);
    const permissions = parsePermissions(input.permissions);
    const role = await guild.roles.create({
      name: required(input.name, 'role name'),
      ...(color !== undefined ? { color } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(reason ? { reason } : {}),
    });
    return { action: input.action, guildId: guild.id, role: roleSummary(role) };
  }
  const role = await resolveRole(guild, required(input.roleId, 'role id'));
  assertManageableRole(botMember, role);
  if (input.action === 'delete') {
    const summary = roleSummary(role);
    await role.delete(reason);
    return { action: input.action, guildId: guild.id, role: summary, deleted: true };
  }
  if (input.action === 'edit') {
    const color = parseColor(input.color);
    const permissions = parsePermissions(input.permissions);
    const edited = await role.edit({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(reason ? { reason } : {}),
    });
    return { action: input.action, guildId: guild.id, role: roleSummary(edited) };
  }
  const member = await resolveMember(guild, required(input.userId, 'user id'));
  assertManageableMember(botMember, member);
  if (input.action === 'add_to_member') await member.roles.add(role, reason);
  else await member.roles.remove(role, reason);
  return { action: input.action, guildId: guild.id, userId: member.id, role: roleSummary(role) };
}

export async function ownerClaimAdministrator(client: Client, input: {
  guildId: string;
  ownerUserId: string;
  roleId?: string;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const guild = await resolveGuild(client, input.guildId);
  const botMember = await resolveBotMember(guild);
  const ownerMember = await resolveMember(guild, required(input.ownerUserId, 'owner user id'));
  if (ownerMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return { guildId: guild.id, userId: ownerMember.id, alreadyAdministrator: true };
  }
  requireGuildPermission(botMember, 'ManageRoles');
  const reason = cleanReason(input.reason) ?? `Configured bot owner ${ownerMember.id} requested administrator access by DM`;

  let role: Role | null = null;
  if (input.roleId) {
    role = await resolveRole(guild, input.roleId);
    if (!role.permissions.has(PermissionsBitField.Flags.Administrator)) {
      throw new Error(`Role ${role.id} does not grant Administrator.`);
    }
    assertManageableRole(botMember, role);
  } else {
    role = [...guild.roles.cache.values()]
      .filter((candidate) => candidate.permissions.has(PermissionsBitField.Flags.Administrator))
      .filter((candidate) => !candidate.managed && candidate.id !== guild.id && candidate.position < botMember.roles.highest.position)
      .sort((left, right) => right.position - left.position)[0] ?? null;
  }

  let created = false;
  if (!role) {
    if (!botMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
      throw new Error(
        `No manageable Administrator role exists in guild ${guild.id}, and the bot does not itself have Administrator to create one.`,
      );
    }
    role = await guild.roles.create({
      name: 'Bot Owner',
      permissions: PermissionsBitField.Flags.Administrator,
      reason,
    });
    created = true;
  }

  assertManageableRole(botMember, role);
  const updatedOwner = await ownerMember.roles.add(role, reason);
  return {
    guildId: guild.id,
    guildName: guild.name,
    userId: ownerMember.id,
    administrator: updatedOwner.permissions.has(PermissionsBitField.Flags.Administrator),
    createdRole: created,
    role: roleSummary(role),
  };
}

export async function ownerManageMember(client: Client, input: {
  action: 'timeout' | 'clear_timeout' | 'kick' | 'ban' | 'unban' | 'nickname';
  guildId: string;
  userId: string;
  durationMinutes?: number;
  nickname?: string;
  deleteMessageSeconds?: number;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const guild = await resolveGuild(client, input.guildId);
  const botMember = await resolveBotMember(guild);
  const userId = required(input.userId, 'user id');
  const reason = cleanReason(input.reason);
  if (input.action === 'unban') {
    requireGuildPermission(botMember, 'BanMembers');
    await guild.members.unban(userId, reason);
    return { action: input.action, guildId: guild.id, userId };
  }
  const member = await resolveMember(guild, userId);
  assertManageableMember(botMember, member);
  if (input.action === 'timeout' || input.action === 'clear_timeout') {
    requireGuildPermission(botMember, 'ModerateMembers');
    if (!member.moderatable) throw new Error(`Bot cannot timeout member ${member.id} because of Discord role hierarchy.`);
    const duration = input.action === 'clear_timeout' ? null : clamp(input.durationMinutes ?? 10, 1, 40_320) * 60_000;
    await member.timeout(duration, reason);
  } else if (input.action === 'kick') {
    requireGuildPermission(botMember, 'KickMembers');
    if (!member.kickable) throw new Error(`Bot cannot kick member ${member.id} because of Discord role hierarchy.`);
    await member.kick(reason);
  } else if (input.action === 'ban') {
    requireGuildPermission(botMember, 'BanMembers');
    if (!member.bannable) throw new Error(`Bot cannot ban member ${member.id} because of Discord role hierarchy.`);
    await member.ban({
      deleteMessageSeconds: clamp(input.deleteMessageSeconds ?? 0, 0, 604_800),
      ...(reason ? { reason } : {}),
    });
  } else {
    requireGuildPermission(botMember, 'ManageNicknames');
    if (!member.manageable) throw new Error(`Bot cannot change member ${member.id} because of Discord role hierarchy.`);
    await member.setNickname(input.nickname?.trim() || null, reason);
  }
  return { action: input.action, guildId: guild.id, userId: member.id };
}

export async function ownerManageWebhook(client: Client, input: {
  action: 'list' | 'create' | 'send' | 'delete';
  channelId?: string;
  webhookId?: string;
  name?: string;
  content?: string;
  reason?: string;
}): Promise<Record<string, unknown>> {
  if (input.action === 'send' || input.action === 'delete') {
    const webhook = await client.fetchWebhook(required(input.webhookId, 'webhook id'));
    if (input.action === 'delete') {
      await webhook.delete(cleanReason(input.reason));
      return { action: input.action, webhookId: webhook.id, deleted: true };
    }
    if (!('send' in webhook) || typeof webhook.send !== 'function') throw new Error(`Webhook ${webhook.id} is not executable by this bot.`);
    const message = await webhook.send({ content: required(input.content, 'message'), allowedMentions: { parse: [] } });
    return { action: input.action, webhookId: webhook.id, messageId: message.id };
  }
  const channel = await resolveChannel(client, required(input.channelId, 'channel id'));
  const botMember = await botMemberForChannel(client, channel);
  requireChannelPermissions(channel, botMember, ['ViewChannel', 'ManageWebhooks']);
  if (!hasWebhookManager(channel)) throw new Error(`Channel ${input.channelId} does not support webhooks.`);
  if (input.action === 'list') {
    const webhooks = await channel.fetchWebhooks();
    return {
      action: input.action,
      channelId: channel.id,
      webhooks: [...webhooks.values()].map((webhook) => ({ id: webhook.id, name: webhook.name, ownerId: webhook.owner?.id ?? null })),
    };
  }
  const webhookReason = cleanReason(input.reason);
  const webhook = await channel.createWebhook({
    name: required(input.name, 'webhook name'),
    ...(webhookReason ? { reason: webhookReason } : {}),
  });
  return { action: input.action, channelId: channel.id, webhookId: webhook.id, name: webhook.name };
}

async function resolveGuild(client: Client, guildId: string): Promise<Guild> {
  const id = required(guildId, 'guild id');
  return client.guilds.cache.get(id) ?? client.guilds.fetch(id).catch(() => {
    throw new Error(`Bot is not in guild ${id}.`);
  });
}

async function resolveChannel(client: Client, channelId: string): Promise<unknown> {
  const id = required(channelId, 'channel id');
  const channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id).catch(() => null));
  if (!channel) throw new Error(`Channel ${id} was not found.`);
  return channel;
}

async function resolveGuildChannel(guild: Guild, channelId: string): Promise<GuildBasedChannel> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) throw new Error(`Channel ${channelId} is not in guild ${guild.id}.`);
  return channel;
}

async function resolveBotMember(guild: Guild): Promise<GuildMember> {
  const member = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!member) throw new Error(`Could not resolve the bot member in guild ${guild.id}.`);
  return member;
}

async function botMemberForChannel(client: Client, channel: unknown): Promise<GuildMember | null> {
  const guild = objectProp(channel, 'guild');
  if (!guild || typeof guild !== 'object' || !('id' in guild) || typeof guild.id !== 'string') return null;
  const target = client.guilds.cache.get(guild.id);
  return target ? resolveBotMember(target) : null;
}

async function resolveMember(guild: Guild, userId: string): Promise<GuildMember> {
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (!member) throw new Error(`Member ${userId} was not found in guild ${guild.id}.`);
  return member;
}

async function resolveRole(guild: Guild, roleId: string): Promise<Role> {
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) throw new Error(`Role ${roleId} was not found in guild ${guild.id}.`);
  return role;
}

function requireGuildPermission(member: GuildMember, permission: keyof typeof PermissionsBitField.Flags): void {
  if (!member.permissions.has(PermissionsBitField.Flags[permission])) {
    throw new Error(`Bot lacks ${permission} in guild ${member.guild.id}.`);
  }
}

function requireChannelPermissions(channel: unknown, member: GuildMember | null, permissions: Array<keyof typeof PermissionsBitField.Flags>): void {
  if (!member || !channel || typeof channel !== 'object' || !('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') {
    if (permissions.length) throw new Error('Could not resolve the bot permissions for this channel.');
    return;
  }
  const effective = channel.permissionsFor(member);
  const missing = permissions.filter((permission) => !effective?.has(PermissionsBitField.Flags[permission]));
  if (missing.length) throw new Error(`Bot lacks ${missing.join(', ')} in channel ${String(objectProp(channel, 'id') ?? 'unknown')}.`);
}

function assertManageableRole(botMember: GuildMember, role: Role): void {
  if (role.managed || role.id === role.guild.id || botMember.roles.highest.position <= role.position) {
    throw new Error(`Bot cannot manage role ${role.id} because of Discord role hierarchy.`);
  }
}

function assertManageableMember(botMember: GuildMember, member: GuildMember): void {
  if (member.id === botMember.id || member.id === member.guild.ownerId || botMember.roles.highest.position <= member.roles.highest.position) {
    throw new Error(`Bot cannot manage member ${member.id} because of Discord role hierarchy.`);
  }
}

function parsePermissions(values: string[] | undefined): bigint | undefined {
  if (!values) return undefined;
  const flags = values.map((value) => {
    const normalized = value.replace(/[-_\s]+/g, '').toLowerCase();
    const entry = Object.entries(PermissionsBitField.Flags).find(([name]) => name.toLowerCase() === normalized);
    if (!entry) throw new Error(`Unknown Discord permission ${value}.`);
    return entry[1];
  });
  return new PermissionsBitField(flags).bitfield;
}

function parseColor(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error('Role color must be a six-digit hex value such as #ff44aa.');
  return Number.parseInt(normalized, 16);
}

function isMessageChannel(channel: unknown): channel is {
  id: string;
  guild?: Guild;
  messages: { fetch(id: string): Promise<Message> };
  send(options: { content: string; allowedMentions: { parse: never[] } }): Promise<Message>;
} {
  return Boolean(channel && typeof channel === 'object' && 'messages' in channel && 'send' in channel && typeof channel.send === 'function');
}

function hasThreadsCreate(channel: unknown): channel is {
  id: string;
  threads: { create(options: { name: string; reason?: string }): Promise<GuildBasedChannel> };
} {
  return Boolean(channel && typeof channel === 'object' && 'threads' in channel && channel.threads && typeof channel.threads === 'object' && 'create' in channel.threads && typeof channel.threads.create === 'function');
}

function isManageableThread(channel: unknown): channel is GuildBasedChannel & {
  setArchived(archived: boolean, reason?: string): Promise<unknown>;
  setLocked(locked: boolean, reason?: string): Promise<unknown>;
} {
  return Boolean(channel && typeof channel === 'object' && 'setArchived' in channel && typeof channel.setArchived === 'function' && 'setLocked' in channel && typeof channel.setLocked === 'function');
}

function hasWebhookManager(channel: unknown): channel is {
  id: string;
  fetchWebhooks(): Promise<Map<string, { id: string; name: string | null; owner?: { id: string } | null }>>;
  createWebhook(options: { name: string; reason?: string }): Promise<{ id: string; name: string | null }>;
} {
  return Boolean(channel && typeof channel === 'object' && 'fetchWebhooks' in channel && typeof channel.fetchWebhooks === 'function' && 'createWebhook' in channel && typeof channel.createWebhook === 'function');
}

function isThread(channel: unknown): boolean {
  const type = Number(objectProp(channel, 'type'));
  return type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}

function channelSummary(channel: GuildBasedChannel): Record<string, unknown> {
  return {
    id: channel.id,
    name: 'name' in channel ? channel.name : null,
    type: channel.type,
    guildId: channel.guild.id,
    parentId: 'parentId' in channel ? channel.parentId : null,
  };
}

function roleSummary(role: Role): Record<string, unknown> {
  return { id: role.id, name: role.name, position: role.position, color: role.hexColor, permissions: role.permissions.toArray().sort() };
}

function cleanReason(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 400) : undefined;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function objectProp(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(value) ? value : min)));
}
