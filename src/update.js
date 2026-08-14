// Refresh installed integrations from this package. An install is a snapshot,
// so every project that holds one drifts as soon as this package changes;
// `aorch update` re-applies the current payload to the registered projects.
import { computePayloadHash, forgetInstall, inspectProject, readRegistry } from './install-registry.js';
import { installProject } from './install.js';

export async function updateInstalls({ projects, check = false, prune = true } = {}) {
  const registry = await readRegistry();
  const explicit = Array.isArray(projects) && projects.length > 0;
  const targets = explicit ? projects : Object.keys(registry.projects);
  const payloadHash = await computePayloadHash();

  const results = [];
  for (const candidate of targets) {
    const inspected = await inspectProject(candidate, payloadHash);
    // A project that moved away or was uninstalled stays in the registry
    // forever otherwise, and every later update reports the same dead entry.
    if (inspected.status === 'missing' || inspected.status === 'unmanaged') {
      if (prune && !explicit) await forgetInstall(inspected.projectRoot);
      results.push({ projectRoot: inspected.projectRoot, target: inspected.target, status: inspected.status });
      continue;
    }
    if (inspected.status === 'current' || check) {
      results.push({ projectRoot: inspected.projectRoot, target: inspected.target, status: inspected.status });
      continue;
    }
    try {
      // forceConfig stays false: a refresh must never discard a project's
      // tuned .aorch/config.json.
      await installProject({ projectRoot: inspected.projectRoot, target: inspected.target, forceConfig: false });
      results.push({ projectRoot: inspected.projectRoot, target: inspected.target, status: 'refreshed' });
    } catch (error) {
      results.push({
        projectRoot: inspected.projectRoot,
        target: inspected.target,
        status: 'failed',
        error: error.message
      });
    }
  }

  return {
    payloadHash,
    checked: results.length,
    refreshed: results.filter((entry) => entry.status === 'refreshed').length,
    stale: results.filter((entry) => entry.status === 'stale').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results
  };
}
