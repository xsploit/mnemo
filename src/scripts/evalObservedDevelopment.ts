import { getDevelopmentStore } from '../development/eventStore.js';
import { computeObservedDevelopmentMetrics } from '../development/observedMetrics.js';

const subjectId = process.argv[2]?.trim() || undefined;
const metrics = await computeObservedDevelopmentMetrics(getDevelopmentStore(), subjectId);

console.log(JSON.stringify({ subjectId: subjectId ?? 'all', metrics }, null, 2));
