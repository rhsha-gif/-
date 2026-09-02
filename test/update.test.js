import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePayloadHash, readRegistry, readStamp, registryKey } from '../src/install-registry.js';
import { installProject } from '../src/install.js';
import { refreshIfStale } from '../src/self-update.js';
import { updateInstalls } from '../src/update.js';

// Every test in this file writes the user-level registry; keep it out of the
// real home directory.
process.env.AORCH_HOME = await mkdtemp(path.join(os.tmpdir(), 'aorch-home-'));

async function newProject(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function markStale(projectRoot) {
  const stamp = await readStamp(projectRoot);
  await writeFile(
    path.join(projectRoot, '.aorch/install-stamp.json'),
    JSON.stringify({ ...stamp, payloadHash: 'stale-payload-hash' }),
    'utf8'
  );
}

test('install stamps the payload and registers the project once', async () => {
  const projectRoot = await newProject('aorch-update-stamp-');
  await installProject({ projectRoot, target: 'both' });
  await installProject({ projectRoot, target: 'claude' });

  const stamp = await readStamp(projectRoot);
  assert.equal(stamp.payloadHash, await computePayloadHash());
  // A narrower re-install must not shrink the recorded target: the codex
  // integration is still installed and still needs refreshing.
  assert.equal(stamp.target, 'both');

  const registry = await readRegistry();
  assert.equal(Object.keys(registry.projects).filter((key) => key === registryKey(projectRoot)).length, 1);
  assert.equal(registry.projects[registryKey(projectRoot)].target, 'both');
});

test('update refreshes a stale install and leaves a current one untouched', async () => {
  const projectRoot = await newProject('aorch-update-stale-');
  await installProject({ projectRoot, target: 'claude' });

  const untouched = await updateInstalls({ projects: [projectRoot] });
  assert.equal(untouched.results[0].status, 'current');
  assert.equal(untouched.refreshed, 0);

  // Simulate a package change: the stamp no longer matches the payload, and a
  // hand-edited installed file must be restored.
  await markStale(projectRoot);
  const hookPath = path.join(projectRoot, '.aorch/hooks/gate.mjs');
  await writeFile(hookPath, '// clobbered\n', 'utf8');

  const refreshed = await updateInstalls({ projects: [projectRoot] });
  assert.equal(refreshed.results[0].status, 'refreshed');
  assert.match(await readFile(hookPath, 'utf8'), /classifyPrompt/);
  assert.equal((await readStamp(projectRoot)).payloadHash, await computePayloadHash());
});

test('update preserves a project-tuned config and reports check mode without writing', async () => {
  const projectRoot = await newProject('aorch-update-config-');
  await installProject({ projectRoot, target: 'claude' });
  const configPath = path.join(projectRoot, '.aorch/config.json');
  const tuned = JSON.parse(await readFile(configPath, 'utf8'));
  tuned.routing = { ...(tuned.routing ?? {}), marker: 'project-tuned' };
  await writeFile(configPath, JSON.stringify(tuned), 'utf8');
  await markStale(projectRoot);

  const checked = await updateInstalls({ projects: [projectRoot], check: true });
  assert.equal(checked.results[0].status, 'stale');
  assert.equal(checked.refreshed, 0);
  assert.equal((await readStamp(projectRoot)).payloadHash, 'stale-payload-hash');

  await updateInstalls({ projects: [projectRoot] });
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).routing.marker, 'project-tuned');
});

test('update prunes registry entries whose project is gone or uninstalled', async () => {
  const removed = await newProject('aorch-update-removed-');
  const uninstalled = await newProject('aorch-update-uninstalled-');
  await installProject({ projectRoot: removed, target: 'claude' });
  await installProject({ projectRoot: uninstalled, target: 'claude' });
  await rm(removed, { recursive: true, force: true });
  await rm(path.join(uninstalled, '.claude'), { recursive: true, force: true });
  await rm(path.join(uninstalled, '.aorch/install-stamp.json'), { force: true });

  const result = await updateInstalls({});
  const byRoot = new Map(result.results.map((entry) => [entry.projectRoot, entry.status]));
  assert.equal(byRoot.get(path.resolve(removed)), 'missing');
  assert.equal(byRoot.get(path.resolve(uninstalled)), 'unmanaged');

  const registry = await readRegistry();
  assert.ok(!(registryKey(removed) in registry.projects));
  assert.ok(!(registryKey(uninstalled) in registry.projects));
});

test('auto-refresh never installs into a project that never opted in', async () => {
  const bare = await newProject('aorch-autoupdate-bare-');
  const result = await refreshIfStale({ projectRoot: bare, wait: true, env: {} });
  assert.equal(result.status, 'unmanaged');
  await assert.rejects(() => readFile(path.join(bare, '.claude/settings.json'), 'utf8'), /ENOENT/);
});

test('auto-refresh restores a stale install and honours the opt-out', async () => {
  const projectRoot = await newProject('aorch-autoupdate-');
  await installProject({ projectRoot, target: 'claude' });
  await markStale(projectRoot);

  const optedOut = await refreshIfStale({
    projectRoot,
    wait: true,
    env: { ...process.env, AORCH_NO_AUTOUPDATE: '1' }
  });
  assert.equal(optedOut.status, 'disabled');
  assert.equal((await readStamp(projectRoot)).payloadHash, 'stale-payload-hash');

  const refreshed = await refreshIfStale({ projectRoot, wait: true, env: {} });
  assert.equal(refreshed.status, 'refreshed');
  assert.equal((await readStamp(projectRoot)).payloadHash, await computePayloadHash());
  assert.equal(await refreshIfStale({ projectRoot, wait: true, env: {} }).then((r) => r.status), 'current');
});

test('the background refresh spawns at most one updater per project', async () => {
  const projectRoot = await newProject('aorch-autoupdate-lock-');
  await installProject({ projectRoot, target: 'claude' });
  await markStale(projectRoot);

  // Stub the spawn: a real detached updater would race this test's assertions.
  const spawned = [];
  const spawnProcess = (command, args) => {
    spawned.push({ command, args });
    return { unref() {} };
  };

  const first = await refreshIfStale({ projectRoot, env: {}, spawnProcess });
  const second = await refreshIfStale({ projectRoot, env: {}, spawnProcess });
  assert.equal(first.status, 'spawned');
  assert.equal(second.status, 'pending');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(-3), ['update', '--project', path.resolve(projectRoot)]);

  // A stale lock must not block refreshes forever.
  const later = await refreshIfStale({ projectRoot, env: {}, now: Date.now() + 120_000, spawnProcess });
  assert.equal(later.status, 'spawned');
  assert.equal(spawned.length, 2);
});

test('the background refresh claims a missing lock exclusively', async () => {
  const projectRoot = await newProject('aorch-autoupdate-exclusive-lock-');
  await installProject({ projectRoot, target: 'claude' });
  await markStale(projectRoot);

  const spawned = [];
  const spawnProcess = (command, args) => {
    spawned.push({ command, args });
    return { unref() {} };
  };

  const results = await Promise.all(Array.from({ length: 8 }, () => (
    refreshIfStale({ projectRoot, env: {}, spawnProcess })
  )));
  assert.equal(results.filter((result) => result.status === 'spawned').length, 1);
  assert.equal(results.filter((result) => result.status === 'pending').length, 7);
  assert.equal(spawned.length, 1);
});
