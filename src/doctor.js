import { spawnSync } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inspectFileStore } from './file-store.js';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function assertInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Active run path is outside state root: ${resolved}`);
  }
  return resolved;
}

async function inspectActiveRunPointer(root, { repair = false } = {}) {
  const pointerPath = path.join(root, 'active-run.json');
  if (!(await exists(pointerPath))) {
    return { status: 'pass', present: false, repaired: false, pointerPath };
  }

  try {
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    if (typeof pointer.runPath !== 'string' || pointer.runPath.trim() === '') {
      throw new Error('Active run pointer requires a non-empty runPath');
    }
    const runPath = assertInsideRoot(root, pointer.runPath);
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    if (!run || typeof run !== 'object' || typeof run.id !== 'string' || run.id.trim() === '') {
      throw new Error('Active run target is not a valid run state');
    }
    return {
      status: 'pass',
      present: true,
      repaired: false,
      pointerPath,
      runPath,
      runId: run.id
    };
  } catch (error) {
    if (repair) {
      await unlink(pointerPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      return {
        status: 'pass',
        present: true,
        repaired: true,
        pointerPath,
        issue: error.message
      };
    }
    return {
      status: 'fail',
      present: true,
      repaired: false,
      pointerPath,
      issue: error.message
    };
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
    reason: result.status === 0 ? null : (result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`)
  };
}

export function runDoctor(config) {
  const node = { status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail', version: process.versions.node };
  const providers = config.providers.filter((provider) => provider.enabled !== false).map(checkExecutable);
  const status = node.status === 'pass' && providers.every((provider) => provider.status === 'pass') ? 'pass' : 'fail';
  return {
    status,
    node,
    providers,
    catalog: { status: 'pass', providers: config.providers.length, models: config.models.length, capabilities: config.capabilities.length, modelSupport: 'not-probed' }
  };
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
