// Automatic refresh trigger for installed projects, called by the prompt hook.
// The hook runs under a 3-second host timeout, so this only does the cheap
// staleness check inline and hands the actual copy to a detached process; the
// refreshed payload applies from the next prompt onward. Every failure path is
// silent — this is convenience, not a control.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectProject, packageRoot } from './install-registry.js';

const LOCK_TTL_MS = 60_000;

function lockPath(projectRoot) {
  const key = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `aorch-update-${key}.lock`);
}

// One in-flight refresh per project: without this, every prompt sent while the
// first refresh is still copying would spawn another one.
async function claimLock(projectRoot, now) {
  const file = lockPath(projectRoot);
  try {
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(String(process.pid), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }

  try {
    const stats = await stat(file);
    if (now - stats.mtimeMs < LOCK_TTL_MS) return false;
    await unlink(file);
  } catch {
    return false;
  }

  try {
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(String(process.pid), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function refreshIfStale({
  projectRoot,
  env = process.env,
  wait = false,
  now = Date.now(),
  spawnProcess = spawn
} = {}) {
  if (env.AORCH_NO_AUTOUPDATE === '1' || env.AORCH_WORKER === '1' || env.AORCH_VERIFIER === '1') {
    return { status: 'disabled' };
  }
  let inspected;
  try {
    inspected = await inspectProject(projectRoot);
  } catch (error) {
    return { status: 'error', error: error.message };
  }
  // 'unmanaged' projects never opted in; auto-update must not install into them.
  if (inspected.status !== 'stale') return { status: inspected.status };

  if (wait) {
    const { updateInstalls } = await import('./update.js');
    const result = await updateInstalls({ projects: [inspected.projectRoot] });
    return { status: result.results[0]?.status ?? 'unknown' };
  }

  if (!(await claimLock(inspected.projectRoot, now))) return { status: 'pending' };
  try {
    const child = spawnProcess(
      process.execPath,
      [path.join(packageRoot(), 'src', 'cli.js'), 'update', '--project', inspected.projectRoot],
      {
        detached: true,
        stdio: 'ignore',
        // The child re-enters install code; keep it from recursing into another
        // auto-update if anything it runs consults this module.
        env: { ...env, AORCH_NO_AUTOUPDATE: '1' }
      }
    );
    child?.unref?.();
    return { status: 'spawned' };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}
