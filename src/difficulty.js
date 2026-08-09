// Maps a raw subtask description to the routing inputs selectRoute consumes.
// Heuristic (task-kind keywords + token-count), not a trained model — solo
// volume can't train a router. Borrowed clean-room from claude-code-router's
// scenario routing. NEVER drops the quality floor to zero (objective = time +
// limit savings WITH a minimum quality bar).

const KIND_RULES = [
  { kind: 'security', complexity: 'high', re: /\b(security|threat model|auth|vulnerab\w*|exploit|crypto)\b/i, reKo: /보안|취약점|인증|권한|암호화/i },
  { kind: 'architecture', complexity: 'high', re: /\b(architect|system design|design the|scalab\w*)\b/i, reKo: /아키텍처|설계|확장성/i },
  { kind: 'debugging', complexity: 'high', re: /\b(race condition|deadlock|heisenbug|root cause|debug)\b/i, reKo: /디버깅|교착|경쟁 상태|근본 원인/i },
  // Below debugging on purpose: "investigate and debug X" must classify as
  // debugging, not research. These two unlock haiku's existing exploration
  // and research taskKinds, which no classifier rule emitted before.
  { kind: 'exploration', complexity: 'low', re: /\b(explore|survey|find where|locate|map out)\b/i, reKo: /탐색|둘러보/i },
  { kind: 'research', complexity: 'low', re: /\b(research|look up|compare (?:libraries|options))\b/i, reKo: /조사|라이브러리 비교/i },
  { kind: 'documentation', complexity: 'low', re: /\b(format|indent\w*|docstring|comment|readme|rename|typo|boilerplate)\b/i, reKo: /리드미|오타|주석|포맷|들여쓰기|이름 변경/i },
  { kind: 'testing', complexity: 'standard', re: /\b(test|spec|coverage|regression)\b/i, reKo: /테스트|스펙|커버리지|회귀/i },
  { kind: 'implementation', complexity: 'standard', re: /\b(implement|add|refactor|extract|wire|build)\b/i, reKo: /구현|추가|리팩터|만들|작성|구축/i }
];

const FLOOR_BY_COMPLEXITY = Object.freeze({ low: 0.72, standard: 0.8, high: 0.88 });
const COMPLEXITY_RANK = Object.freeze({ low: 0, standard: 1, high: 2 });
// selectRoute is quality-first by default; minimumQuality is only a hard
// floor filter, not a reordering. Low/standard work downshifts to the
// cheapest tier that still clears the floor; high-complexity work keeps
// quality as the primary tiebreak.
const PRIORITIES_BY_COMPLEXITY = Object.freeze({
  low: Object.freeze(['tokens', 'quality', 'latency']),
  standard: Object.freeze(['tokens', 'quality', 'latency']),
  high: Object.freeze(['quality', 'tokens', 'latency'])
});

export function classifyDifficulty({ objective, kind, tokenEstimate, longContextThreshold = 60000 } = {}) {
  if (typeof objective !== 'string' || objective.trim() === '') {
    throw new TypeError('classifyDifficulty requires a non-empty objective');
  }
  const tokens = tokenEstimate ?? Math.round(objective.length / 4);
  const signals = [];

  const matched = KIND_RULES.find((rule) => rule.re.test(objective) || rule.reKo?.test(objective));
  const inferredKind = kind ?? matched?.kind ?? 'implementation';
  let complexity = matched?.complexity ?? 'standard';
  if (matched) signals.push(`kind:${matched.kind}`);
  if (kind) signals.push(`kind-explicit:${kind}`);

  if (tokens >= longContextThreshold) {
    signals.push('long-context');
    if (COMPLEXITY_RANK[complexity] < COMPLEXITY_RANK.standard) complexity = 'standard';
  }

  return {
    kind: inferredKind,
    complexity,
    minimumQuality: FLOOR_BY_COMPLEXITY[complexity],
    tokenEstimate: tokens,
    signals,
    routingPriorities: [...PRIORITIES_BY_COMPLEXITY[complexity]]
  };
}
