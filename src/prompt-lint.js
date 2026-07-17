function allCapabilityIds(capabilities = {}) {
  return new Set([...(capabilities.skills ?? []), ...(capabilities.plugins ?? []), ...(capabilities.hooks ?? [])].map((entry) => entry.id));
}


const NEGATION = /\b(?:do not|don't|never|must not|should not|cannot|can't|without|no)\b/i;
const DELEGATION_TO_TARGET = /\b(?:delegate|dispatch|spawn|call|invoke|hand off|route)\b[^;]*?(?:another\s+(?:agent|model|worker)|sub-?agent|nested\s+(?:agent|orchestration)|external\s+worker)/i;
const CREATE_NESTED = /\bcreate\s+(?:a\s+)?(?:sub-?agent|nested\s+(?:agent|orchestration))/i;

// Split on sentence and clause boundaries (including ';') but NOT commas, so a
// prohibition that lists several verbs ("do not delegate, dispatch, or spawn
// another agent") stays one clause governed by its negation, while an
// independent positive clause ("...; delegate to another model") is judged on
// its own. A clause that mentions delegation and carries no negation is a
// request; a negated clause is an allowed prohibition. This lets legitimate
// compiled prompts ("Do not create a nested orchestration loop") pass while
// still catching real positive delegation instructions.
function requestsNestedDelegation(prompt) {
  return String(prompt)
    .split(/[.!?;\n]+/)
    .some((clause) => (DELEGATION_TO_TARGET.test(clause) || CREATE_NESTED.test(clause)) && !NEGATION.test(clause));
}

function hasSection(prompt, section, strategy) {
  if (strategy === 'xml') return prompt.includes(`<${section}>`) && prompt.includes(`</${section}>`);
  return new RegExp(`(?:^|\\n)${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).test(prompt);
}

export function lintCompiledPrompt({ task, prompt, profile, capabilities = {}, lane = { lane: 'orchestrated' }, maxChars = 40_000 }) {
  const errors = [];
  const warnings = [];
  if (typeof prompt !== 'string' || prompt.trim() === '') errors.push('Compiled prompt must be a non-empty string.');
  if (typeof prompt === 'string' && prompt.length > maxChars) errors.push(`Compiled prompt exceeds the maximum prompt size of ${maxChars} characters.`);

  if (profile) {
    for (const section of profile.rules?.requiredSections ?? []) {
      if (!hasSection(prompt, section, profile.strategy)) errors.push(`Required prompt section is missing: ${section}`);
    }
  }

  for (const hidden of task.verifierCommands ?? []) {
    if (hidden && prompt.includes(hidden)) errors.push('Hidden verifier command leaked into the worker prompt.');
  }
  // Flag template placeholders and stub sections left unfilled, but not prose
  // that legitimately mentions TODO/TBD/FIXME (e.g. an objective "remove the
  // leftover TODO in parser.js"): a bare marker is a placeholder only when it
  // stands alone as an otherwise-empty line.
  if (/\{\{[^}]+\}\}|\[PLACEHOLDER\]/i.test(prompt) || /^[\s>-]*(?:TODO|TBD|FIXME)\b[:.\s]*$/im.test(prompt)) {
    errors.push('Compiled prompt contains an unresolved placeholder.');
  }
  const selected = allCapabilityIds(capabilities);
  for (const id of task.capabilityIds ?? []) {
    if (!selected.has(id)) errors.push(`Unknown capability in compiled task: ${id}`);
  }
  if (requestsNestedDelegation(prompt)) {
    const laneName = lane?.lane ?? 'worker';
    errors.push(`${laneName} prompt must not request nested delegation or another model call.`);
  }
  if (task.write !== true && /write access:\s*allowed|<write_access>bounded-write<\/write_access>/i.test(prompt)) {
    errors.push('Read-only task prompt contradicts its write permission.');
  }
  if (task.write === true && (task.allowedScope ?? []).length === 0) {
    errors.push('Delegated write prompt requires explicit allowed scope.');
  }
  if (!/OUTPUT|<output>/i.test(prompt)) errors.push('Delegated prompt requires an output contract.');
  return { valid: errors.length === 0, errors, warnings };
}

export function assertCompiledPrompt(input) {
  const result = lintCompiledPrompt(input);
  if (!result.valid) throw new Error(`Compiled prompt failed lint: ${result.errors.join(' ')}`);
  return result;
}
