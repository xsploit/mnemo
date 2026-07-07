import { generateText } from 'ai';
import { models, gatewayProviderOptions } from './llm/gateway.js';
import { config } from './config.js';
import { embedOne } from './llm/embeddings.js';

/** One-shot connectivity check: validates the gateway key, base URL, and model ids. */
async function main() {
  console.log('base URL :', config.gateway.baseURL ?? '(default)');
  console.log('chat     :', config.models.chat);
  console.log('json     :', config.models.json);
  console.log('dream    :', config.models.dream);
  console.log('embed    :', config.models.embed);
  console.log('—'.repeat(20));

  try {
    const r = await generateText({
      model: models.chat,
      prompt: 'Say hi in one short sentence.',
      maxOutputTokens: 400,
      providerOptions: gatewayProviderOptions,
    });
    console.log('✅ chat   →', JSON.stringify(r.text.trim()));
    console.log('   finish:', r.finishReason, '| usage:', JSON.stringify(r.usage));
  } catch (e: any) {
    console.log('❌ chat   →', e?.message ?? e);
  }

  try {
    const embedding = await embedOne('hello world');
    console.log(`✅ embed  → ${embedding.length} dims`);
  } catch (e: any) {
    console.log('❌ embed  →', e?.message ?? e);
  }

  // Structured-output path (the json model drives importance/consolidate/reflect).
  try {
    const { scoreImportance } = await import('./cognition/importance.js');
    const r = await scoreImportance('Sam said: "I just got engaged to my partner of 8 years!"');
    console.log(`✅ json   → importance ${r.importance}/10`);
  } catch (e: any) {
    console.log('❌ json   →', e?.message ?? e);
  }
  process.exit(0);
}
main();
