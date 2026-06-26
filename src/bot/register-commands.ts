import { Client, Events, GatewayIntentBits, REST, Routes, type Guild } from 'discord.js';
import { config } from '../config.js';
import { commandData } from './commands.js';
import { logger } from '../logger.js';

const log = logger('register');

/**
 * Registers slash commands with Discord. By default, discovers every guild the
 * bot is in and deploys guild-scoped commands for immediate updates.
 */
async function main() {
  const rest = new REST({ version: '10', timeout: 20_000 }).setToken(config.discord.token);

  if (config.discord.deployGlobalCommands) {
    await rest.put(Routes.applicationCommands(config.discord.appId), { body: commandData });
    log.info(`registered ${commandData.length} global commands`);
  } else if (config.discord.deployAllGuilds) {
    const guilds = await fetchBotGuilds();
    if (guilds.length === 0) throw new Error('bot is not in any guilds; no guild command targets found');

    const failures: string[] = [];
    for (const guild of guilds) {
      const route = Routes.applicationGuildCommands(config.discord.appId, guild.id);
      try {
        await rest.put(route, { body: commandData });
        log.info(`registered ${commandData.length} commands to ${guild.name}:${guild.id}`);
      } catch (e: any) {
        const message = e?.message ?? String(e);
        failures.push(`${guild.name}:${guild.id} ${message}`);
        log.error(`failed to register commands to ${guild.name}:${guild.id}`, message);
      }
    }

    if (failures.length > 0) {
      throw new Error(`command registration failed for ${failures.length}/${guilds.length} guild(s): ${failures.join(' | ')}`);
    }
  } else if (config.discord.devGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.appId, config.discord.devGuildId),
      { body: commandData },
    );
    log.info(`registered ${commandData.length} commands to guild ${config.discord.devGuildId}`);
  } else {
    throw new Error('set DISCORD_DEV_GUILD_ID, DISCORD_DEPLOY_ALL_GUILDS=true, or DISCORD_DEPLOY_GLOBAL_COMMANDS=true');
  }
}

async function fetchBotGuilds(): Promise<Guild[]> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        client.once(Events.ClientReady, () => resolve());
        client.once(Events.Error, reject);
        void client.login(config.discord.token).catch(reject);
      }),
      20_000,
      'Discord guild discovery login',
    );
    return [...client.guilds.cache.values()].sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    await client.destroy();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
  log.error('registration failed', e?.message ?? e);
  process.exit(1);
  });
