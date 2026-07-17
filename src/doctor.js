import { spawnSync } from 'node:child_process';
import { access, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inspectFileStore, withFileLock } from './file-store.js';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function resolveReal(candidate) {
  try { return await realpath(candidate); }
  catch { return path.resolve(candidate); }
}

// Compare realpaths: a pointer created through a symlinked project alias must
// not be judged "outside the state root" (and deleted by --repair) merely
// because doctor runs from the physical path.
async function assertInsideRoot(root, candidate) {
  const resolvedRoot = await resolveReal(root);
  const resolved = await resolveReal(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Active run path is outside state root: ${resolved}`);
  }
  return resolved;
}

async function validateActiveRunPointer(root, pointerPath) {
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  if (typeof pointer.runPath !== 'string' || pointer.runPath.trim() === '') {
    throw new Error('Active run pointer requires a non-empty runPath');
  }
  const runPath = await assertInsideRoot(root, pointer.runPath);
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || run.id.trim() === '') {
    throw new Error('Active run target is not a valid run state');
  }
  return { runPath, runId: run.id };
}

async function inspectActiveRunPointer(root, { repair = false } = {}) {
  const pointerPath = path.join(root, 'active-run.json');
  if (!(await exists(pointerPath))) {
    return { status: 'pass', present: false, repaired: false, pointerPath };
  }

  try {
    const { runPath, runId } = await validateActiveRunPointer(root, pointerPath);
    return { status: 'pass', present: true, repaired: false, pointerPath, runPath, runId };
  } catch (error) {
    if (repair) {
      // Re-validate and unlink under the same lock createRun uses to publish
      // the pointer, so a concurrent `aorch run start` cannot have its freshly
      // written valid pointer deleted between our check and the unlink.
      return withFileLock(`${pointerPath}.lock`, async () => {
        try {
          const { runPath, runId } = await validateActiveRunPointer(root, pointerPath);
          return { status: 'pass', present: true, repaired: false, pointerPath, runPath, runId };
        } catch (lockedError) {
          await unlink(pointerPath).catch((unlinkError) => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          });
          return { status: 'pass', present: true, repaired: true, pointerPath, issue: lockedError.message };
        }
      });
    }
    return { status: 'fail', present: true, repaired: false, pointerPath, issue: error.message };
  }
}

export function checkExecutable(provider) {
  const executable = provider.executable ?? (provider.adapter === 'claude' ? 'claude' : provider.adapter === 'codex' ? 'codex' : null);
  if (!executable) return { id: provider.id, status: 'fail', reason: 'no executable configured' };
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  return {
    id: provider.id,
    executable,
    status: result.status === 0 ? 'pass' : 'fail',
    version: result.status === 0 ? result.stdout.trim() || result.stderr.trim() : null,
    reason: result.status === 0 ? null : (result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`))
  };
}

export function runDoctor(config) {
  const node = { status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail', version: process.versions.node };
  const providers = config.providers.filter((provider) => provider.enabled !== false).map(checkExecutable);
  const enabledModels = config.models.filter((model) => model.enabled !== false).length;
  // A catalog with no usable provider or model can never route a task; report
  // it as a failure instead of a hollow 'pass'.
  const catalogIssues = [];
  if (providers.length === 0) catalogIssues.push('no enabled providers configured');
  if (enabledModels === 0) catalogIssues.push('no enabled models configured');
  const catalog = {
    status: catalogIssues.length === 0 ? 'pass' : 'fail',
    providers: config.providers.length,
    enabledProviders: providers.length,
    models: config.models.length,
    enabledModels,
    capabilities: config.capabilities.length,
    modelSupport: 'not-probed',
    ...(catalogIssues.length ? { issues: catalogIssues } : {})
  };
  const status = node.status === 'pass' && catalog.status === 'pass'
    && providers.every((provider) => provider.status === 'pass') ? 'pass' : 'fail';
  return { status, node, providers, catalog };
}

export async function inspectStateHealth(root, options = {}) {
  const files = await inspectFileStore(root, options);
  const activeRun = await inspectActiveRunPointer(root, options);
  return {
    ...files,
    status: files.status === 'pass' && activeRun.status === 'pass' ? 'pass' : 'fail',
    activeRun
  };
}
