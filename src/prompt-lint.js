function allCapabilityIds(capabilities = {}) {
  return new Set([...(capabilities.skills ?? []), ...(capabilities.plugins ?? []), ...(capabilities.hooks ?? [])].map((entry) => entry.id));
}


function requestsNestedDelegation(prompt) {
  const withoutNegativeRules = prompt.replace(
    /\b(?:do not|don't|never|must not|should not|cannot|can't)\s+(?:create\s+)?(?:delegate|dispatch|spawn|call|invoke)\b[^\n.!?]*(?:[.!?]|$)/gi,
    ''
  );
  return /\b(?:delegate|dispatch|spawn|call|invoke)\b[^\n.!?]*(?:another\s+(?:agent|model|worker)|subagent|nested\s+(?:agent|orchestration)|external\s+worker)/i.test(withoutNegativeRules)
    || /\bcreate\s+(?:a\s+)?(?:subagent|nested\s+(?:agent|orchestration))/i.test(withoutNegativeRules);
}

function hasSection(prompt, section, strategy) {
  if (strategy === 'xml') return prompt.includes(`<${section}>`) && prompt.includes(`</${section}>`);
  return new RegExp(`(?:^|\\n)${section.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\n`).test(prompt);
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
  if (/\b(?:TODO|TBD|FIXME)\b|\{\{[^}]+\}\}|\[PLACEHOLDER\]/i.test(prompt)) {
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
