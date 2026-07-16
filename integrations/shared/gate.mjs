const HIGH_RISK_PATTERNS = [
  /\b(production|prod|deploy|release|publish|push|merge|tag)\b/i,
  /\b(database|schema|migration|migrate|drop|truncate|delete data)\b/i,
  /\b(auth|authentication|authorization|permission|credential|secret|security)\b/i,
  /\b(payment|billing|financial|trading|trade|order|position|risk limit|kill switch)\b/i,
  /\b(운영|배포|릴리스|마이그레이션|스키마|인증|권한|보안|결제|금융|주문|포지션|리스크|실거래|삭제)\b/i
];

const DEVELOPMENT_PATTERNS = [
  /\b(implement|build|create|add|change|modify|edit|fix|debug|refactor|test|upgrade|install|configure|review code)\b/i,
  /\b(구현|만들|추가|변경|수정|고쳐|디버그|리팩터링|테스트|업그레이드|설치|설정|코드 리뷰)\b/i
];

const EXPLICIT_READ_ONLY_PATTERNS = [
  /\b(do not|don't|without)\s+(edit|modify|change|write)\b/i,
  /\b(read[- ]only|no file changes)\b/i,
  /(수정|변경|편집)하지\s*마|파일을?\s*(건드리지|바꾸지)/i
];

const READ_ONLY_PATTERNS = [
  /\b(explain|describe|summarize|compare|analyze|inspect|find|show|what|why|how)\b/i,
  /\b(설명|요약|비교|분석|찾아|보여|무엇|왜|어떻게|알려)\b/i
];

function matchesAny(prompt, patterns) {
  return patterns.some((pattern) => pattern.test(prompt));
}

export function classifyPrompt(prompt) {
  const normalized = typeof prompt === 'string' ? prompt.trim() : '';
  const highRisk = matchesAny(normalized, HIGH_RISK_PATTERNS);
  const explicitReadOnly = matchesAny(normalized, EXPLICIT_READ_ONLY_PATTERNS);
  const development = !explicitReadOnly && matchesAny(normalized, DEVELOPMENT_PATTERNS);
  const readOnly = explicitReadOnly || matchesAny(normalized, READ_ONLY_PATTERNS);

  if (explicitReadOnly) {
    return {
      requestClass: 'read-only',
      riskHint: 'low',
      failPolicy: 'open',
      requiresOrchestration: true,
      durableRunRecommended: false
    };
  }
  if (highRisk && development) {
    return {
      requestClass: 'high-risk',
      riskHint: 'critical',
      failPolicy: 'closed',
      requiresOrchestration: true,
      durableRunRecommended: true
    };
  }
  if (development) {
    return {
      requestClass: 'development',
      riskHint: 'standard',
      failPolicy: 'closed',
      requiresOrchestration: true,
      durableRunRecommended: true
    };
  }
  return {
    requestClass: 'read-only',
    riskHint: 'low',
    failPolicy: 'open',
    requiresOrchestration: true,
    durableRunRecommended: false,
    recognizedReadOnlyIntent: readOnly
  };
}

export function buildGateContext(classification) {
  const requestClass = classification?.requestClass ?? 'read-only';
  const riskHint = classification?.riskHint ?? 'low';
  const failPolicy = classification?.failPolicy ?? 'open';
  const durableRun = classification?.durableRunRecommended === true ? 'recommended' : 'optional';

  return `ROOT GATE: The adaptive orchestrator must run first for this prompt.\n` +
    `Classification: ${requestClass}; risk hint: ${riskHint}; gate failure policy: ${failPolicy}; durable run: ${durableRun}.\n` +
    `This blocking hook is intentionally thin. Perform task decomposition, inventory lookup, lessons retrieval, route scoring, and provider execution outside this hook by invoking the adaptive-orchestrate skill.\n` +
    `The orchestrator must preserve the user's final goal, avoid unnecessary task splitting, and choose each bounded task's provider, model, reasoning effort, skills, hooks, plugins, permissions, isolation, and verification plan from capabilities that are actually installed and trusted for the task risk.\n` +
    `Treat worker output as a claim, not proof. Require independent verifier evidence before terminal completion. Keep delegation shallow and do not let workers modify the harness or control-plane policy.\n` +
    `A simple read-only request may be completed without a durable run after this classification. Development or high-risk work must use a durable run, explicit acceptance criteria, bounded scope, and post-run reflection.`;
}
