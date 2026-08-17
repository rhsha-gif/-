import { validateTask } from './task.js';

// The decomposition contract. The host model decomposes — aorch does not build a
// decomposer of its own — but the *shape* of that decomposition is enforced here
// rather than left to skill discipline. A recommendation the lead may quietly
// skip is not a control boundary; a validator it must pass is.

// agentRole is the axis that picks the role agent (which preset, which tools,
// which prompt). It is deliberately NOT a performance-stratification key: see
// src/performance-store.js, where role is kept as metadata but never gates
// matching, because a solo user's evidence fragments to nothing if you add axes.
const AGENT_ROLES = Object.freeze({
  worker: 'executor',
  reviewer: 'reviewer',
  fixer: 'executor',
  // The adoption roles. researcher and analyst produce evidence, so they route
  // as executors; license-reviewer and ponytail render judgements, so they
  // route as reviewers and get the reviewer's stricter candidate rules.
  // ponytail judges rather than edits — "the best code is the code you never
  // wrote" loses its point if the agent applying it starts writing — so the
  // repair it recommends belongs to a fixer task declared after it.
  researcher: 'executor',
  analyst: 'executor',
  'license-reviewer': 'reviewer',
  ponytail: 'reviewer',
  // The book-production roles. writer and editor both hold the pen, so they
  // route as executors — editor's narrower mandate (wording only, never
  // substance) lives in its preset, not in the routing axis. qa-analyst reads
  // what the QA commands already computed and renders a verdict, which is
  // reviewer work.
  writer: 'executor',
  editor: 'executor',
  'qa-analyst': 'reviewer'
});

export function routingRoleFor(agentRole) {
  const role = AGENT_ROLES[agentRole];
  if (role === undefined) {
    throw new TypeError(
      `Unsupported agentRole: ${JSON.stringify(agentRole)}. Expected one of ${Object.keys(AGENT_ROLES).join(', ')}.`
    );
  }
  return role;
}

export function agentRoles() {
  return Object.keys(AGENT_ROLES);
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

export function validateTaskPlan(input) {
  requirePlainObject(input, 'plan');

  if (typeof input.objective !== 'string' || input.objective.trim() === '') {
    throw new TypeError('plan.objective is required');
  }
  if (typeof input.decomposed !== 'boolean') {
    throw new TypeError('plan.decomposed must be boolean');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new TypeError('plan.tasks must be a non-empty array');
  }
  // decomposed:false is a positive assertion that the request runs whole. If it
  // carries several tasks the plan contradicts itself, and silently trusting
  // either half would hide which one the author meant.
  if (input.decomposed === false && input.tasks.length !== 1) {
    throw new Error('plan.decomposed is false, so plan.tasks must hold exactly one task');
  }

  const seenIds = new Set();
  const tasks = input.tasks.map((entry, index) => {
    requirePlainObject(entry, `plan.tasks[${index}]`);

    if (entry.role !== undefined) {
      throw new Error(
        `plan.tasks[${index}].role must not be set; aorch derives it from agentRole`
      );
    }
    if (typeof entry.agentRole !== 'string' || entry.agentRole.trim() === '') {
      throw new TypeError(`plan.tasks[${index}].agentRole is required`);
    }

    let role;
    try {
      role = routingRoleFor(entry.agentRole);
    } catch (error) {
      throw new TypeError(`plan.tasks[${index}]: ${error.message}`);
    }

    let task;
    try {
      task = validateTask({ ...entry, role }, { forExecution: true });
    } catch (error) {
      throw new (error.constructor ?? Error)(`plan.tasks[${index}]: ${error.message}`);
    }

    // Run directories are named by task id, so a duplicate would have one task
    // overwrite another's receipt and verification evidence.
    if (seenIds.has(task.id)) {
      throw new Error(`plan.tasks[${index}]: duplicate task id ${task.id}`);
    }
    seenIds.add(task.id);

    return { ...task, agentRole: entry.agentRole };
  });

  return {
    objective: input.objective,
    decomposed: input.decomposed,
    tasks
  };
}
