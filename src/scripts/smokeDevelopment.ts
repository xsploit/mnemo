import { compileCognitiveState } from '../development/cognitiveState.js';
import { gateway } from '../llm/gateway.js';

const forceModelPath = process.argv.includes('--model');
const selectedModel = process.argv.includes('--pro')
  ? 'deepseek/deepseek-v4-pro'
  : process.argv.includes('--flash')
    ? 'deepseek/deepseek-v4-flash'
    : null;
const benchmark = process.argv.includes('--benchmark');
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
  model: selectedModel ? gateway(selectedModel) : undefined,
  timeoutMs: benchmark ? 60_000 : undefined,
  forceModel: Boolean(selectedModel),
});

console.log(
  JSON.stringify(
    {
      compiler: result.state.compiler,
      route: selectedModel ?? 'configured-deepseek-json-model',
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
