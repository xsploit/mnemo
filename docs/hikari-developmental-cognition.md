# Hikari Developmental Cognition Lab

Status: experimental implementation target. Hikari only. Neuro remains unchanged until the replay suite shows a measurable win.

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

Utility is updated by an exponential moving average and scoped by target plus context. Positive evidence includes positive reactions, explicit confirmation, successful factual callbacks, and prediction matches. Negative evidence includes corrections, negative reactions, and repeated recall failures. Missing feedback is neutral.

Utility never overrides a minimum semantic-relevance gate, so popular but irrelevant memories cannot dominate recall.

## Shadow Memory

Shadow adapters receive the same committed interaction event after the live turn. They may store and retrieve in parallel for comparison, but their output is logged as `shadow_memory_result` and is excluded from the live prompt.

Initial adapters:

- `local-baseline`: exercises the adapter and evaluation path with no service dependency.
- `letta`: optional later, enabled only by explicit configuration and credentials.

Other systems such as A-MEM, MIRIX, or MemOS should first be evaluated through the same adapter contract rather than replacing Hikari's store.

## Policy Lab

Dreaming may propose bounded policy candidates: retrieval weights, candidate counts, continuity windows, cognitive-prepass thresholds, or context budgets. It cannot directly rewrite the persona or activate a proposal.

Each candidate is replayed against a fixed fixture set and compared with the current policy. Promotion requires:

- no grounding regression;
- no speaker-attribution regression;
- no temporal-recall regression;
- no persona-consistency regression;
- bounded latency and context growth;
- a measurable improvement in the candidate's target metric.

The first implementation records candidates and decisions but does not automatically modify `.env` or source files.

## Evaluation

The deterministic replay suite measures:

- exact speaker attribution
- temporal recall and stale-fact handling
- simulation/fact isolation
- prediction-resolution correctness
- utility update bounds and relevance gating
- relationship change evidence thresholds
- identity change evidence thresholds
- persona-state packet stability
- append-only event parseability and idempotency
- prompt size and local latency

Human A/B evaluation adds character consistency, natural callbacks, emotional appropriateness, surprise, non-sycophancy, and overall "feels more real" preference.

## Research Lineage

- OpenAI Dreaming: background synthesis for freshness, continuity, and temporal relevance.
- Sleep-time Compute: anticipate likely future work while idle.
- ToMAgent: explicit mental-state modeling plus dialogue lookahead.
- MemRL: semantic candidate generation followed by learned utility selection.
- EvolveMem and SelfMem: diagnose and refine memory strategy from failures and feedback.
- AtomMem: memory management as learnable atomic decisions.

These are design inputs, not claims that any library is automatically the correct backend.
