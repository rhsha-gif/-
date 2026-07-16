function interpolate(value, route) {
  return value
    .replaceAll('{model}', route.model ?? '')
    .replaceAll('{effort}', route.effort ?? '')
    .replaceAll('{provider}', route.provider ?? '');
}

export function buildGenericCommand({ prompt, route, provider, write = false }) {
  if (!provider?.executable || !Array.isArray(provider.args)) {
    throw new TypeError('generic provider requires executable and args');
  }
  return {
    command: provider.executable,
    args: provider.args.map((arg) => interpolate(arg, route)),
    stdin: provider.promptMode === 'argument' ? null : prompt,
    env: {
      AORCH_WORKER: '1',
      AORCH_WRITE: write ? '1' : '0',
      ...(provider.env ?? {})
    }
  };
}
