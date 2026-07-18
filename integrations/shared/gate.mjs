// Korean patterns must not use \b: JavaScript word boundaries are based on
// [A-Za-z0-9_], so \b never matches adjacent to Hangul and would make these
// alternations dead code. Substring matching fits Korean agglutination.
const HIGH_RISK_SUBJECT_PATTERNS = [
  /\b(production|prod)\b/i,
  /\b(database|schema|migration|migrate|drop|truncate|delete data)\b/i,
  /\b(auth|authentication|authorization|permission|credential|secret|security)\b/i,
  // Bare 'order'/'position' over-trigger on everyday English ("in order to",
  // "cursor position"); require trading context around them.
  /\b(payment|billing|financial|trading|trade|risk limit|kill switch)\b/i,
  /\border\s+(book|entry|execution|management)\b/i,
  /\bposition\s+(limit|sizing)\b|\b(open|close)\s+(a\s+|the\s+)?position\b/i,
  /(운영|배포|릴리스|마이그레이션|스키마|인증|권한|보안|결제|금융|주문|포지션|리스크|실거래|삭제)/
];

// External side effects are a separate dimension from local file writes.
// "do not edit config" cannot make deploy/push/order actions read-only.
const EXTERNAL_ACTION_PATTERNS = [
  /\b(deploy|publish|push|merge)\b/i,
  /\b(create|push|delete)\s+(a\s+|the\s+)?(release\s+)?tags?\b/i,
  /\brelease\s+(the\s+)?(build|version|package|artifact)\b/i,
  /\b(place|cancel|execute|submit|amend)\s+(an?\s+|the\s+)?orders?\b/i,
  /\b(open|close)\s+(a\s+|the\s+)?position\b/i,
  /(배포(해|하|시)|릴리스(해|하|시)|푸시(해|하|시)|머지(해|하|시)|태그를?\s*(생성|푸시)|주문을?\s*(실행|제출|취소|정정)|포지션을?\s*(열|닫)|실거래를?\s*(실행|시작))/
];

const EXTERNAL_EXPLANATION_PATTERNS = [
  /\b(explain|describe|analyze|show)\b.{0,80}\b(how|process|steps|procedure)\b.{0,50}\b(deploy|publish|push|merge|release)\b/i,
  /(배포|릴리스|푸시|머지).{0,30}(설명|과정|방법|절차)|(설명|분석).{0,30}(배포|릴리스|푸시|머지)/
];

const DEVELOPMENT_PATTERNS = [
  /\b(implement|build|create|add|change|modify|edit|fix|debug|refactor|test|upgrade|install|configure|review code)\b/i,
  /(구현|만들|추가|변경|수정|고쳐|디버그|리팩터링|테스트|업그레이드|설치|설정|코드 리뷰)/
];

// Destructive imperatives veto any read-only demotion: "drop the users table
// and show me what remains" must not classify low/open because of "show".
const DESTRUCTIVE_PATTERNS = [
  /\b(drop|truncate|wipe|destroy|delete)\b/i,
  /(삭제|드랍|초기화)/
];

const EXPLICIT_READ_ONLY_PATTERNS = [
  /\b(do not|don't|without)\s+(edit|modify|change|write)\b/i,
  /\b(do not|don't|without)\s+(execute|perform|run|apply|deploy|publish|push|merge|release)\b/i,
  /\bdo not execute anything\b/i,
  /\b(read[- ]only|no file changes)\b/i,
  // 마/말 covers 하지 마, 하지 말고, 하지 말아줘 (precomposed Hangul: '말' is
  // not a match for the literal '마').
  /(수정|변경|편집)하지\s*(마|말)|(건드리지|바꾸지|고치지)\s*(마|말)/,
  /파일을?\s*(건드리지|바꾸지)/
];

const READ_ONLY_PATTERNS = [
  /\b(explain|describe|summarize|compare|analyze|inspect|find|show|what|why|how)\b/i,
  /(설명|요약|비교|분석|찾아|보여|무엇|왜|어떻게|알려)/
];

function matchesAny(prompt, patterns) {
  return patterns.some((pattern) => pattern.test(prompt));
}

export function classifyPrompt(prompt) {
  const normalized = typeof prompt === 'string' ? prompt.trim() : '';
  const highRiskSubject = matchesAny(normalized, HIGH_RISK_SUBJECT_PATTERNS);
  const destructive = matchesAny(normalized, DESTRUCTIVE_PATTERNS);
  const explicitReadOnly = matchesAny(normalized, EXPLICIT_READ_ONLY_PATTERNS);
  const development = !explicitReadOnly && matchesAny(normalized, DEVELOPMENT_PATTERNS);
  const readOnlyVerb = matchesAny(normalized, READ_ONLY_PATTERNS);
  const readOnly = explicitReadOnly || readOnlyVerb;
  const explanatoryExternal = matchesAny(normalized, EXTERNAL_EXPLANATION_PATTERNS);
  const externalAction = matchesAny(normalized, EXTERNAL_ACTION_PATTERNS)
    && !(explicitReadOnly && readOnlyVerb && explanatoryExternal);

  if (externalAction || destructive) {
    return {
      requestClass: 'high-risk',
      riskHint: 'critical',
      failPolicy: 'closed',
      requiresOrchestration: true,
      durableRunRecommended: true,
      externalAction,
      destructive
    };
  }

  if (explicitReadOnly) {
    return {
      requestClass: 'read-only',
      riskHint: 'low',
      failPolicy: 'open',
      requiresOrchestration: true,
      durableRunRecommended: false
    };
  }
  if (highRiskSubject && (development || !readOnly)) {
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
    `The host is bootstrap-only for substantive work and must not edit project files. The orchestrator must preserve the user's final goal, avoid unnecessary task splitting, classify single-worker, bundled, or orchestrated execution, and choose each bounded task's provider, model, reasoning effort, skills, hooks, plugins, permissions, isolation, and verification plan from capabilities that are actually installed and trusted for the task risk.\n` +
    `Low-risk coherent work should use one separate bounded worker call with no separate router-model or LLM-reviewer call. Delegated work must use the official-source provider-aware prompt compiler and deterministic prompt lint. P2 record-only shadow routing must never launch a second write worker.\n` +
    `Treat worker output as a claim, not proof. Require independent verifier evidence before terminal completion. Keep delegation shallow and do not let workers modify the harness or control-plane policy.\n` +
    `A simple read-only request may be completed without a durable run after this classification. Development or high-risk work must use a durable run, explicit acceptance criteria, bounded scope, and post-run reflection.`;
}
