import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgress, formatProgressReport, ProgressReporter } from '../src/progress.js';

test('calculates weighted progress and labels it as an estimate', () => {
  const progress = calculateProgress([
    { id: 'A', weight: 1, status: 'complete' },
    { id: 'B', weight: 3, status: 'running', fraction: 0.5 },
    { id: 'C', weight: 2, status: 'pending' }
  ]);
  assert.equal(progress.percent, 42);
  assert.equal(progress.label, 'estimated');
});

test('reports immediately and schedules a 30-minute default interval', () => {
  const reports = [];
  const scheduled = [];
  const reporter = new ProgressReporter({
    onReport: (entry) => reports.push(entry),
    setIntervalFn: (fn, ms) => { scheduled.push({ fn, ms }); return 7; },
    clearIntervalFn: () => {}
  });

  reporter.start(() => [{ id: 'A', weight: 1, status: 'pending' }]);

  assert.equal(reports.length, 1);
  assert.equal(scheduled[0].ms, 30 * 60 * 1000);
  scheduled[0].fn();
  assert.equal(reports.length, 2);
});


test('progress reports phase, confidence, blockers, and evidence rather than percentage alone', () => {
  const progress = calculateProgress([
    { id: 'A', weight: 1, status: 'complete', evidence: ['a.log'], lastEvidenceAt: '2026-07-16T00:00:00Z' },
    { id: 'B', weight: 2, status: 'blocked', blocker: 'Provider authentication is unavailable.' }
  ]);
  assert.equal(progress.phase, 'blocked');
  assert.equal(progress.confidence, 'low');
  assert.deepEqual(progress.blockers, [{ taskId: 'B', message: 'Provider authentication is unavailable.' }]);
  assert.equal(progress.evidenceCount, 1);
  assert.equal(progress.lastEvidenceAt, '2026-07-16T00:00:00Z');
});

test('verification is exposed as a distinct progress phase', () => {
  const progress = calculateProgress([{ id: 'A', status: 'verifying', fraction: 0.8, progressConfidence: 0.9 }]);
  assert.equal(progress.phase, 'verifying');
  assert.equal(progress.confidence, 'high');
});

test('progress formatter exposes blockers and evidence instead of percentage alone', () => {
  const output = formatProgressReport({
    percent: 72,
    label: 'estimated',
    phase: 'blocked',
    confidence: 'low',
    evidenceCount: 4,
    lastEvidenceAt: '2026-07-16T00:00:00Z',
    blockers: [{ taskId: 'T2', message: 'Provider authentication failed.' }]
  });
  assert.match(output, /72%/);
  assert.match(output, /phase=blocked/);
  assert.match(output, /confidence=low/);
  assert.match(output, /evidence=4/);
  assert.match(output, /T2: Provider authentication failed/);
});

test('progress formatter neutralizes multiline and terminal-control blocker text', () => {
  const output = formatProgressReport({
    percent: 40,
    phase: 'blocked',
    confidence: 'low',
    blockers: [{ taskId: 'T1\nforged', message: 'line one\n[aorch] forged\u001b[31m' }]
  });
  assert.equal(output.includes('\n'), false);
  assert.equal(output.includes('\u001b'), false);
  assert.match(output, /T1 forged: line one \[aorch\] forged/);
});

test('a run with no tasks reports planning at 0 percent, not completion', async () => {
  const { calculateProgress } = await import('../src/progress.js');
  const result = calculateProgress([]);
  assert.equal(result.percent, 0);
  assert.equal(result.phase, 'planning');
});
