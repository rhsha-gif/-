import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateWeekly,
  policyObservations,
  readWeeklyPolicy,
  restoreWeeklyPolicy
} from '../src/evaluation.js';
import { recordRunEvidence, runEvidencePath } from '../src/run-evidence.js';

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const CONFIG = Object.freeze({
  routing: { uncertaintyPenalty: 0 },
  models: [{
    id: 'codex-test', provider: 'openai', model: 'gpt-test',
    quality: { default: 0.7, implementation: 0.7 },
    efforts: [{ name: 'medium', qualityDelta: 0 }]
  }]
});

function evidence(index, overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-alpha',
    taskId: `T-${index}`,
    runId: `run-${index}`,
    attempt: 1,
    recordedAt: `2026-09-${String(8 + index).padStart(2, '0')}T00:00:00.000Z`,
    route: { provider: 'openai', adapter: 'codex', profileId: 'codex-test', model: 'gpt-test', effort: 'medium' },
    task: { kind: 'implementation', risk: 'standard', complexity: 'standard' },
    execution: { status: 'complete', completed: true, durationMs: 100, reworkDurationMs: index, totalTokens: 10 },
    artifact: { status: 'pass' },
    evaluation: { source: 'independent-gate', status: 'pass' },
    ...overrides
  };
}

async function seedFive(root, homeDir, override = () => ({})) {
  for (let index = 1; index <= 5; index += 1) {
    await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence(index, override(index)) });
  }
}

test('weekly evaluation emits raw approved observations after the five-sample floor', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-five-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-home-');
  await seedFive(root, homeDir, (index) => index === 1
    ? {
        execution: {
          status: 'complete', completed: true, durationMs: 100, reworkDurationMs: 1,
          inputTokens: 3, outputTokens: 4, reasoningTokens: 5,
          cacheReadTokens: 6, cacheCreationTokens: 7, totalTokens: 10
        },
        artifact: { status: 'fail' },
        evaluation: { source: 'independent-gate', status: 'pass' }
      }
    : {});

  const result = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.applied, false);
  assert.equal(result.report.quality.eligibleObservations, 5);
  assert.equal(result.report.metrics.executionComplete, 5);
  assert.equal(result.report.metrics.artifactFail, 1);
  assert.equal(result.report.metrics.reasoningTokens, 5);
  assert.equal(result.report.metrics.cacheReadTokens, 6);
  assert.equal(result.report.metrics.cacheCreationTokens, 7);
  assert.equal(result.report.metrics.observedCounts.reasoningTokens, 1);
  assert.equal(result.report.metrics.observedCounts.inputTokens, 1);
  assert.equal(result.report.metrics.observedCounts.totalTokens, 5);
  assert.equal(result.policy.routeGroups.length, 1);
  assert.equal(result.policy.routeGroups[0].weeklySamples, 5);
  assert.equal(result.policy.routeGroups[0].estimate.priorWeight, 3);
  assert.equal(policyObservations(result.policy).length, 5);
  assert.equal(policyObservations(result.policy)[0].quality, 1, 'finding an artifact defect is a successful independent gate');
  assert.deepEqual(policyObservations(result.policy, { kind: 'implementation', risk: 'high', complexity: 'high' }), []);
  assert.deepEqual(policyObservations(result.policy, {
    kind: 'implementation', risk: 'standard', complexity: 'standard', allowedProfileIds: ['codex-test']
  }), []);
  assert.deepEqual(policyObservations(
    result.policy,
    { kind: 'implementation', risk: 'standard', complexity: 'standard' },
    { minimumSamples: 6 }
  ), []);
});

test('workspace tampering cannot replace canonical controller quality', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-attested-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-attested-home-');
  await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence(1) });

  const trusted = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(trusted.report.quality.eligibleObservations, 1);

  const filePath = runEvidencePath(root);
  const tampered = JSON.parse((await readFile(filePath, 'utf8')).trim());
  tampered.evaluation.status = 'fail';
  await writeFile(filePath, `${JSON.stringify(tampered)}\n`);
  const rejected = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(rejected.report.quality.eligibleObservations, 1);
  assert.equal(rejected.report.quality.duplicateObservations, 1);
  assert.equal(rejected.report.quality.ineligibleReasons['controller-attestation-mismatch'], undefined);
});

test('configured learning sample floors above five gate policy eligibility', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-minimum-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-minimum-home-');
  const config = { ...CONFIG, learning: { minimumSamples: 7 } };
  await seedFive(root, homeDir);

  const below = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-16T00:00:00Z', config });
  assert.equal(below.policy.parameters.minimumSamples, 7);
  assert.equal(below.policy.routeGroups.length, 0);

  await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence(6) });
  await recordRunEvidence({ root, homeDir, attest: true, evidence: evidence(7) });
  const eligible = await evaluateWeekly({ roots: [root], homeDir, apply: true, now: '2026-09-16T00:00:00Z', config });
  assert.equal(eligible.policy.routeGroups.length, 1);
  assert.equal(eligible.policy.routeGroups[0].observations.length, 7);
  assert.equal((await readWeeklyPolicy({ homeDir })).parameters.minimumSamples, 7);
});

test('future-dated quality evidence stays ineligible until its recorded time', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-future-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-future-home-');
  await seedFive(root, homeDir, () => ({ recordedAt: '2026-09-20T00:00:00Z' }));

  const early = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(early.report.quality.eligibleObservations, 0);
  assert.equal(early.report.quality.ineligibleReasons['future-dated-evidence'], 5);
  assert.equal(early.report.metrics.attempts, 0);
  assert.equal(early.policy.routeGroups.length, 0);

  const onTime = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-20T00:00:00Z', config: CONFIG });
  assert.equal(onTime.report.quality.eligibleObservations, 5);
  assert.equal(onTime.policy.routeGroups.length, 1);
});

test('copied and resumed attempt identities deduplicate while unavailable execution remains unscored', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-source-');
  const copy = await temporaryDirectory(t, 'aorch-evaluate-copy-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-dedup-home-');
  await seedFive(root, homeDir);
  await mkdir(path.dirname(runEvidencePath(copy)), { recursive: true });
  await writeFile(runEvidencePath(copy), await readFile(runEvidencePath(root), 'utf8'));
  await recordRunEvidence({
    root,
    homeDir,
    attest: true,
    evidence: evidence(6, {
      execution: { status: 'failed', completed: false, failureKind: 'network' },
      artifact: { status: 'unscored' },
      evaluation: { source: 'independent-gate', status: 'unavailable' }
    })
  });

  const result = await evaluateWeekly({ roots: [root, copy], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.quality.eligibleObservations, 5);
  assert.equal(result.report.quality.ineligibleReasons['evaluation-unavailable'], 1);
  assert.ok(result.report.quality.duplicateObservations >= 5);
  assert.equal(result.policy.routeGroups[0].observations.length, 5);
});

test('legacy, protected-risk, and caught-defect reviewer evidence cannot adjust policy', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-risk-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-risk-home-');
  await recordRunEvidence({
    root,
    homeDir,
    attest: true,
    evidence: evidence(1, { task: { kind: 'implementation', risk: 'high', complexity: 'high' } })
  });
  await recordRunEvidence({
    root,
    homeDir,
    attest: true,
    evidence: evidence(2, {
      task: { kind: 'review', role: 'reviewer', risk: 'standard', complexity: 'standard' },
      artifact: { status: 'fail' },
      evaluation: { source: 'independent-gate', status: 'fail' }
    })
  });
  const observationsPath = path.join(root, '.aorch', 'observations.jsonl');
  const legacy = {
    provider: 'openai', profileId: 'codex-test', model: 'gpt-test', effort: 'medium',
    taskKind: 'implementation', quality: 0.2, reviewed: true,
    recordedAt: '2026-09-13T00:00:00Z', metadata: { source: 'verify-gate', taskId: 'legacy', attempt: 1 }
  };
  const reviewer = {
    ...legacy,
    taskKind: 'review', role: 'reviewer', recordedAt: '2026-09-13T01:00:00Z',
    metadata: {
      source: 'verify-gate', taskId: 'reviewer', attempt: 1,
      risk: 'standard', complexity: 'standard', explicitModelPin: false
    }
  };
  await writeFile(observationsPath, `${JSON.stringify(legacy)}\n${JSON.stringify(reviewer)}\n`);

  const result = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.quality.status, 'unscored');
  assert.equal(result.report.quality.ineligibleReasons['protected-risk-or-complexity'], 1);
  assert.equal(result.report.quality.ineligibleReasons['legacy-unattested'], 2);
  assert.equal(result.report.quality.ineligibleReasons['reviewer-detected-subject-defect'], 1);
  assert.equal(result.policy.routeGroups.length, 0);
});

test('standalone workspace and legacy evidence remain unscored without controller attestation', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-upgrade-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-upgrade-home-');
  await recordRunEvidence({ root, evidence: evidence(1) });
  await writeFile(path.join(root, '.aorch', 'observations.jsonl'), `${JSON.stringify({
    provider: 'openai', profileId: 'codex-test', model: 'gpt-test', effort: 'medium',
    taskKind: 'implementation', quality: 1, reviewed: true,
    recordedAt: '2026-09-13T00:00:00Z', metadata: {
      source: 'verify-gate', projectId: 'project-alpha', runId: 'run-1', taskId: 'T-1', attempt: 1,
      risk: 'standard', complexity: 'standard', explicitModelPin: false
    }
  })}\n`);

  const result = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.quality.eligibleObservations, 0);
  assert.equal(result.report.quality.unscoredObservations, 1);
  assert.equal(result.report.quality.ineligibleReasons['no-controller-attestation'], 1);
  assert.equal(result.report.quality.duplicateObservations, 1);
});

test('historic receipts and verification artifacts are reported but never inferred as quality', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-historic-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-historic-home-');
  const taskDir = path.join(root, '.aorch', 'task-runs', 'run-old', 'T-old');
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, 'receipt.json'), JSON.stringify({ status: 'complete' }));
  await writeFile(path.join(taskDir, 'verification.json'), JSON.stringify({ attempt: 1, passed: false, results: [{ command: 'test', exitCode: 1 }] }));

  const result = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.metrics.executionComplete, 1);
  assert.equal(result.report.metrics.artifactFail, 1);
  assert.equal(result.report.quality.status, 'unscored');
  assert.equal(result.report.quality.eligibleObservations, 0);
});

test('missing installed roots and source logs are visible rather than counted as zero-success projects', async (t) => {
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-installs-home-');
  const missingRoot = path.join(homeDir, 'gone-project');
  const installsPath = path.join(homeDir, '.aorch', 'installs.json');
  await mkdir(path.dirname(installsPath), { recursive: true });
  await writeFile(installsPath, JSON.stringify({ version: 1, projects: { [missingRoot.replaceAll('\\', '/')]: { target: 'codex' } } }));

  const result = await evaluateWeekly({ homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.registries.installs.available, true);
  assert.equal(result.report.roots.length, 1);
  assert.equal(result.report.roots[0].available, false);
  assert.deepEqual(result.report.roots[0].sources, { runEvidence: false, observations: false, taskRuns: false });
  assert.equal(result.report.quality.status, 'unscored');
});

test('an empty evaluation and a repeated week with no new evidence make no policy change', async (t) => {
  const emptyRoot = await temporaryDirectory(t, 'aorch-evaluate-empty-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-old-home-');
  const empty = await evaluateWeekly({ roots: [emptyRoot], homeDir, apply: true, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(empty.applied, false);
  assert.equal(await readWeeklyPolicy({ homeDir }), null);

  const root = await temporaryDirectory(t, 'aorch-evaluate-repeat-');
  await seedFive(root, homeDir, () => ({ recordedAt: '2026-07-01T00:00:00Z' }));
  const first = await evaluateWeekly({ roots: [root], homeDir, apply: true, now: '2026-09-14T01:00:00Z', config: CONFIG });
  const repeated = await evaluateWeekly({ roots: [root], homeDir, apply: true, now: '2026-09-21T01:00:00Z', config: CONFIG });
  assert.equal(first.applied, true, 'the accumulated sample floor is independent of weekly volume');
  assert.equal(repeated.applied, false);
  assert.equal(repeated.policy.version, first.policy.version);
  assert.equal(repeated.report.quality.currentWindowEligibleObservations, 0);
});

test('applied versioned policies can be restored and corrupt policy data fails closed', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-policy-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-policy-home-');
  await seedFive(root, homeDir);
  const first = await evaluateWeekly({ roots: [root], homeDir, apply: true, now: '2026-09-14T00:00:00Z', config: CONFIG });
  await recordRunEvidence({
    root, homeDir, attest: true, evidence: evidence(6, { recordedAt: '2026-09-15T00:00:00Z' })
  });
  const second = await evaluateWeekly({ roots: [root], homeDir, apply: true, now: '2026-09-15T01:00:00Z', config: CONFIG });
  assert.notEqual(first.policy.version, second.policy.version);
  assert.equal((await readWeeklyPolicy({ homeDir })).version, second.policy.version);
  assert.equal((await restoreWeeklyPolicy({ homeDir, version: first.policy.version })).version, first.policy.version);
  assert.equal((await readWeeklyPolicy({ homeDir })).version, first.policy.version);

  const policyPath = path.join(homeDir, '.aorch', 'learning', 'policies', `policy-${first.policy.version}.json`);
  const forged = JSON.parse(await readFile(policyPath, 'utf8'));
  forged.routeGroups[0].observations[0].quality = 0.2;
  await writeFile(policyPath, JSON.stringify(forged));
  await assert.rejects(
    readWeeklyPolicy({ homeDir, version: first.policy.version }),
    /Invalid weekly policy.*does not match controller evidence/
  );

  await writeFile(policyPath, JSON.stringify(first.policy));
  const corrupt = JSON.parse(await readFile(policyPath, 'utf8'));
  corrupt.unexpected = true;
  await writeFile(policyPath, JSON.stringify(corrupt));
  await assert.rejects(readWeeklyPolicy({ homeDir, version: first.policy.version }), /Invalid weekly policy.*unexpected/);
});

test('corrupt observation sources stop evaluation instead of silently degrading to no evidence', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-corrupt-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-corrupt-home-');
  await mkdir(path.join(root, '.aorch'), { recursive: true });
  await writeFile(path.join(root, '.aorch', 'observations.jsonl'), '{bad\n');
  await assert.rejects(
    evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG }),
    /Invalid observation log/
  );
});

test('a forged duplicate cannot borrow the attestation of a different record with the same identity', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-duplicate-forgery-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-duplicate-forgery-home-');
  await seedFive(root, homeDir, () => ({evaluation:{source:'independent-gate',status:'fail'}}));
  const raw = await readFile(runEvidencePath(root),'utf8');
  const forged = raw.trim().split('\n').map(line=>({
    ...JSON.parse(line),
    execution: { status: 'complete', completed: true, durationMs: 9999, totalTokens: 9999 },
    evaluation:{source:'independent-gate',status:'pass'}
  }));
  for (const content of [forged.map(JSON.stringify).join('\n')+'\n'+raw, raw+forged.map(JSON.stringify).join('\n')+'\n']) {
    await writeFile(runEvidencePath(root),content);
    const result = await evaluateWeekly({roots:[root],homeDir,now:'2026-09-14T00:00:00Z',config:CONFIG});
    assert.equal(result.report.quality.eligibleObservations,5);
    assert.ok(policyObservations(result.policy).every(row=>row.quality===0.2));
    assert.equal(result.report.metrics.durationMs, 500);
    assert.equal(result.report.metrics.totalTokens, 50);
  }
});

test('deleting the workspace mirror cannot hide attested negative evidence', async (t) => {
  const root = await temporaryDirectory(t, 'aorch-evaluate-deleted-mirror-');
  const homeDir = await temporaryDirectory(t, 'aorch-evaluate-deleted-mirror-home-');
  await seedFive(root, homeDir, () => ({
    artifact: { status: 'fail' },
    evaluation: { source: 'independent-gate', status: 'fail' }
  }));
  await rm(runEvidencePath(root));

  const result = await evaluateWeekly({ roots: [root], homeDir, now: '2026-09-14T00:00:00Z', config: CONFIG });
  assert.equal(result.report.roots[0].sources.runEvidence, false);
  assert.equal(result.report.controllerEvidence.count, 5);
  assert.equal(result.report.metrics.attempts, 5);
  assert.equal(result.report.quality.eligibleObservations, 5);
  assert.ok(policyObservations(result.policy).every((row) => row.quality === 0.2));
});
