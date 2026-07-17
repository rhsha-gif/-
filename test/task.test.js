import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTask } from '../src/task.js';

const base = {
  id: 'T1', objective: 'Change behavior', kind: 'implementation', role: 'executor',
  risk: 'standard', write: true, allowedScope: ['src/**'], acceptanceCriteria: ['test passes'],
  verificationCommands: ['npm test'], capabilityIds: []
};

test('execution tasks require independently verifiable acceptance criteria and write scope', () => {
  assert.equal(validateTask(base, { forExecution: true }).id, 'T1');
  assert.throws(() => validateTask({ ...base, acceptanceCriteria: [] }, { forExecution: true }), /acceptance/i);
  assert.throws(() => validateTask({ ...base, allowedScope: [] }, { forExecution: true }), /scope/i);
});

test('critical tasks fail closed without explicit verification commands', () => {
  assert.throws(() => validateTask({ ...base, risk: 'critical', verificationCommands: [] }, { forExecution: true }), /verification/i);
});

test('task ids cannot escape the evidence directory', () => {
  assert.throws(() => validateTask({ ...base, id: '../escape' }, { forExecution: true }), /task.id/i);
});

test('task arrays reject empty entries that would weaken scope or verification', () => {
  assert.throws(() => validateTask({ ...base, allowedScope: [''] }, { forExecution: true }), /allowedScope/i);
  assert.throws(() => validateTask({ ...base, verificationCommands: [''] }, { forExecution: true }), /verificationCommands/i);
});

test('task-specific routing priorities and constraints are validated', () => {
  const routingTask = {
    id: 'T-routing', objective: 'Route it', kind: 'implementation', role: 'executor',
    risk: 'standard', tags: []
  };
  const validated = validateTask({
    ...routingTask,
    routingPriorities: ['latency', 'quality', 'tokens'],
    minimumQuality: 0.8,
    maxTokenIndex: 2,
    maxLatencyIndex: 3
  });
  assert.deepEqual(validated.routingPriorities, ['latency', 'quality', 'tokens']);
  assert.equal(validated.minimumQuality, 0.8);
  assert.equal(validated.maxTokenIndex, 2);
  assert.throws(() => validateTask({ ...routingTask, routingPriorities: ['latency', 'latency'] }), /routingPriorities/i);
  assert.throws(() => validateTask({ ...routingTask, routingPriorities: ['magic'] }), /routingPriorities/i);
  assert.throws(() => validateTask({ ...routingTask, minimumQuality: 1.2 }), /minimumQuality/i);
  assert.throws(() => validateTask({ ...routingTask, maxTokenIndex: 0 }), /maxTokenIndex/i);
});

test('optional task runId is path-safe because it becomes an evidence directory', () => {
  assert.equal(validateTask({ ...base, runId: 'RUN-2026.07.16' }).runId, 'RUN-2026.07.16');
  assert.throws(() => validateTask({ ...base, runId: '../escape' }), /runId/i);
  assert.throws(() => validateTask({ ...base, runId: 'nested/path' }), /runId/i);
});

test('task complexity is explicit enough to guide model and effort selection', () => {
  const standard = validateTask({ ...base });
  assert.equal(standard.complexity, 'standard');
  assert.equal(validateTask({ ...base, risk: 'low' }).complexity, 'low');
  assert.equal(validateTask({ ...base, complexity: 'high' }).complexity, 'high');
  assert.throws(() => validateTask({ ...base, complexity: 'extreme' }), /complexity/i);
  assert.throws(() => validateTask({ ...base, risk: 'critical', complexity: 'standard' }), /critical.*complexity|complexity.*critical/i);
  assert.equal(validateTask({ ...base, risk: 'critical' }).complexity, 'high');
});

test('untrusted capability opt-in must be explicit boolean', () => {
  const base = {
    id: 'T-trust', objective: 'Inspect a third-party tool', kind: 'research', role: 'executor',
    risk: 'low', write: false, acceptanceCriteria: ['Report findings'], verificationCommands: []
  };
  assert.equal(validateTask({ ...base, allowUntrustedCapabilities: true }).allowUntrustedCapabilities, true);
  assert.throws(() => validateTask({ ...base, allowUntrustedCapabilities: 'yes' }), /allowUntrustedCapabilities/i);
});

test('untrusted provider opt-in must be explicit boolean', () => {
  const base = {
    id: 'T-provider-trust', objective: 'Inspect through an experimental provider', kind: 'research', role: 'executor',
    risk: 'low', write: false, acceptanceCriteria: ['Report findings'], verificationCommands: []
  };
  assert.equal(validateTask({ ...base, allowUntrustedProviders: true }).allowUntrustedProviders, true);
  assert.throws(() => validateTask({ ...base, allowUntrustedProviders: 'yes' }), /allowUntrustedProviders/i);
});

test('in-place write authorization must be explicit boolean', () => {
  assert.equal(validateTask({ ...base, allowInPlaceWrite: true }).allowInPlaceWrite, true);
  assert.equal(validateTask({ ...base }).allowInPlaceWrite, false);
  assert.throws(() => validateTask({ ...base, allowInPlaceWrite: 'yes' }), /allowInPlaceWrite/i);
});

test('verifier-only commands are validated but remain separate from worker verification commands', () => {
  const base = {
    id: 'T-hidden', objective: 'Implement safely', kind: 'implementation', role: 'executor', risk: 'standard',
    write: true, allowedScope: ['src/**'], acceptanceCriteria: ['behavior works'],
    verificationCommands: ['npm test'], verifierCommands: ['npm run hidden-check']
  };
  const task = validateTask(base, { forExecution: true });
  assert.deepEqual(task.verifierCommands, ['npm run hidden-check']);
  assert.throws(() => validateTask({ ...base, verifierCommands: [''] }), /verifierCommands/i);
});

test('task.write must be a strict boolean', async () => {
  const { validateTask } = await import('../src/task.js');
  assert.throws(() => validateTask({
    id: 'T-write-type', kind: 'implementation', role: 'executor', risk: 'standard', write: 'yes'
  }), /write must be boolean/i);
});

test('task signatures are validated as compact routing evidence', () => {
  const task = validateTask({
    ...base,
    signature: {
      ambiguity: 'low', repositoryBreadth: 'module', editBreadth: 'few-files', contextVolume: 'medium',
      toolIntensity: 'high', stateComplexity: 'simple', testCoverage: 'partial', externalIntegration: 'read-only',
      language: 'javascript', framework: 'node'
    },
    executionLane: 'bundled', laneReason: 'one coherent low-risk feature'
  });
  assert.equal(task.signature.repositoryBreadth, 'module');
  assert.equal(task.executionLane, 'bundled');
  assert.throws(() => validateTask({ ...base, signature: { ambiguity: 'mystery' } }), /signature\.ambiguity/i);
  assert.throws(() => validateTask({ ...base, executionLane: 'distributed' }), /executionLane/i);
});

test('escalation signals are bounded strings', () => {
  assert.deepEqual(validateTask({ ...base, escalationSignals: ['scope-expanded'] }).escalationSignals, ['scope-expanded']);
  assert.throws(() => validateTask({ ...base, escalationSignals: [''] }), /escalationSignals/i);
});

test('prompt context fields are bounded structured inputs rather than raw parent transcripts', () => {
  const validated = validateTask({
    ...base,
    context: 'Only the repository facts required by this task.',
    requirements: ['Inspect before editing.'],
    invariants: ['Preserve public behavior.'],
    failureModes: ['Malformed nested input.'],
    contextFiles: ['src/parser.js']
  });
  assert.equal(validated.context, 'Only the repository facts required by this task.');
  assert.deepEqual(validated.requirements, ['Inspect before editing.']);
  assert.deepEqual(validated.contextFiles, ['src/parser.js']);
  assert.throws(() => validateTask({ ...base, context: '' }), /task\.context/i);
});

test('evidenceFiles accept exact project-relative files and reject traversal, globs, or directories', () => {
  const valid = validateTask({ ...base, evidenceFiles: ['.env', './.aorch/config.json', 'config/local.json'] });
  assert.deepEqual(valid.evidenceFiles, ['.env', '.aorch/config.json', 'config/local.json']);
  for (const value of ['../secret', '/tmp/secret', 'C:/secret', '**/*.env', 'config/*', 'folder/', '.', '']) {
    assert.throws(() => validateTask({ ...base, evidenceFiles: [value] }), /evidenceFiles/i);
  }
});

test('control-plane changes require critical isolated execution and an approved proposal reference', () => {
  const valid = validateTask({
    ...base,
    risk: 'critical', complexity: 'high', write: true,
    verificationIsolation: 'git-worktree',
    verifierCommands: ['npm run check'],
    controlPlaneChange: true,
    approval: { runId: 'R-source', proposalId: 'P1' }
  });
  assert.equal(valid.controlPlaneChange, true);
  assert.deepEqual(valid.approval, { runId: 'R-source', proposalId: 'P1' });

  const cases = [
    { risk: 'standard' },
    { verificationIsolation: 'same-workspace' },
    { verifierCommands: [] },
    { approval: undefined },
    { write: false }
  ];
  for (const patch of cases) {
    assert.throws(() => validateTask({
      ...base,
      risk: 'critical', complexity: 'high', write: true,
      verificationIsolation: 'git-worktree', verifierCommands: ['npm run check'],
      controlPlaneChange: true, approval: { runId: 'R-source', proposalId: 'P1' },
      ...patch
    }), /control-plane|approval|critical|git-worktree|hidden verifier|write/i);
  }
  assert.throws(() => validateTask({ ...base, approval: { runId: 'R1', proposalId: 'P1' } }), /only valid.*controlPlaneChange/i);
});


test('single-worker is the lowest execution lane and legacy direct is rejected', () => {
  const single = validateTask({ ...base, executionLane: 'single-worker' });
  assert.equal(single.executionLane, 'single-worker');
  assert.throws(() => validateTask({ ...base, executionLane: 'direct' }), /direct.*single-worker|single-worker.*direct/i);
});
