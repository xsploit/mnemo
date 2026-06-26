import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';

/** Connects, confirms identity, disconnects. Proves the token + gateway work. */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const fail = setTimeout(() => {
  console.log('❌ login timed out after 20s');
  process.exit(1);
}, 20_000);

client.once(Events.ClientReady, async (c) => {
  clearTimeout(fail);
  console.log(`✅ logged in as ${c.user.tag} (id ${c.user.id})`);
  console.log(`   in ${c.guilds.cache.size} guild(s)`);
  await client.destroy();
  process.exit(0);
});

client.login(config.discord.token).catch((e) => {
  console.log('❌ login failed:', e?.message ?? e);
  process.exit(1);
});
