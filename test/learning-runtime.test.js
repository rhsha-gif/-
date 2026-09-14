import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeWithVerification } from '../src/run-loop.js';
import { readRunEvidence } from '../src/run-evidence.js';

const route = { provider: 'openai', profileId: 'test', model: 'gpt-test', effort: 'medium' };
test('runtime records measured gate evidence, but input waiting is unscored', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-runtime-learning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const task = { id: 'bounded', objective: 'A checked change', kind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard', write: true, allowedScope: ['answer'], acceptanceCriteria: ['passes'], verificationCommands: ['fixed check'] };
  const base = { cwd, learningHomeDir: path.join(root, 'home'), config: { learning: { enabled: true }, providers: [{ id: 'openai', adapter: 'codex' }] },
    captureGitSnapshotImpl: async () => ({ applicable: false, root: null, entries: {} }),
    evaluateChangeGuardImpl: () => ({ applicable: false, passed: true, controlPathsChanged: [] }),
    runVerificationImpl: async () => ({ passed: true, results: [{ exitCode: 0 }] }) };
  const stub = (receipt) => async ({ task }) => {
    const runDir = path.join(cwd, '.aorch/task-runs', task.runId, task.id); await mkdir(runDir, { recursive: true });
    return { route, receipt, runDir, result: { durationMs: 12, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8 } } };
  };
  await executeWithVerification({ ...base, task, executeTaskImpl: stub({ status: 'complete', filesChanged: [] }) });
  await executeWithVerification({ ...base, task: { ...task, id: 'waiting' }, executeTaskImpl: stub({ status: 'blocked', filesChanged: [], inputRequest: { kind: 'clarification', questions: [{ id: 'q', prompt: 'Required choice?' }] } }) });
  const evidence = await readRunEvidence({ root: cwd });
  const rows = Array.isArray(evidence) ? evidence : evidence.records;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].evaluation.status, 'pass');
  assert.equal(rows[0].execution.inputTokens, 10);
  assert.equal(rows[0].execution.cacheReadTokens, 8);
  assert.equal(rows[1].execution.status, 'awaiting-input');
  assert.equal(rows[1].artifact.status, 'unscored');
  assert.equal(rows[1].evaluation, undefined);
});

test('unavailable telemetry never masks a completed task or the original provider error', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-evidence-unavailable-'));
  t.after(() => rm(cwd, {recursive:true,force:true}));
  const home = path.join(cwd,'not-a-directory'); await writeFile(home,'fixture');
  const runDir = path.join(cwd,'.aorch/run'); await mkdir(runDir,{recursive:true});
  const task = {id:'telemetry',kind:'research',role:'executor',risk:'standard',complexity:'standard',write:false};
  const base = {task,cwd,learningHomeDir:home,config:{learning:{enabled:true},providers:[{id:'openai',adapter:'codex'}]},captureGitSnapshotImpl:async()=>({applicable:false}),evaluateChangeGuardImpl:()=>({applicable:false,passed:true,controlPathsChanged:[]})};
  const result = await executeWithVerification({...base,executeTaskImpl:async()=>({route,runDir,receipt:{status:'complete',filesChanged:[]}})});
  assert.equal(result.receipt.status,'complete'); assert.equal(result.learningWarnings.length,1);
  const original = Object.assign(new Error('provider unavailable'),{route,runDir,failureKind:'network'});
  await assert.rejects(executeWithVerification({...base,executeTaskImpl:async()=>{throw original;}}), error=>error===original);
});
