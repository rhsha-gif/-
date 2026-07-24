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

test('in-place write authorization must be explicit boolean', () => {
  assert.equal(validateTask({ ...base, allowInPlaceWrite: true }).allowInPlaceWrite, true);
  assert.equal(validateTask({ ...base }).allowInPlaceWrite, false);
  assert.throws(() => validateTask({ ...base, allowInPlaceWrite: 'yes' }), /allowInPlaceWrite/i);
});

test('verification commands are validated as a string array', () => {
  const base = {
    id: 'T-verify', objective: 'Implement safely', kind: 'implementation', role: 'executor', risk: 'standard',
    write: true, allowedScope: ['src/**'], acceptanceCriteria: ['behavior works'],
    verificationCommands: ['npm test']
  };
  const task = validateTask(base, { forExecution: true });
  assert.deepEqual(task.verificationCommands, ['npm test']);
  assert.throws(() => validateTask({ ...base, verificationCommands: [''] }), /verificationCommands/i);
});

test('task.write must be a strict boolean', async () => {
  const { validateTask } = await import('../src/task.js');
  assert.throws(() => validateTask({
    id: 'T-write-type', kind: 'implementation', role: 'executor', risk: 'standard', write: 'yes'
  }), /write must be boolean/i);
});
