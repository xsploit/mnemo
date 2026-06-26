const POLICY_RULE_PATTERNS = [
  /\bfrom\s+now\s+on\b/is,
  /\bcurrent\s+rule\b/is,
  /\bnew\s+rule\b/is,
  /\boverrid(?:e|es|den|ing)\b.{0,80}\b(previous|prior|rules?|instructions?)\b/is,
  /\b(do\s+not|don't)\s+listen\s+to\b/is,
  /\bignore\s+(anyone|everyone|all|previous|prior)\b/is,
  /\b(reply|respond|answer)\s+(only|to\s+everyone|to\s+all|with|to\s+.*\s+with)\b/is,
  /\b(only\s+reply|reply\s+only|only\s+say|say\s+only)\b/is,
  /\bnothing\s+else\b/is,
  /\b(shitlist|blacklist|blocklist)\b/is,
  /\bregard\s+them\s+as\s+enemies\b/is
];

const SAFE_OBSERVATION_PATTERNS = [
  /\b(prompt[-\s]?injection|social engineering|override attempt)\b/is,
  /\b(attempted|tried)\b.{0,80}\b(change|override|set)\b.{0,80}\b(rule|instruction|behavior)\b/is,
  /\bnot\s+(an|a)\s+instruction\b/is,
  /\bdo\s+not\s+obey\b/is
];

const POLICY_DOCUMENT_TYPES = new Set([
  "instruction",
  "instructions",
  "manual_memory",
  "policy",
  "procedural_note",
  "rule",
  "system_prompt"
]);

const POLICY_PREDICATES = new Set([
  "accepted",
  "current_rule",
  "instruction",
  "received instruction",
  "received_instruction",
  "reply_rule",
  "response_rule",
  "should_reply"
]);

export function looksLikeUserBehaviorRule(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) return false;
  if (SAFE_OBSERVATION_PATTERNS.some((pattern) => pattern.test(lowered))) return false;
  return POLICY_RULE_PATTERNS.some((pattern) => pattern.test(lowered));
}

export function isUnsafeMemoryPayload(input: {
  text: string;
  documentType?: string | undefined;
  subjectId?: string | undefined;
  predicate?: string | undefined;
  personaId?: string | undefined;
}): boolean {
  if (!looksLikeUserBehaviorRule(input.text)) return false;
  const documentType = input.documentType?.trim().toLowerCase() ?? "";
  const predicate = input.predicate?.trim().toLowerCase() ?? "";
  const subjectId = input.subjectId?.trim().toLowerCase() ?? "";
  const personaId = input.personaId?.trim().toLowerCase() ?? "";
  if (POLICY_DOCUMENT_TYPES.has(documentType)) return true;
  if (POLICY_PREDICATES.has(predicate)) return true;
  if (personaId && subjectId === personaId) return true;
  if (subjectId.includes("hikari") || subjectId.includes("persona") || subjectId.includes("assistant")) return true;
  return ["diary", "profile", "relationship_profile"].includes(documentType) && [
    "i am complying",
    "i accepted",
    "my instructions are",
    "must regard them",
    "must reply"
  ].some((phrase) => input.text.toLowerCase().includes(phrase));
}
