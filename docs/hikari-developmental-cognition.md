# Hikari Developmental Cognition Lab

Status: experimental implementation active in Hikari. Neuro remains unchanged until observed Discord outcomes and human A/B review show a measurable win.

## Objective

Make Hikari develop through interaction without allowing generated mood, imagined dreams, or one-off model guesses to become facts about people or permanent personality changes.

The runtime keeps the current local memory store and local `Xenova/all-MiniLM-L6-v2` embeddings authoritative. External memory products are optional shadow observers and never sit on the live answer path by default.

## State Boundaries

The system has three epistemic classes:

1. `evidence`: Discord messages, reactions, tool results, attachments, and committed memory records.
2. `hypothesis`: bounded interpretations of intent, emotion, relationship state, or likely future behavior. Every hypothesis has confidence and evidence IDs.
3. `simulation`: counterfactual or prospective dream material. Simulations are never retrieved as historical facts and never enter semantic memory.

Generated affect is expression telemetry, not evidence about the user. It may influence momentary delivery but cannot directly increase trust or rewrite identity.

## Development Event Log

`data/development/events.jsonl` is an append-only experimental source of truth. Events are schema-versioned and idempotent by external Discord IDs where applicable.

Event kinds:

- `cognitive_state`: the structured pre-reply scene, appraisal, user hypothesis, response intention, and predictions.
- `response_link`: maps a Discord response message to a turn and cognitive state.
- `social_outcome`: observed follow-up message or reaction linked to an earlier response.
- `prediction_resolution`: whether an earlier prediction matched later evidence.
- `utility_update`: bounded utility evidence for a memory, response strategy, or policy.
- `dream_simulation`: explicitly imaginary future rehearsal grounded in source evidence.
- `self_delta_candidate`: slow identity change proposed from repeated evidence.
- `self_delta_decision`: accepted, rejected, or deferred identity proposal.
- `policy_candidate`: proposed retrieval or prompt-policy change plus replay baseline.
- `policy_decision`: promotion or rejection after regression checks.
- `shadow_memory_result`: output from an optional memory backend that never changes live recall by itself.

## Wake Loop

```text
message + history + retrieved memory + current self/social projection
  -> structured cognitive prepass
  -> main character response
  -> trace + response link
  -> later Discord message/reaction
  -> outcome and prediction-resolution events
  -> bounded utility update
```

The cognitive prepass replaces the current free-form inner voice. It produces inspectable JSON rather than hidden prose:

- scene topic and social tone
- event appraisal: novelty, goal congruence, agency, controllability, certainty
- uncertain user intent and affect hypotheses
- current response goals and style dials
- relationship delta proposal, capped and evidence-linked
- short-horizon predictions that can later be scored

Failure is non-fatal. The public response falls back to the existing persona, memory, affinity, and mood path.

The live default is deterministic because a 2026-07-10 same-packet probe measured DeepSeek V4 Flash at 14.81s for valid schema output, while V4 Pro took 38.28s across retries and produced no JSON object. This is operational evidence from one DeepSeek probe, not a provider-wide latency law. Flash remains the structured/dream worker model; Pro remains the main character model. Adaptive compilation is explicit, uses a 20s default timeout that can actually admit the measured Flash result, and records timeout fallback separately from model errors.

## Sleep Loop

The existing `INGEST -> CONSOLIDATE -> REFLECT -> DREAM -> FORGET` loop becomes:

```text
INGEST -> CONSOLIDATE -> REFLECT -> REHEARSE -> DREAM -> DEVELOP -> FORGET
```

`REHEARSE` selects surprising, unresolved, contradictory, or relationship-salient evidence. It creates a small number of counterfactual interpretations and likely future conversational situations. The output is written only as `dream_simulation` events.

`DEVELOP` considers prediction outcomes, repeated appraisals, corrections, reactions, and utility updates. It may propose a self or relationship change, but promotion requires repeated independent evidence. A single dream, response, or generated affect cannot promote a durable change.

## Utility Learning

Retrieval stays two-stage:

1. semantic/temporal candidate generation using the current local embedding and continuity logic;
2. small bounded reranking boost from observed utility.

Utility is updated by an exponential moving average and scoped by target plus context. Positive evidence currently includes positive reactions and direct explicit confirmation. Negative evidence includes direct corrections and negative reactions. Neutral follow-ups and missing feedback do not update memory or strategy utility. Prediction utility is scored separately when a prediction matches or when a non-zero contradictory signal arrives.

Utility never overrides a minimum semantic-relevance gate, so popular but irrelevant memories cannot dominate recall.

## Shadow Memory

Shadow adapters receive the same committed interaction event after the live turn. They may store and retrieve in parallel for comparison, but their output is logged as `shadow_memory_result` and is excluded from the live prompt.

Initial adapters:

- `local-baseline`: exercises the adapter and evaluation path with no service dependency.
- `local-diversity`: reranks a wider pre-utility candidate pool using lexical overlap and memory-kind diversity only, then records structured Jaccard/rank metrics against the live top-k without affecting the prompt.
- `letta`: optional later, enabled only by explicit configuration and credentials.

Other systems such as A-MEM, MIRIX, or MemOS should first be evaluated through the same adapter contract rather than replacing Hikari's store.

## Policy Lab

Dreaming currently proposes one bounded policy candidate with a defensible recorded counterfactual: reducing the per-user maximum prediction count after enough low-precision resolutions. It cannot directly rewrite the persona or activate a proposal. Retrieval-weight changes are deliberately not auto-proposed until the log contains a valid counterfactual for them.

Each candidate is replayed over recorded cognitive states, direct outcome attribution, v2 prediction resolutions, and turn traces, then compared with the current policy. The deterministic fixture suite separately protects control-plane invariants. Promotion requires:

- no grounding regression;
- no speaker-attribution regression;
- no temporal-recall regression;
- no persona-consistency regression;
- bounded latency and context growth;
- a measurable improvement in the candidate's target metric.

Promoted decisions are projected from the append-only log into a small allowlist of subject-scoped runtime values. They never modify `.env`, source files, the persona, or another user's policy. Projection supports utility weight and maximum prediction count, but only maximum prediction count currently has an automatic candidate/evaluator path.

## Evaluation

The deterministic replay suite verifies control-plane invariants:

- exact speaker attribution
- temporal recall and stale-fact handling
- simulation/fact isolation
- prediction-resolution correctness
- utility update bounds and relevance gating
- relationship change evidence thresholds
- identity change evidence thresholds
- append-only event parseability and idempotency
- prompt size and local latency

It does not report synthetic persona or grounding quality as if they were real observations. `eval:development:observed` separately reports real follow-ups, reactions, corrections, continuation, prediction precision/calibration, and utility updates; missing samples remain `n/a`. Human A/B evaluation still owns character consistency, natural callbacks, emotional appropriateness, surprise, non-sycophancy, and overall "feels more real" preference.

## Research Lineage

- OpenAI Dreaming: background synthesis for freshness, continuity, and temporal relevance.
- Sleep-time Compute: anticipate likely future work while idle.
- ToMAgent: explicit mental-state modeling plus dialogue lookahead.
- MemRL: semantic candidate generation followed by learned utility selection.
- EvolveMem and SelfMem: diagnose and refine memory strategy from failures and feedback.
- AtomMem: memory management as learnable atomic decisions.

These are design inputs, not claims that any library is automatically the correct backend.
