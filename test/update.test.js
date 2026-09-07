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

  // A stale stamp does not authorize overwriting a user's generated-file edit.
  await markStale(projectRoot);
  const hookPath = path.join(projectRoot, '.aorch/hooks/gate.mjs');
  await writeFile(hookPath, '// clobbered\n', 'utf8');

  const refreshed = await updateInstalls({ projects: [projectRoot] });
  assert.equal(refreshed.results[0].status, 'failed');
  assert.equal(refreshed.results[0].conflicts[0].reason, 'edited-generated-file');
  assert.equal(await readFile(hookPath, 'utf8'), '// clobbered\n');
  assert.equal((await readStamp(projectRoot)).payloadHash, 'stale-payload-hash');
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

test('old prompt-hook callers never spawn or mutate, even with a stale install', async () => {
  const projectRoot = await newProject('aorch-explicit-update-');
  await installProject({ projectRoot, target: 'claude' });
  await markStale(projectRoot);
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 8 }, () => refreshIfStale({ projectRoot, wait: true, env: {}, spawnProcess: () => { calls += 1; } })));
  assert.ok(results.every((result) => result.reason === 'explicit-update-required'));
  assert.equal(calls, 0);
  assert.equal((await readStamp(projectRoot)).payloadHash, 'stale-payload-hash');
  assert.equal((await updateInstalls({ projects: [projectRoot] })).refreshed, 1);
});
