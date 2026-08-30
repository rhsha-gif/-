import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRoles, routingRoleFor, validateTaskPlan } from '../src/decompose.js';

const task = {
  id: 'T1', objective: 'Implement the parser', kind: 'implementation', agentRole: 'worker',
  risk: 'standard', write: true, allowedScope: ['src/**'], acceptanceCriteria: ['tests pass'],
  verificationCommands: ['npm test']
};

const plan = { objective: 'Build the parser', decomposed: true, tasks: [task] };

test('a well-formed plan validates and carries agentRole through', () => {
  const result = validateTaskPlan(plan);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].agentRole, 'worker');
  assert.equal(result.tasks[0].role, 'executor');
  assert.equal(result.objective, 'Build the parser');
});

test('agentRole maps onto the routing roles the router already filters on', () => {
  assert.equal(agentRoles().length, 13);
  assert.equal(routingRoleFor('worker'), 'executor');
  assert.equal(routingRoleFor('paper-researcher'), 'executor');
  assert.equal(routingRoleFor('fixer'), 'executor');
  assert.equal(routingRoleFor('reviewer'), 'reviewer');
  assert.throws(() => routingRoleFor('scout'), /agentRole/i);
  assert.throws(() => routingRoleFor(undefined), /agentRole/i);
});

test('a task must declare agentRole and must not declare role by hand', () => {
  assert.throws(() => validateTaskPlan({ ...plan, tasks: [{ ...task, agentRole: undefined }] }), /agentRole/i);
  assert.throws(() => validateTaskPlan({ ...plan, tasks: [{ ...task, agentRole: 'planner' }] }), /agentRole/i);
  assert.throws(() => validateTaskPlan({ ...plan, tasks: [{ ...task, role: 'executor' }] }), /role must not be set/i);
});

test('duplicate task ids are rejected because run directories are named by id', () => {
  const tasks = [task, { ...task, objective: 'Something else' }];
  assert.throws(() => validateTaskPlan({ ...plan, tasks }), /duplicate task id T1/);
});

test('decomposed:false asserts a single task and contradicting itself fails', () => {
  const single = validateTaskPlan({ ...plan, decomposed: false });
  assert.equal(single.tasks.length, 1);
  const tasks = [task, { ...task, id: 'T2' }];
  assert.throws(() => validateTaskPlan({ objective: 'x', decomposed: false, tasks }), /exactly one task/i);
  // The same two tasks are fine once the plan admits it decomposed.
  assert.equal(validateTaskPlan({ objective: 'x', decomposed: true, tasks }).tasks.length, 2);
});

test('plan-level fields are required', () => {
  assert.throws(() => validateTaskPlan(null), /plan must be an object/i);
  assert.throws(() => validateTaskPlan([]), /plan must be an object/i);
  assert.throws(() => validateTaskPlan({ ...plan, objective: '  ' }), /plan.objective/i);
  assert.throws(() => validateTaskPlan({ ...plan, decomposed: 'yes' }), /plan.decomposed/i);
  assert.throws(() => validateTaskPlan({ ...plan, tasks: [] }), /plan.tasks/i);
});

test('task-level validation failures name the offending index', () => {
  const tasks = [task, { ...task, id: 'T2', acceptanceCriteria: [] }];
  assert.throws(() => validateTaskPlan({ ...plan, tasks }), /plan\.tasks\[1\].*acceptance/is);
  const escaping = [{ ...task, id: '../escape' }];
  assert.throws(() => validateTaskPlan({ ...plan, tasks: escaping }), /plan\.tasks\[0\].*task\.id/is);
});

test('the adoption roles derive routing roles that the profiles already declare', () => {
  assert.deepEqual(agentRoles(), [
    'worker', 'reviewer', 'fixer', 'researcher', 'analyst', 'license-reviewer', 'ponytail',
    'writer', 'editor', 'qa-analyst', 'invest-analyst', 'refactorer', 'paper-researcher'
  ]);

  // Evidence-producing roles route as executors; judging roles route as
  // reviewers, which is also what earns them the reviewer-only exemption the
  // router applies to challenger models on critical work.
  assert.equal(routingRoleFor('researcher'), 'executor');
  assert.equal(routingRoleFor('analyst'), 'executor');
  assert.equal(routingRoleFor('license-reviewer'), 'reviewer');
  // ponytail judges rather than edits; the repair it recommends is a separate
  // fixer task declared after it.
  assert.equal(routingRoleFor('ponytail'), 'reviewer');

  // Book-production roles: both pen-holders route as executors; the judge of
  // machine-computed QA output routes as a reviewer.
  assert.equal(routingRoleFor('writer'), 'executor');
  assert.equal(routingRoleFor('editor'), 'executor');
  assert.equal(routingRoleFor('qa-analyst'), 'reviewer');

  // invest-analyst judges gathered evidence; refactorer holds the pen for
  // behavior-preserving work only.
  assert.equal(routingRoleFor('invest-analyst'), 'reviewer');
  assert.equal(routingRoleFor('refactorer'), 'executor');

  const plan = {
    objective: 'Adopt something',
    decomposed: true,
    tasks: ['researcher', 'analyst', 'license-reviewer', 'ponytail'].map((agentRole, i) => ({
      id: `T${i}`, objective: 'do it', kind: 'research', risk: 'standard',
      write: false, acceptanceCriteria: ['evidence recorded'], agentRole
    }))
  };
  const result = validateTaskPlan(plan);
  assert.deepEqual(result.tasks.map((t) => t.role), ['executor', 'executor', 'reviewer', 'reviewer']);
});
