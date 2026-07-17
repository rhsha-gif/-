import path from 'node:path';
import {
  loadRetrospective,
  markProposalApplied,
  releaseProposalReservation,
  reserveProposal
} from './learning.js';

function safeId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${field} must be a path-safe identifier`);
  }
  return value;
}

function normalizeProjectPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const normalized = normalizeProjectPath(pattern);
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        // A leading `**/` matches zero or more path segments, so `**/x` must
        // also match a top-level `x`; make the following slash optional.
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function matchesScope(filePath, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizeProjectPath(filePath)));
}

export function taskMayTouchProtectedFiles({ task, protectedFiles = [] }) {
  if (task?.write !== true || protectedFiles.length === 0) return false;
  return protectedFiles.some((filePath) => matchesScope(filePath, task.allowedScope ?? [])
    && !matchesScope(filePath, task.forbiddenScope ?? []));
}

export function configuredProtectedFiles({ config, cwd, stateRoot }) {
  const values = [...(config.controlPlane?.protectedFiles ?? [])];
  for (const candidate of [
    config._configPath,
    path.join(stateRoot, 'config.json'),
    // Route observations and lesson memory steer future routing and prompts.
    // Their hash chains only detect corruption, not well-formed unauthorized
    // appends, so a worker able to write them could poison routing evidence
    // undetected; treat them as protected change surfaces like config/hooks.
    path.resolve(cwd, config.paths?.observationsFile ?? path.join(stateRoot, 'observations.jsonl')),
    path.join(stateRoot, 'learning', 'lessons.json')
  ].filter(Boolean)) {
    const relative = normalizeProjectPath(path.relative(cwd, path.resolve(candidate)));
    if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)) values.push(relative);
  }
  return [...new Set(values.map(normalizeProjectPath))].sort();
}

export async function requireApprovedControlPlaneChange({ root, task }) {
  if (task.controlPlaneChange !== true) return null;
  const runId = safeId(task.approval?.runId, 'task.approval.runId');
  const proposalId = safeId(task.approval?.proposalId, 'task.approval.proposalId');
  const retrospective = await loadRetrospective({ root, runId });
  const proposal = retrospective.proposals?.find((entry) => entry.id === proposalId);
  if (!proposal) throw new Error(`Control-plane proposal not found: ${runId}/${proposalId}`);
  if (proposal.status !== 'approved') throw new Error(`Control-plane proposal is not approved: ${runId}/${proposalId}`);
  if (proposal.applied === true) throw new Error(`Control-plane proposal was already applied: ${runId}/${proposalId}`);
  return { runId, proposalId, proposal };
}

export async function reserveControlPlaneApproval({ root, task }) {
  const preview = await requireApprovedControlPlaneChange({ root, task });
  if (!preview) return null;
  const proposal = await reserveProposal({
    root,
    runId: preview.runId,
    proposalId: preview.proposalId,
    taskId: task.id
  });
  return { ...preview, proposal };
}

export function assertProtectedChangePolicy({ task, changedPaths, protectedFiles, approval }) {
  const normalizedChanged = [...new Set(changedPaths.map(normalizeProjectPath))].sort();
  const protectedSet = new Set(protectedFiles.map(normalizeProjectPath));
  const protectedChanged = normalizedChanged.filter((entry) => protectedSet.has(entry));
  if (task.controlPlaneChange !== true) {
    if (protectedChanged.length > 0) {
      throw new Error(`Worker changed protected control-plane files without approved change authority: ${protectedChanged.join(', ')}`);
    }
    return { protectedChanged: [] };
  }
  if (!approval) throw new Error('Control-plane change requires an approved proposal');
  const approvedFiles = new Set((approval.proposal.affectedFiles ?? []).map(normalizeProjectPath));
  const unapproved = normalizedChanged.filter((entry) => !approvedFiles.has(entry));
  if (unapproved.length > 0) {
    throw new Error(`Control-plane change exceeds approved proposal files: ${unapproved.join(', ')}`);
  }
  return { protectedChanged };
}

export async function consumeControlPlaneApproval({ root, approval, taskId, evidence }) {
  if (!approval) return null;
  return markProposalApplied({
    root,
    runId: approval.runId,
    proposalId: approval.proposalId,
    taskId,
    evidence
  });
}

export async function releaseControlPlaneApproval({ root, approval, taskId }) {
  if (!approval) return null;
  return releaseProposalReservation({
    root,
    runId: approval.runId,
    proposalId: approval.proposalId,
    taskId
  });
}
