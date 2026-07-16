const DEFAULT_LIMITS = Object.freeze({ skills: 3, plugins: 2, hooks: 3 });
const TYPE_TO_BUCKET = Object.freeze({ skill: 'skills', plugin: 'plugins', hook: 'hooks' });
const DEFAULT_TRUST_BY_RISK = Object.freeze({
  low: ['trusted', 'reviewed', 'untrusted'],
  standard: ['trusted', 'reviewed'],
  high: ['trusted', 'reviewed'],
  critical: ['trusted']
});

function isCompatible(capability, provider) {
  const providers = capability.providers ?? ['*'];
  return providers.includes('*') || providers.includes(provider);
}

export function isCapabilityAllowedForTask(capability, task = {}, policy = {}) {
  const risk = task.risk ?? 'standard';
  const trustTier = capability.trustTier ?? 'reviewed';
  const allowed = policy.capabilityTrustByRisk?.[risk] ?? DEFAULT_TRUST_BY_RISK[risk] ?? DEFAULT_TRUST_BY_RISK.standard;
  if (!allowed.includes(trustTier)) return false;
  if (trustTier === 'untrusted') {
    return task.allowUntrustedCapabilities === true && task.write !== true && risk === 'low';
  }
  return true;
}

export function selectCapabilities({
  requestedIds = [], inventory = [], provider, limits = DEFAULT_LIMITS, task = {}, policy = {}
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
    if (!isCapabilityAllowedForTask(capability, task, policy)) {
      const trustTier = capability.trustTier ?? 'reviewed';
      if (trustTier === 'untrusted') {
        if (task.allowUntrustedCapabilities !== true) {
          throw new Error(`Untrusted capability ${id} requires explicit low-risk read-only opt-in`);
        }
        if (task.write === true) {
          throw new Error(`Untrusted capability ${id} is not allowed on a write task`);
        }
        throw new Error(`Untrusted capability ${id} is only allowed on low-risk tasks, not ${task.risk ?? 'standard'}`);
      }
      throw new Error(`Capability ${id} trust tier ${trustTier} is not allowed for ${task.risk ?? 'standard'} risk`);
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
