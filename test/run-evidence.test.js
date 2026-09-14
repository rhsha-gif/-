import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  controllerEvidencePath,
  normalizeRunEvidence,
  readControllerAttestation,
  readControllerEvidence,
  readRegisteredWorkRoots,
  readRunEvidence,
  recordRunEvidence,
  registerWorkRoot,
  runEvidenceIdentity,
  runEvidencePath,
  workRootRegistryPath
} from '../src/run-evidence.js';

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-alpha',
    taskId: 'T-1',
    runId: 'run-1',
    attempt: 1,
    recordedAt: '2026-09-13T00:00:00.000Z',
    route: { provider: 'openai', adapter: 'codex', profileId: 'codex-test', model: 'gpt-test', effort: 'medium' },
    task: { kind: 'implementation', risk: 'standard', complexity: 'standard' },
    execution: {
      status: 'complete', completed: true, durationMs: 1200, reworkDurationMs: 200,
      inputTokens: 10, outputTokens: 20, totalTokens: 30
    },
    artifact: { status: 'fail' },
    evaluation: { source: 'independent-gate', status: 'major' },
    ...overrides
  };
}

test('run evidence records stable attempt identity and keeps execution completion separate from artifact quality', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-run-evidence-');
  const written = await recordRunEvidence({ root, evidence: evidence() });
  const source = await readRunEvidence({ root });

  assert.equal(source.available, true);
  assert.deepEqual(source.records, [written]);
  assert.equal(written.execution.completed, true);
  assert.equal(written.artifact.status, 'fail');
  assert.equal(written.execution.totalTokens, 30);
  assert.equal(runEvidenceIdentity(written), ['project-alpha', 'run-1', 'T-1', '1'].join('\0'));
  assert.equal(source.filePath, runEvidencePath(root));
});

test('run evidence supports a configured project state root', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-run-evidence-state-');
  await recordRunEvidence({ root, stateRoot: '.project-state', evidence: evidence() });
  const source = await readRunEvidence({ root, stateRoot: '.project-state' });
  assert.equal(source.records.length, 1);
  assert.equal(source.filePath, path.join(root, '.project-state', 'run-evidence.jsonl'));
});

test('action-required failures and detailed provider token counters are preserved', () => {
  const normalized = normalizeRunEvidence({
    ...evidence(),
    execution: {
      status: 'failed', completed: false, failureKind: 'action-required',
      inputTokens: 10, outputTokens: 20, reasoningTokens: 7,
      cacheReadTokens: 30, cacheCreationTokens: 4, totalTokens: 71
    },
    artifact: { status: 'unscored' },
    evaluation: undefined
  });
  assert.equal(normalized.execution.failureKind, 'action-required');
  assert.equal(normalized.execution.reasoningTokens, 7);
  assert.equal(normalized.execution.cacheReadTokens, 30);
  assert.equal(normalized.execution.cacheCreationTokens, 4);
});

test('explicit controller attestation stores the normalized evidence outside the workspace', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-attested-root-');
  const homeDir = await temporaryDirectory(t, 'aorch-attested-home-');
  const normalized = await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence() });
  const attestationPath = controllerEvidencePath(normalized, { homeDir });
  const result = await readControllerAttestation(normalized, { homeDir });
  const persisted = JSON.parse(await readFile(attestationPath, 'utf8'));

  assert.equal(result.matches, true);
  assert.ok(attestationPath.startsWith(path.join(homeDir, '.aorch', 'learning', 'controller-evidence')));
  assert.deepEqual(Object.keys(persisted).sort(), ['attestedAt', 'evidence', 'evidenceDigest', 'identityHash', 'schemaVersion']);
  assert.deepEqual(persisted.evidence, normalized);
  assert.equal(JSON.stringify(persisted).includes('private conversation'), false);
  assert.equal(JSON.stringify(persisted).includes('secret'), false);
});

test('legacy digest-only controller evidence stays unscored until an explicit attestation upgrades it', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-legacy-attested-root-');
  const homeDir = await temporaryDirectory(t, 'aorch-legacy-attested-home-');
  const normalized = await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence() });
  const attestationPath = controllerEvidencePath(normalized, { homeDir });
  const current = JSON.parse(await readFile(attestationPath, 'utf8'));
  const legacy = {
    schemaVersion: 1,
    identityHash: current.identityHash,
    evidenceDigest: current.evidenceDigest,
    attestedAt: current.attestedAt
  };
  await writeFile(attestationPath, JSON.stringify(legacy));

  assert.equal((await readControllerAttestation(normalized, { homeDir })).matches, false);
  const before = await readControllerEvidence({ homeDir });
  assert.equal(before.records.length, 0);
  assert.equal(before.legacyRecords.length, 1);

  await recordRunEvidence({ root, homeDir, attest: true, evidence: normalized });
  const after = await readControllerEvidence({ homeDir });
  assert.equal(after.records.length, 1);
  assert.equal(after.legacyRecords.length, 0);
  assert.equal(after.records[0].schemaVersion, 2);
  assert.deepEqual(after.records[0].evidence, normalized);
});

test('run evidence schema rejects free-form transcript and credential fields', () => {
  assert.throws(() => normalizeRunEvidence({ ...evidence(), transcript: 'private conversation' }), /transcript.*not allowed/);
  assert.throws(() => normalizeRunEvidence({
    ...evidence(),
    route: { ...evidence().route, apiKey: 'secret' }
  }), /apiKey.*not allowed/);
});

test('work root registration is atomic local learning state and does not touch installs registry', async (t) => {
  const homeDir = await temporaryDirectory(t, 'aorch-learning-home-');
  const firstRoot = path.join(homeDir, 'work-one');
  const secondRoot = path.join(homeDir, 'work-two');
  const installsPath = path.join(homeDir, '.aorch', 'installs.json');
  await registerWorkRoot(firstRoot, { homeDir, now: '2026-09-01T00:00:00Z' });
  await registerWorkRoot(secondRoot, { homeDir, stateRoot: '.state', now: '2026-09-02T00:00:00Z' });
  await registerWorkRoot(firstRoot, { homeDir, stateRoot: '.custom' });

  const roots = await readRegisteredWorkRoots({ homeDir });
  assert.equal(roots.length, 2);
  assert.equal(roots.find((entry) => entry.root === path.resolve(firstRoot)).stateRoot, path.resolve(firstRoot, '.custom'));
  assert.equal(JSON.parse(await readFile(workRootRegistryPath({ homeDir }), 'utf8')).schemaVersion, 1);
  await assert.rejects(readFile(installsPath, 'utf8'), { code: 'ENOENT' });
});

test('corrupt run logs and work registries surface instead of becoming empty evidence', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-run-evidence-corrupt-');
  const homeDir = await temporaryDirectory(t, 'aorch-registry-corrupt-');
  await mkdir(path.dirname(runEvidencePath(root)), { recursive: true });
  await writeFile(runEvidencePath(root), '{broken\n');
  await assert.rejects(readRunEvidence({ root }), /Invalid JSONL/);

  const registryPath = workRootRegistryPath({ homeDir });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, '{bad');
  await assert.rejects(readRegisteredWorkRoots({ homeDir }), /Invalid work root registry/);
});
