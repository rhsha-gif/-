function interpolate(value, route, prompt) {
  return value
    .replaceAll('{model}', route.model ?? '')
    .replaceAll('{effort}', route.effort ?? '')
    .replaceAll('{provider}', route.provider ?? '')
    .replaceAll('{prompt}', prompt ?? '');
}

export function buildGenericCommand({ prompt, route, provider, write = false }) {
  if (!provider?.executable || !Array.isArray(provider.args)) {
    throw new TypeError('generic provider requires executable and args');
  }
  const argumentMode = provider.promptMode === 'argument';
  if (argumentMode && !provider.args.some((arg) => arg.includes('{prompt}'))) {
    // Without a placeholder the worker would silently receive no prompt at all.
    throw new Error(`Generic provider ${provider.id ?? provider.executable} uses promptMode "argument" but no args entry contains the {prompt} placeholder`);
  }
  return {
    command: provider.executable,
    args: provider.args.map((arg) => interpolate(arg, route, argumentMode ? prompt : '')),
    stdin: argumentMode ? null : prompt,
    env: {
      AORCH_WORKER: '1',
      AORCH_WRITE: write ? '1' : '0',
      ...(provider.env ?? {})
    }
  };
}
