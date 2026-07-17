import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isTerminalRunStatus, loadRun, markRunReviewed } from './state.js';
import { atomicWriteJson, withFileLock } from './file-store.js';

const OUTCOMES = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled']);
const PROPOSAL_CATEGORIES = new Set([
  'error-prevention',
  'efficiency',
  'technical-debt',
  'routing',
  'capability',
  'documentation'
]);
const PROPOSAL_DECISIONS = new Set(['approved', 'rejected']);
const LESSON_TTL_DAYS = 90;

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function stringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function objectArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new TypeError(`${name} must be an array of objects`);
  }
  return value;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function normalizeError(entry) {
  const evidence = stringArray(entry.evidence, 'error.evidence');
  const tags = uniqueStrings(stringArray(entry.tags, 'error.tags'));
  if (evidence.length === 0) throw new TypeError('error.evidence must contain at least one verified reference');
  if (tags.length === 0) throw new TypeError('error.tags must contain at least one relevance tag');
  const confidence = Number(entry.confidence ?? 0.8);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError('error.confidence must be between 0 and 1');
  }
  return {
    id: nonEmptyString(entry.id, 'error.id'),
    description: nonEmptyString(entry.description, 'error.description'),
    evidence,
    prevention: nonEmptyString(entry.prevention, 'error.prevention'),
    tags,
    confidence
  };
}

function normalizeInefficiency(entry) {
  return {
    id: nonEmptyString(entry.id, 'inefficiency.id'),
    description: nonEmptyString(entry.description, 'inefficiency.description'),
    evidence: stringArray(entry.evidence, 'inefficiency.evidence'),
    proposedChange: nonEmptyString(entry.proposedChange, 'inefficiency.proposedChange')
  };
}

function normalizeDebt(entry) {
  if (!['harness', 'project'].includes(entry.scope)) throw new Error(`Unsupported technical debt scope: ${entry.scope}`);
  if (typeof entry.introducedByRun !== 'boolean') throw new TypeError('technicalDebt.introducedByRun must be boolean');
  const status = entry.status ?? 'pending';
  if (!['pending', 'resolved'].includes(status)) throw new Error(`Unsupported technical debt status: ${status}`);
  const resolutionEvidence = stringArray(entry.resolutionEvidence, 'technicalDebt.resolutionEvidence');
  if (entry.introducedByRun && (status !== 'resolved' || resolutionEvidence.length === 0)) {
    throw new Error('Technical debt introduced by the run must be resolved with evidence before closing');
  }
  return {
    id: nonEmptyString(entry.id, 'technicalDebt.id'),
    description: nonEmptyString(entry.description, 'technicalDebt.description'),
    scope: entry.scope,
    introducedByRun: entry.introducedByRun,
    status,
    resolutionEvidence,
    recommendedAction: nonEmptyString(entry.recommendedAction, 'technicalDebt.recommendedAction')
  };
}

function normalizeProposal(entry, existing) {
  if (!PROPOSAL_CATEGORIES.has(entry.category)) throw new Error(`Unsupported proposal category: ${entry.category}`);
  if (entry.applied === true) throw new Error('A retrospective cannot mark a proposal applied automatically');
  const candidate = {
    id: nonEmptyString(entry.id, 'proposal.id'),
    category: entry.category,
    title: nonEmptyString(entry.title, 'proposal.title'),
    rationale: nonEmptyString(entry.rationale, 'proposal.rationale'),
    expectedBenefit: nonEmptyString(entry.expectedBenefit, 'proposal.expectedBenefit'),
    risks: stringArray(entry.risks, 'proposal.risks'),
    affectedFiles: stringArray(entry.affectedFiles, 'proposal.affectedFiles'),
    requiresUserApproval: true
  };
  if (existing && existing.status !== 'pending') {
    for (const field of ['category', 'title', 'rationale', 'expectedBenefit', 'risks', 'affectedFiles']) {
      if (JSON.stringify(candidate[field]) !== JSON.stringify(existing[field])) {
        throw new Error(`Decided proposal ${candidate.id} cannot be changed; ${field} is immutable after decision`);
      }
    }
    return { ...existing };
  }
  return { ...candidate, status: existing?.status ?? 'pending', applied: false };
}

function mergeById(previousEntries, inputEntries, normalize, name) {
  const merged = new Map();
  for (const entry of previousEntries ?? []) merged.set(entry.id, entry);
  for (const entry of objectArray(inputEntries, name)) {
    const normalized = normalize(entry, merged.get(entry.id));
    merged.set(normalized.id, normalized);
  }
  return [...merged.values()];
}

function lessonFingerprint(prevention) {
  return createHash('sha256').update(prevention.trim().toLowerCase()).digest('hex').slice(0, 20);
}

function lessonIndexPath(root) {
  return path.join(root, 'learning', 'lessons.json');
}

function tokenize(value) {
  return (String(value).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])
    .filter((token) => token.length >= 2);
}

function lessonExpiry(now, ttlDays = LESSON_TTL_DAYS) {
  return new Date(new Date(now).getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function lessonIssues(lesson, now = new Date()) {
  const issues = [];
  const id = typeof lesson?.id === 'string' && lesson.id ? lesson.id : '(unknown)';
  const push = (code, message) => issues.push({ lessonId: id, code, message });
  if (!['negative', 'positive'].includes(lesson?.type)) push('type', 'lesson.type must be negative or positive');
  if (lesson?.status !== 'advisory') push('status', 'lesson.status must remain advisory');
  if (!Array.isArray(lesson?.scopeTags) || lesson.scopeTags.length === 0) push('scope-tags', 'lesson.scopeTags must contain at least one scope tag');
  if (!Array.isArray(lesson?.evidence) || lesson.evidence.length === 0) push('evidence', 'lesson.evidence must contain at least one reference');
  if (!Number.isFinite(Number(lesson?.confidence)) || Number(lesson.confidence) < 0 || Number(lesson.confidence) > 1) {
    push('confidence', 'lesson.confidence must be between 0 and 1');
  }
  if (!Array.isArray(lesson?.sourceRunIds) || lesson.sourceRunIds.length === 0) push('source-runs', 'lesson.sourceRunIds must not be empty');
  if (typeof lesson?.expiresAt !== 'string' || !Number.isFinite(Date.parse(lesson.expiresAt))) {
    push('expiry', 'lesson.expiresAt must be a valid timestamp');
  } else if (Date.parse(lesson.expiresAt) <= new Date(now).getTime()) {
    push('expired', 'lesson has expired and must be reviewed before reuse');
  }
  if (lesson?.promotedToPolicy !== false) push('policy-boundary', 'operational lessons cannot silently become policy');
  if (typeof lesson?.description !== 'string' || lesson.description.trim() === '') push('description', 'lesson.description is required');
  if (typeof lesson?.prevention !== 'string' || lesson.prevention.trim() === '') push('prevention', 'lesson.prevention is required');
  return issues;
}

async function updateLessons({ root, runId, errors, now }) {
  if (errors.length === 0) return;
  const filePath = lessonIndexPath(root);
  await withFileLock(`${filePath}.lock`, async () => {
    const index = await exists(filePath)
      ? JSON.parse(await readFile(filePath, 'utf8'))
      : { version: 2, lessons: [] };
    const lessons = new Map((index.lessons ?? []).map((lesson) => [lesson.id, lesson]));

    for (const error of errors) {
      if (!Array.isArray(error.tags) || error.tags.length === 0 || !Array.isArray(error.evidence) || error.evidence.length === 0) continue;
      const id = lessonFingerprint(error.prevention);
      const current = lessons.get(id);
      const sourceRunIds = uniqueStrings([...(current?.sourceRunIds ?? []), runId]);
      // Track the raw evidence confidence separately so the occurrence bonus
      // is derived idempotently: compounding it into the stored confidence
      // inflated lessons quadratically and on every retrospective revision.
      const evidenceConfidence = Math.max(
        Number(current?.evidenceConfidence ?? 0),
        error.confidence
      );
      lessons.set(id, {
        id,
        type: 'negative',
        status: 'advisory',
        description: error.description,
        prevention: error.prevention,
        scopeTags: uniqueStrings([...(current?.scopeTags ?? current?.tags ?? []), ...error.tags]),
        evidence: uniqueStrings([...(current?.evidence ?? []), ...error.evidence]),
        evidenceConfidence,
        confidence: Math.min(0.99, evidenceConfidence + Math.max(0, sourceRunIds.length - 1) * 0.02),
        occurrences: sourceRunIds.length,
        sourceRunIds,
        counterexamples: Array.isArray(current?.counterexamples) ? current.counterexamples : [],
        promotedToPolicy: false,
        createdAt: current?.createdAt ?? now,
        lastSeenAt: now,
        expiresAt: lessonExpiry(now)
      });
    }

    await atomicWriteJson(filePath, {
      version: 2,
      updatedAt: now,
      lessons: [...lessons.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    });
  });
}


export function retrospectivePath(root, runId) {
  nonEmptyString(runId, 'runId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('runId must be path-safe');
  return path.join(root, 'learning', 'retrospectives', `${runId}.json`);
}

export async function loadRetrospective({ root, runId }) {
  const filePath = retrospectivePath(root, runId);
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  return { ...value, path: filePath };
}

export async function lintLessons({ root, now = new Date() } = {}) {
  const filePath = lessonIndexPath(root);
  if (!(await exists(filePath))) return { status: 'pass', total: 0, valid: 0, issues: [] };

  let index;
  try {
    index = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    return {
      status: 'fail',
      version: null,
      total: 0,
      valid: 0,
      issues: [{
        lessonId: null,
        code: 'invalid-json',
        message: error instanceof Error ? error.message : String(error),
        path: filePath
      }]
    };
  }

  const issues = (index.lessons ?? []).flatMap((lesson) => lessonIssues(lesson, now));
  const invalidIds = new Set(issues.map((issue) => issue.lessonId));
  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    version: index.version ?? null,
    total: (index.lessons ?? []).length,
    valid: (index.lessons ?? []).length - invalidIds.size,
    issues
  };
}

export async function loadLessons({ root, query = '', limit = 10, now = new Date() } = {}) {
  const filePath = lessonIndexPath(root);
  if (!(await exists(filePath))) return [];
  const index = JSON.parse(await readFile(filePath, 'utf8'));
  const requestedLimit = Number(limit);
  const normalizedLimit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(50, requestedLimit)) : 10;
  const queryTokens = new Set(tokenize(query));

  return (index.lessons ?? [])
    .filter((lesson) => lessonIssues(lesson, now).length === 0)
    .map((lesson) => {
      if (queryTokens.size === 0) return { lesson, score: 0 };
      const tagTokens = new Set((lesson.scopeTags ?? []).flatMap(tokenize));
      const bodyTokens = new Set(tokenize(`${lesson.description} ${lesson.prevention}`));
      let score = 0;
      for (const token of queryTokens) {
        if (tagTokens.has(token)) score += 3;
        else if (bodyTokens.has(token)) score += 1;
      }
      return { lesson, score };
    })
    .filter(({ score }) => queryTokens.size === 0 || score > 0)
    .sort((a, b) => b.score - a.score
      || Number(b.lesson.confidence ?? 0) - Number(a.lesson.confidence ?? 0)
      || Number(b.lesson.occurrences ?? 0) - Number(a.lesson.occurrences ?? 0)
      || String(b.lesson.lastSeenAt ?? '').localeCompare(String(a.lesson.lastSeenAt ?? '')))
    .slice(0, normalizedLimit)
    .map(({ lesson }) => ({ ...lesson, advisory: true }));
}


export async function saveRetrospective({ root, runPath, input }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('retrospective input must be an object');
  const run = await loadRun(runPath);
  if (!isTerminalRunStatus(run.status)) throw new Error('A retrospective requires a terminal run');
  const inputRunId = input.runId ?? run.id;
  if (inputRunId !== run.id) throw new Error(`Retrospective runId ${inputRunId} does not match run ${run.id}`);
  if (!OUTCOMES.has(input.outcome)) throw new Error(`Unsupported retrospective outcome: ${input.outcome}`);
  if (input.outcome !== run.status) throw new Error(`Retrospective outcome ${input.outcome} does not match run status ${run.status}`);

  const filePath = retrospectivePath(root, run.id);
  const value = await withFileLock(`${filePath}.lock`, async () => {
    const previous = await exists(filePath) ? JSON.parse(await readFile(filePath, 'utf8')) : null;
    const errors = mergeById(previous?.errors, input.errors, normalizeError, 'errors');
    const inefficiencies = mergeById(previous?.inefficiencies, input.inefficiencies, normalizeInefficiency, 'inefficiencies');
    const technicalDebt = mergeById(previous?.technicalDebt, input.technicalDebt, normalizeDebt, 'technicalDebt');
    const proposals = mergeById(previous?.proposals, input.proposals, normalizeProposal, 'proposals');
    const now = new Date().toISOString();
    const next = {
      version: 1,
      runId: run.id,
      outcome: input.outcome,
      summary: nonEmptyString(input.summary, 'summary'),
      whatWorked: uniqueStrings([...(previous?.whatWorked ?? []), ...stringArray(input.whatWorked, 'whatWorked')]),
      errors,
      inefficiencies,
      technicalDebt,
      proposals,
      userFeedback: previous?.userFeedback ?? [],
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    await atomicWriteJson(filePath, next);
    return next;
  });
  const reviewedErrors = objectArray(input.errors, 'errors').map(normalizeError);
  await updateLessons({ root, runId: run.id, errors: reviewedErrors, now: value.updatedAt });
  await markRunReviewed(runPath, filePath);
  return { ...value, path: filePath };
}

export async function appendUserFeedback({ root, runId, feedback }) {
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) throw new TypeError('feedback must be an object');
  const filePath = retrospectivePath(root, runId);
  const value = await withFileLock(`${filePath}.lock`, async () => {
    const current = JSON.parse(await readFile(filePath, 'utf8'));
    const rating = feedback.rating === undefined ? null : Number(feedback.rating);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new RangeError('feedback.rating must be an integer from 1 to 5');
    }
    const entry = {
      rating,
      comment: nonEmptyString(feedback.comment, 'feedback.comment'),
      recordedAt: feedback.recordedAt ?? new Date().toISOString()
    };
    current.userFeedback ??= [];
    current.userFeedback.push(entry);
    current.updatedAt = new Date().toISOString();
    await atomicWriteJson(filePath, current);
    return current;
  });
  return { ...value, path: filePath };
}

async function mutateProposal({ root, runId, proposalId, callback }) {
  const filePath = retrospectivePath(root, runId);
  return withFileLock(`${filePath}.lock`, async () => {
    const current = JSON.parse(await readFile(filePath, 'utf8'));
    const index = current.proposals.findIndex((entry) => entry.id === proposalId);
    if (index < 0) throw new Error(`Unknown proposal: ${proposalId}`);
    current.proposals[index] = callback({ ...current.proposals[index] });
    current.updatedAt = new Date().toISOString();
    await atomicWriteJson(filePath, current);
    return { ...current.proposals[index] };
  });
}

export async function reserveProposal({ root, runId, proposalId, taskId }) {
  nonEmptyString(taskId, 'taskId');
  return mutateProposal({ root, runId, proposalId, callback: (proposal) => {
    if (proposal.status !== 'approved') throw new Error(`Proposal ${proposalId} is not approved`);
    if (proposal.applied === true) throw new Error(`Proposal ${proposalId} was already applied and consumed`);
    if (proposal.reservedBy && proposal.reservedBy !== taskId) throw new Error(`Proposal ${proposalId} is reserved by ${proposal.reservedBy}`);
    return { ...proposal, reservedBy: taskId, reservedAt: proposal.reservedAt ?? new Date().toISOString() };
  } });
}

export async function releaseProposalReservation({ root, runId, proposalId, taskId }) {
  return mutateProposal({ root, runId, proposalId, callback: (proposal) => {
    if (proposal.reservedBy && proposal.reservedBy !== taskId) throw new Error(`Proposal ${proposalId} is reserved by another task`);
    const { reservedBy, reservedAt, ...rest } = proposal;
    return rest;
  } });
}

export async function markProposalApplied({ root, runId, proposalId, taskId, evidence = [] }) {
  return mutateProposal({ root, runId, proposalId, callback: (proposal) => {
    if (proposal.applied === true) throw new Error(`Proposal ${proposalId} was already applied`);
    if (proposal.status !== 'approved' || proposal.reservedBy !== taskId) {
      throw new Error(`Proposal ${proposalId} must be approved and reserved by ${taskId}`);
    }
    return {
      ...proposal,
      applied: true,
      appliedAt: new Date().toISOString(),
      appliedByTask: taskId,
      applicationEvidence: uniqueStrings(evidence)
    };
  } });
}

export async function decideProposal({ root, runId, proposalId, decision, comment = '' }) {
  if (!PROPOSAL_DECISIONS.has(decision)) throw new Error(`Unsupported proposal decision: ${decision}`);
  const filePath = retrospectivePath(root, runId);
  const value = await withFileLock(`${filePath}.lock`, async () => {
    const current = JSON.parse(await readFile(filePath, 'utf8'));
    const index = current.proposals.findIndex((entry) => entry.id === proposalId);
    if (index < 0) throw new Error(`Unknown proposal: ${proposalId}`);
    if (current.proposals[index].applied === true) throw new Error(`Applied proposal ${proposalId} cannot be changed`);
    if (current.proposals[index].reservedBy) throw new Error(`Reserved proposal ${proposalId} cannot be changed`);
    current.proposals[index] = {
      ...current.proposals[index],
      status: decision,
      applied: false,
      decidedAt: new Date().toISOString(),
      ...(comment ? { decisionComment: comment } : {})
    };
    current.updatedAt = new Date().toISOString();
    await atomicWriteJson(filePath, current);
    return current;
  });
  return { ...value, path: filePath };
}
