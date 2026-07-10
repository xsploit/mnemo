import assert from 'node:assert/strict';
import { OWNER_DISCORD_TOOL_PROMPT } from '../bot/ownerToolPrompt.js';
import { config } from '../config.js';

assert.deepEqual(config.bot.ownerUserIds, ['120418341775998976'], 'unexpected configured Discord owner');

for (const required of [
  'tools exposed on the current turn are the authoritative capability list',
  'including from a DM',
  'use discord_claim_administrator',
  'Do not claim an action succeeded unless the tool result says it succeeded',
]) {
  assert.ok(OWNER_DISCORD_TOOL_PROMPT.includes(required), `owner tool prompt is missing: ${required}`);
}

console.log('agent prompt contract ok');
