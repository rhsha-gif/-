import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './verifier.js';

const ATTESTATION_STATUSES = new Set(['pass', 'fail', 'inconclusive']);

async function resolveReal(candidate) {
  try { return await realpath(candidate); }
  catch { return path.resolve(candidate); }
}

// A worker receipt is a claim; this loader is the only path by which a claim
// becomes completion evidence. It re-reads the attestation from disk and
// re-verifies its digest and identity binding on every use, so a moved,
// edited, or recycled attestation cannot complete a task.
export async function loadAndValidateAttestation(filePath, { taskId, runId, stateRoot } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('attestation path is required');
  }
  const resolved = await resolveReal(filePath);
  if (stateRoot) {
    const relative = path.relative(await resolveReal(stateRoot), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`attestation is outside the state root: ${resolved}`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`attestation unreadable at ${resolved}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('attestation must be an object');
  }
  if (![1, 2].includes(parsed.schemaVersion)) {
    throw new Error(`unsupported attestation schemaVersion: ${parsed.schemaVersion}`);
  }
  if (!ATTESTATION_STATUSES.has(parsed.status)) {
    throw new Error(`attestation status must be pass, fail, or inconclusive; got ${parsed.status}`);
  }
  const { evidenceDigest, path: _ignoredPath, ...rest } = parsed;
  if (typeof evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceDigest)) {
    throw new Error('attestation is missing its evidenceDigest');
  }
  if (sha256(rest) !== evidenceDigest) {
    throw new Error('attestation digest mismatch: content does not match its recorded evidenceDigest');
  }
  if (taskId !== undefined && parsed.taskId !== taskId) {
    throw new Error(`attestation taskId ${parsed.taskId} does not match ${taskId}`);
  }
  if (runId !== undefined && parsed.runId !== null && parsed.runId !== runId) {
    throw new Error(`attestation runId ${parsed.runId} does not match ${runId}`);
  }
  return { ...parsed, path: resolved };
}

export function assertPassingAttestation(attestation) {
  if (attestation.status !== 'pass') {
    throw new Error(`attestation status is ${attestation.status}; completion requires status pass`);
  }
  return attestation;
}
