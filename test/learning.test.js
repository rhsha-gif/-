import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRun, finishRun, loadRun } from '../src/state.js';
import {
  appendUserFeedback,
  decideProposal,
  lintLessons,
  loadLessons,
  loadRetrospective,
  saveRetrospective
} from '../src/learning.js';

function reflection(runId, overrides = {}) {
  return {
    runId,
    outcome: 'completed',
    summary: 'Implemented and verified the requested change.',
    whatWorked: ['Bounded tasks kept the change focused.'],
    errors: [{
      id: 'E1',
      description: 'A test command used the wrong path on the first attempt.',
      evidence: ['task-runs/T1/stderr.log'],
      prevention: 'Resolve test paths from the project root before dispatch.',
      tags: ['verification', 'path']
    }],
    inefficiencies: [{
      id: 'I1',
      description: 'The scout received unrelated architecture context.',
      evidence: ['routing-decisions.jsonl'],
      proposedChange: 'Send module-scoped context to exploration tasks.'
    }],
    technicalDebt: [{
      id: 'D1',
      description: 'Duplicate hook wording exists in two integration files.',
      scope: 'harness',
      introducedByRun: false,
      recommendedAction: 'Consolidate the shared text after approval.'
    }],
    proposals: [{
      id: 'P1',
      category: 'error-prevention',
      title: 'Normalize verification paths',
      rationale: 'Prevents the observed path error from recurring.',
      expectedBenefit: 'Fewer avoidable verification retries.',
      risks: ['May affect Windows path handling.'],
      affectedFiles: ['src/task-runner.js']
    }],
    ...overrides
  };
}

test('persists a retrospective and keeps harness changes pending until user approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');

  const saved = await saveRetrospective({ root, runPath: run.path, input: reflection(run.id) });
  assert.equal(saved.proposals[0].status, 'pending');
  assert.equal(saved.proposals[0].requiresUserApproval, true);

  const loadedRun = await loadRun(run.path);
  assert.equal(loadedRun.reviewStatus, 'complete');
  assert.equal(loadedRun.reflectionPath, saved.path);

  const persisted = JSON.parse(await readFile(saved.path, 'utf8'));
  assert.equal(persisted.runId, run.id);
});

test('infers retrospective runId from the selected run when omitted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-infer-run-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');

  const input = reflection(run.id);
  delete input.runId;
  const saved = await saveRetrospective({ root, runPath: run.path, input });

  assert.equal(saved.runId, run.id);
});

test('user feedback is appended and preserved when a reflection is revised', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-feedback-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');
  await saveRetrospective({ root, runPath: run.path, input: reflection(run.id) });

  await appendUserFeedback({ root, runId: run.id, feedback: { rating: 3, comment: 'The result works, but the review was too broad.' } });
  await saveRetrospective({
    root,
    runPath: run.path,
    input: reflection(run.id, { summary: 'Revised after user feedback.' })
  });

  const saved = await loadRetrospective({ root, runId: run.id });
  assert.equal(saved.revision, 2);
  assert.equal(saved.userFeedback.length, 1);
  assert.match(saved.userFeedback[0].comment, /too broad/i);
});

test('proposal approval records consent but does not claim to apply source changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-decision-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');
  await saveRetrospective({ root, runPath: run.path, input: reflection(run.id) });

  const decided = await decideProposal({
    root,
    runId: run.id,
    proposalId: 'P1',
    decision: 'approved',
    comment: 'Apply this in a separate orchestrated change.'
  });

  assert.equal(decided.proposals[0].status, 'approved');
  assert.equal(decided.proposals[0].applied, false);
  assert.match(decided.proposals[0].decisionComment, /separate orchestrated change/i);
});

test('rejects a retrospective that tries to mark a proposal applied automatically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-invalid-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');

  await assert.rejects(() => saveRetrospective({
    root,
    runPath: run.path,
    input: reflection(run.id, {
      proposals: [{
        ...reflection(run.id).proposals[0],
        status: 'approved',
        applied: true
      }]
    })
  }), /cannot mark.*applied/i);
});

test('does not close a run with unresolved technical debt introduced by that run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-debt-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');

  await assert.rejects(() => saveRetrospective({
    root,
    runPath: run.path,
    input: reflection(run.id, {
      technicalDebt: [{
        id: 'D-new',
        description: 'The run introduced a duplicated validation branch.',
        scope: 'project',
        introducedByRun: true,
        status: 'pending',
        recommendedAction: 'Remove the duplicate branch.'
      }]
    })
  }), /introduced by the run.*resolved/i);
});

test('retrospective outcome must match the terminal run status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-outcome-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'failed');
  await assert.rejects(
    () => saveRetrospective({ root, runPath: run.path, input: reflection(run.id) }),
    /outcome.*run status/i
  );
});

test('revisions preserve prior findings and proposal decisions when adding feedback-derived findings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-merge-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');
  await saveRetrospective({ root, runPath: run.path, input: reflection(run.id) });
  await decideProposal({ root, runId: run.id, proposalId: 'P1', decision: 'approved' });

  await saveRetrospective({
    root,
    runPath: run.path,
    input: reflection(run.id, {
      errors: [{
        id: 'E2',
        description: 'The final summary omitted one known limitation.',
        evidence: ['final-summary.txt'],
        prevention: 'Check unresolved risks before writing the final summary.',
        tags: ['final-report', 'verification']
      }],
      inefficiencies: [],
      technicalDebt: [],
      proposals: []
    })
  });

  const saved = await loadRetrospective({ root, runId: run.id });
  assert.deepEqual(saved.errors.map((entry) => entry.id).sort(), ['E1', 'E2']);
  assert.equal(saved.proposals.find((entry) => entry.id === 'P1').status, 'approved');
});

test('verified error preventions become deduplicated operational lessons for later prompts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-lessons-'));

  for (const runId of ['R1', 'R2']) {
    const run = await createRun({ root, prompt: `build ${runId}`, runId, tasks: [] });
    await finishRun(run.path, 'completed');
    await saveRetrospective({
      root,
      runPath: run.path,
      input: reflection(run.id, {
        errors: [{
          id: `E-${runId}`,
          description: 'A verification command used a relative path from the wrong directory.',
          evidence: [`${runId}/stderr.log`],
          prevention: 'Resolve verification paths from the project root before dispatch.',
          tags: ['verification', 'path', 'test']
        }],
        inefficiencies: [], technicalDebt: [], proposals: []
      })
    });
  }

  const lessons = await loadLessons({ root, query: 'fix verification test path', limit: 5 });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].occurrences, 2);
  assert.match(lessons[0].prevention, /project root/i);
  assert.deepEqual(lessons[0].sourceRunIds.sort(), ['R1', 'R2']);
});


test('operational lessons are advisory, scoped, evidenced, confidence-rated, and expiring', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-governed-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');
  await saveRetrospective({ root, runPath: run.path, input: reflection(run.id) });
  const lessons = await loadLessons({ root, query: 'verification path', limit: 5 });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].status, 'advisory');
  assert.equal(lessons[0].type, 'negative');
  assert.deepEqual(lessons[0].scopeTags.sort(), ['path', 'verification']);
  assert.ok(lessons[0].evidence.length > 0);
  assert.ok(lessons[0].confidence >= 0 && lessons[0].confidence <= 1);
  assert.ok(Date.parse(lessons[0].expiresAt) > Date.now());
  assert.equal(lessons[0].promotedToPolicy, false);
});

test('expired or malformed lessons are not retrieved and lint explains why', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-lint-'));
  const file = path.join(root, 'learning/lessons.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 2,
    lessons: [
      {
        id: 'expired', type: 'negative', status: 'advisory', description: 'old', prevention: 'old rule',
        scopeTags: ['test'], evidence: ['old.log'], confidence: 0.9,
        expiresAt: '2000-01-01T00:00:00Z', sourceRunIds: ['R1'], occurrences: 1,
        createdAt: '2000-01-01T00:00:00Z', lastSeenAt: '2000-01-01T00:00:00Z', promotedToPolicy: false
      },
      { id: 'malformed', description: 'missing governance', prevention: 'unsafe shortcut' }
    ]
  }));
  assert.deepEqual(await loadLessons({ root, query: 'test unsafe', limit: 5, now: new Date('2026-07-16T00:00:00Z') }), []);
  const lint = await lintLessons({ root, now: new Date('2026-07-16T00:00:00Z') });
  assert.equal(lint.status, 'fail');
  assert.ok(lint.issues.some((issue) => issue.lessonId === 'expired' && issue.code === 'expired'));
  assert.ok(lint.issues.some((issue) => issue.lessonId === 'malformed' && issue.code === 'scope-tags'));
});

test('lesson lint reports malformed JSON instead of crashing doctor-style health checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-invalid-json-'));
  const file = path.join(root, 'learning/lessons.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{broken');
  const lint = await lintLessons({ root });
  assert.equal(lint.status, 'fail');
  assert.equal(lint.total, 0);
  assert.ok(lint.issues.some((issue) => issue.code === 'invalid-json'));
});

test('retrospective errors require evidence and relevance tags before becoming memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-learning-required-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  await finishRun(run.path, 'completed');
  await assert.rejects(() => saveRetrospective({
    root,
    runPath: run.path,
    input: reflection(run.id, {
      errors: [{ id: 'E-bad', description: 'Observed issue', evidence: [], prevention: 'Do better', tags: [] }]
    })
  }), /evidence.*at least one|tags.*at least one/i);
});
