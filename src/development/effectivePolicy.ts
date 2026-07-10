import { config } from '../config.js';
import { getDevelopmentStore, type DevelopmentEventStore } from './eventStore.js';
import type { PolicyDecisionEventData } from './types.js';

export interface EffectiveDevelopmentPolicy {
  utilityWeight: number;
  maxPredictions: number;
  sourcePolicyIds: string[];
}

/**
 * Project the active bounded policy from promoted append-only decisions.
 * Unknown parameters, rejected decisions, and out-of-range values are ignored.
 */
export async function getEffectiveDevelopmentPolicy(
  store: DevelopmentEventStore = getDevelopmentStore(),
  subjectId?: string,
): Promise<EffectiveDevelopmentPolicy> {
  const policy: EffectiveDevelopmentPolicy = {
    utilityWeight: config.development.utilityWeight,
    maxPredictions: config.development.maxPredictions,
    sourcePolicyIds: [],
  };
  const decisions = await store.list({ kinds: ['policy_decision'], limit: 500 });
  for (const event of decisions) {
    if (event.subjectId && event.subjectId !== subjectId) continue;
    if (!isPromotedDecision(event.data)) continue;
    if (event.data.parameter === 'development.utilityWeight') {
      const value = event.data.proposedValue;
      if (Number.isFinite(value) && value >= 0 && value <= 0.5) {
        policy.utilityWeight = value;
        policy.sourcePolicyIds.push(event.data.policyId);
      }
    } else if (event.data.parameter === 'development.maxPredictions') {
      const value = event.data.proposedValue;
      if (Number.isInteger(value) && value >= 1 && value <= 5) {
        policy.maxPredictions = value;
        policy.sourcePolicyIds.push(event.data.policyId);
      }
    }
  }
  policy.sourcePolicyIds = [...new Set(policy.sourcePolicyIds)];
  return policy;
}

function isPromotedDecision(value: unknown): value is PolicyDecisionEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<PolicyDecisionEventData>;
  return (
    data.decision === 'promoted' &&
    typeof data.policyId === 'string' &&
    typeof data.parameter === 'string' &&
    typeof data.proposedValue === 'number'
  );
}
