import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { compileCognitiveState } from '../development/cognitiveState.js';
import { config } from '../config.js';
import { models } from '../llm/gateway.js';

const forceModelPath = process.argv.includes('--model');
const useDirectGlm = process.argv.includes('--glm');
if (useDirectGlm) {
  if (!config.zai.apiKey) throw new Error('ZAI_API_KEY is required for --glm.');
  const provider = createOpenAICompatible({
    name: 'zai-development-smoke',
    baseURL: config.zai.baseURL,
    apiKey: config.zai.apiKey,
  });
  models.json = provider('glm-4.5-flash');
}
const started = performance.now();
const result = await compileCognitiveState({
  subjectId: 'smoke-user',
  channelId: 'smoke-channel',
  messageId: 'smoke-message',
  userName: 'SUBSECT',
  message: forceModelPath
    ? 'How do you feel about me after all of these experiments, and do you trust me?'
    : 'No, Hikari is the experimental one. Neuro stays unchanged. What should we test next?',
  history: [
    {
      messageId: 'smoke-history-human',
      authorId: 'smoke-user',
      username: 'subsect',
      author: 'SUBSECT',
      content: 'We should experiment on one bot first.',
    },
    {
      messageId: 'smoke-history-bot',
      authorId: 'other-bot',
      username: 'other_bot',
      author: 'Other Bot',
      bot: true,
      content: 'Try changing both bots at once.',
    },
  ],
  memories: [],
  affinity: null,
  momentum: null,
  persist: false,
});

console.log(
  JSON.stringify(
    {
      compiler: result.state.compiler,
      route: useDirectGlm ? 'zai:glm-4.5-flash' : 'configured-json-model',
      topic: result.state.scene.topic,
      intent: result.state.userModel.likelyIntent,
      responseGoal: result.state.response.primaryGoal,
      predictions: result.state.predictions,
      persisted: result.eventId !== null,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
    },
    null,
    2,
  ),
);
