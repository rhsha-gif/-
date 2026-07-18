import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, withFileLock } from './file-store.js';
import { assertPassingAttestation, loadAndValidateAttestation } from './attestation.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled']);
const TASK_STATUSES = new Set([
  'pending', 'ready', 'running', 'verifying',
  'complete', 'accepted', 'done', 'blocked', 'failed', 'cancelled', 'skipped'
]);
const SUCCESS_TASK_STATUSES = new Set(['complete', 'accepted', 'done', 'skipped']);
// Success statuses that assert real work happened. Only a passing attestation
// bound to this task and run may record them; 'skipped' asserts the opposite
// and is exempt.
const EVIDENCE_REQUIRED_STATUSES = new Set(['complete', 'accepted', 'done']);
const ACTIVE_RUN_FILE = 'active-run.json';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function resolveReal(candidate) {
  try { return await realpath(candidate); }
  catch { return path.resolve(candidate); }
}

// Compare realpaths so a pointer written via a symlinked project alias is not
// misjudged as escaping the state root when inspected via the physical path.
async function assertInsideRoot(root, candidate) {
  const resolvedRoot = await resolveReal(root);
  const resolved = await resolveReal(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Run path is outside state root: ${resolved}`);
  }
  return resolved;
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error('runId must be a path-safe non-empty identifier');
  }
  return runId;
}

function normalizeFraction(value, name = 'task fraction') {
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return fraction;
}

function normalizeTask(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError(`run task ${index + 1} must be an object`);
  }
  if (typeof task.id !== 'string' || task.id.trim() === '') {
    throw new TypeError(`run task ${index + 1} requires a non-empty id`);
  }
  const status = task.status ?? 'pending';
  if (!TASK_STATUSES.has(status)) throw new Error(`Unsupported task status: ${status}`);
  if (EVIDENCE_REQUIRED_STATUSES.has(status)) {
    throw new Error(`Task ${task.id} cannot be created as ${status}: completion requires a passing attestation recorded through a task update`);
  }
  const weight = Number(task.weight ?? 1);
  if (!Number.isFinite(weight) || weight <= 0) throw new RangeError(`Task ${task.id} weight must be positive`);
  const fraction = task.fraction === undefined
    ? (SUCCESS_TASK_STATUSES.has(status) || ['cancelled', 'skipped'].includes(status) ? 1 : 0)
    : normalizeFraction(task.fraction, `Task ${task.id} fraction`);
  return { ...task, id: task.id.trim(), weight, status, fraction };
}

export function activeRunPointerPath(root) {
  return path.join(root, ACTIVE_RUN_FILE);
}

export async function createRun({ root, prompt, tasks = [], runId = randomUUID(), activate = true, maxTasks = 24 }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('run prompt is required');
  if (!Array.isArray(tasks)) throw new TypeError('run tasks must be an array');
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 100) throw new RangeError('run task budget must be an integer from 1 to 100');
  if (tasks.length > maxTasks) throw new Error(`Run exceeds task budget: ${tasks.length} tasks; maximum is ${maxTasks}`);
  assertRunId(runId);

  const create = async () => {
    if (activate) {
      const active = await resolveActiveRun(root);
      if (active?.status === 'running') {
        throw new Error(`Active run ${active.id} is still running; resume or finish it before starting another run`);
      }
      if (active && active.reviewStatus !== 'complete') {
        throw new Error(`Active run ${active.id} requires post-run reflection before starting another run`);
      }
    }

    const normalizedTasks = tasks.map(normalizeTask);
    const taskIds = new Set();
    for (const task of normalizedTasks) {
      if (taskIds.has(task.id)) throw new Error(`Duplicate run task id: ${task.id}`);
      taskIds.add(task.id);
    }

    const runDir = path.join(root, 'runs', runId);
    const runPath = path.join(runDir, 'run.json');
    const state = await withFileLock(`${runPath}.lock`, async () => {
      if (await exists(runPath)) throw new Error(`Run already exists: ${runId}`);
      const now = new Date().toISOString();
      const next = {
        version: 1,
        id: runId,
        prompt: prompt.trim(),
        status: 'running',
        reviewStatus: 'not-ready',
        createdAt: now,
        updatedAt: now,
        tasks: normalizedTasks,
        events: []
      };
      await atomicWriteJson(runPath, next);
      return next;
    });
    if (activate) await atomicWriteJson(activeRunPointerPath(root), { runPath: path.resolve(runPath), runId });
    return { ...state, path: path.resolve(runPath), dir: path.resolve(runDir) };
  };

  return activate
    ? withFileLock(`${activeRunPointerPath(root)}.lock`, create)
    : create();
}

export async function loadRun(runPath) {
  return JSON.parse(await readFile(runPath, 'utf8'));
}

// Note: there is intentionally no blind load->save API; all writes go through
// mutateRun, which re-reads under the lock so concurrent updates cannot be
// clobbered by a stale caller-held snapshot.
async function mutateRun(runPath, updater) {
  return withFileLock(`${runPath}.lock`, async () => {
    const state = await loadRun(runPath);
    const updated = await updater(state);
    const next = { ...updated, updatedAt: new Date().toISOString() };
    await atomicWriteJson(runPath, next);
    return next;
  });
}

export async function resolveActiveRun(root) {
  const pointerPath = activeRunPointerPath(root);
  if (!(await exists(pointerPath))) return null;
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  if (typeof pointer.runPath !== 'string' || pointer.runPath.trim() === '') {
    throw new Error('Active run pointer is invalid');
  }
  const runPath = await assertInsideRoot(root, pointer.runPath);
  const state = await loadRun(runPath);
  return { ...state, path: runPath, dir: path.dirname(runPath) };
}

const PATCHABLE_TASK_FIELDS = new Set([
  'status', 'fraction', 'note', 'blocker', 'evidence', 'evidenceCount', 'lastEvidenceAt', 'progressConfidence',
  'attestationPath'
]);

// The state root is the ancestor of root/runs/<id>/run.json; attestations must
// live inside it so completion evidence cannot point at arbitrary files.
function stateRootOfRunPath(runPath) {
  return path.resolve(path.dirname(runPath), '..', '..');
}

export async function updateTaskState(runPath, taskId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('task patch must be an object');
  const unknown = Object.keys(patch).filter((field) => !PATCHABLE_TASK_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new TypeError(`task patch cannot modify: ${unknown.join(', ')}`);
  }
  return mutateRun(runPath, async (state) => {
    if (state.status !== 'running') throw new Error(`Cannot update tasks in terminal run ${state.id}`);
    const index = state.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Unknown task: ${taskId}`);

    const current = state.tasks[index];
    const status = patch.status ?? current.status;
    if (!TASK_STATUSES.has(status)) throw new Error(`Unsupported task status: ${status}`);
    let fraction = patch.fraction === undefined ? current.fraction : normalizeFraction(patch.fraction);
    if (SUCCESS_TASK_STATUSES.has(status) || ['cancelled', 'skipped'].includes(status)) fraction = 1;

    let attestationFields = {};
    if (EVIDENCE_REQUIRED_STATUSES.has(status)) {
      const attestationPath = patch.attestationPath ?? current.attestationPath;
      if (typeof attestationPath !== 'string' || attestationPath.trim() === '') {
        throw new Error(`Task ${taskId} cannot be recorded as ${status} without a passing attestation (provide attestationPath)`);
      }
      const attestation = assertPassingAttestation(await loadAndValidateAttestation(attestationPath, {
        taskId,
        runId: state.id,
        stateRoot: stateRootOfRunPath(runPath)
      }));
      attestationFields = {
        attestationPath: attestation.path,
        attestationDigest: attestation.evidenceDigest,
        attestationVerifiedAt: new Date().toISOString()
      };
    }

    state.tasks[index] = {
      ...current,
      ...patch,
      ...attestationFields,
      status,
      fraction,
      updatedAt: new Date().toISOString()
    };
    return state;
  });
}

export async function finishRun(runPath, status) {
  if (!TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error(`Unsupported terminal run status: ${status}`);
  }
  return mutateRun(runPath, async (state) => {
    if (status === 'completed') {
      const unfinished = state.tasks.filter((task) => !SUCCESS_TASK_STATUSES.has(task.status));
      if (unfinished.length > 0) {
        throw new Error(`Cannot complete run with unfinished tasks: ${unfinished.map((task) => task.id).join(', ')}`);
      }
      for (const task of state.tasks) {
        if (task.status === 'skipped') continue;
        if (typeof task.attestationPath !== 'string' || typeof task.attestationDigest !== 'string') {
          throw new Error(`Cannot complete run: task ${task.id} has no validated attestation metadata`);
        }
        const attestation = assertPassingAttestation(await loadAndValidateAttestation(task.attestationPath, {
          taskId: task.id,
          runId: state.id,
          stateRoot: stateRootOfRunPath(runPath)
        }));
        if (attestation.evidenceDigest !== task.attestationDigest) {
          throw new Error(`Cannot complete run: task ${task.id} attestation digest changed since it was recorded`);
        }
      }
    }
    const now = new Date().toISOString();
    return { ...state, status, reviewStatus: 'pending', finishedAt: now };
  });
}

export async function markRunReviewed(runPath, reflectionPath) {
  return mutateRun(runPath, (state) => {
    if (!TERMINAL_RUN_STATUSES.has(state.status)) {
      throw new Error('A running orchestration cannot be marked reviewed');
    }
    return {
      ...state,
      reviewStatus: 'complete',
      reflectionPath: path.resolve(reflectionPath),
      reviewedAt: new Date().toISOString()
    };
  });
}

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

export { TASK_STATUSES, TERMINAL_RUN_STATUSES };
