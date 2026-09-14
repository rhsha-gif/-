// A transport account is not a model family: AGY can also run Claude.
export function modelFamily(profile = {}, provider = {}) {
  profile ??= {};
  provider ??= {};
  const name = profile.model ?? '';
  if (/^(claude-|haiku$|sonnet$|opus$|fable$)/i.test(name)) return 'claude';
  if (/^gemini-/i.test(name)) return 'gemini';
  if (/^grok-/i.test(name)) return 'grok';
  if (/^(gpt-|o[134](?:-|$))/i.test(name)) return 'gpt';
  if (profile.modelFamily) return profile.modelFamily;
  if (provider.adapter === 'claude') return 'claude';
  if (provider.adapter === 'codex') return 'gpt';
  return null;
}

export function familyAllowed(profile, provider, task) {
  if (!task.forbiddenModelFamilies?.length) return true;
  const family = modelFamily(profile, provider);
  return family !== null && !task.forbiddenModelFamilies.includes(family);
}
