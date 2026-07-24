const DEFAULT_LIMITS = Object.freeze({ skills: 3, plugins: 2, hooks: 3 });
const TYPE_TO_BUCKET = Object.freeze({ skill: 'skills', plugin: 'plugins', hook: 'hooks' });

function isCompatible(capability, provider) {
  const providers = capability.providers ?? ['*'];
  return providers.includes('*') || providers.includes(provider);
}

export function selectCapabilities({
  requestedIds = [], inventory = [], provider, limits = DEFAULT_LIMITS
}) {
  const byId = new Map();
  const ambiguousIds = new Set();
  for (const entry of inventory) {
    if (byId.has(entry.id)) ambiguousIds.add(entry.id);
    else byId.set(entry.id, entry);
  }
  const result = { skills: [], plugins: [], hooks: [] };
  const seen = new Set();

  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    if (ambiguousIds.has(id)) throw new Error(`Ambiguous capability ID: ${id}`);
    const capability = byId.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    if (capability.enabled === false) throw new Error(`Capability is disabled: ${id}`);
    if (!isCompatible(capability, provider)) {
      throw new Error(`Capability ${id} is not compatible with provider ${provider}`);
    }

    const bucket = TYPE_TO_BUCKET[capability.type];
    if (!bucket) throw new Error(`Unsupported capability type for ${id}: ${capability.type}`);
    result[bucket].push(capability);
  }

  for (const [bucket, entries] of Object.entries(result)) {
    const limit = limits[bucket] ?? DEFAULT_LIMITS[bucket];
    if (entries.length > limit) {
      const type = bucket.slice(0, -1);
      throw new Error(`${type} limit exceeded: ${entries.length} > ${limit}`);
    }
  }

  return result;
}
