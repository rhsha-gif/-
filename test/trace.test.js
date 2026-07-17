import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendTraceEvent, formatTraceSummary, readTrace, summarizeTrace } from '../src/trace.js';

test('trace records host, route, prompt, verifier, and record-only shadow events durably', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-trace-'));
  const filePath = path.join(root, 'trace.jsonl');
  await appendTraceEvent(filePath, {
    type: 'host', role: 'host', provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5', requestedEffort: 'high', effectiveEffort: 'high', selectionMode: 'preferred', executionMode: 'bootstrap-only'
  });
  await appendTraceEvent(filePath, {
    type: 'route', role: 'router', lane: 'bundled', provider: 'openai', model: 'gpt-5.6-terra', modelRevision: 'terra-2026-07', effort: 'high', profileId: 'terra'
  });
  await appendTraceEvent(filePath, {
    type: 'shadow', role: 'shadow', mode: 'record-only', execute: false, evidenceStatus: 'counterfactual-only', provider: 'anthropic', model: 'sonnet', effort: 'high', profileId: 'sonnet'
  });
  await appendTraceEvent(filePath, { type: 'prompt', role: 'executor', promptProfileId: 'openai-codex-terra-v1', promptSha256: 'a'.repeat(64) });
  await appendTraceEvent(filePath, { type: 'verification', role: 'verifier', status: 'pass', evidenceCount: 3 });
  const events = await readTrace(filePath);
  assert.equal(events.length, 5);
  const summary = summarizeTrace(events);
  assert.equal(summary.host.resolvedModel, 'claude-sonnet-5');
  assert.equal(summary.host.selectionMode, 'preferred');
  assert.equal(summary.host.executionMode, 'bootstrap-only');
  assert.equal(summary.lane, 'bundled');
  assert.equal(summary.externalModelCalls, 1);
  assert.equal(summary.executor.model, 'gpt-5.6-terra');
  assert.equal(summary.shadow.execute, false);
  assert.equal(summary.shadow.evidenceStatus, 'counterfactual-only');
  assert.equal(summary.verification.status, 'pass');
  assert.match(formatTraceSummary(summary), /Host: anthropic\/claude-sonnet-5 effort=high/);
  assert.match(formatTraceSummary(summary), /Executor: openai\/gpt-5.6-terra effort=high/);
});

test('trace preserves unknown host identity rather than inventing a model', () => {
  const summary = summarizeTrace([{ type: 'host', role: 'host', provider: null, resolvedModel: null, effectiveEffort: null }]);
  assert.equal(summary.host.resolvedModel, null);
  assert.match(formatTraceSummary(summary), /Host: unknown/);
});

test('trace rejects a shadow event that claims it executed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-trace-shadow-'));
  await assert.rejects(() => appendTraceEvent(path.join(root, 'trace.jsonl'), {
    type: 'shadow', role: 'shadow', mode: 'record-only', execute: true, provider: 'openai', model: 'gpt-5.6-terra'
  }), /record-only.*execute=false/i);
});
