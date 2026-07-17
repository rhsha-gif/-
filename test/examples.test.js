import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTask } from '../src/task.js';
import { classifyExecutionLane } from '../src/lane.js';
import { normalizeObservation } from '../src/performance-store.js';
import { verdictToQuality } from '../src/observations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(name) {
  return JSON.parse(await readFile(path.join(root, 'examples', name), 'utf8'));
}

test('single-worker and bundled examples validate and demonstrate their intended lane', async () => {
  const host = {
    provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'sonnet',
    requestedEffort: 'high', effectiveEffort: 'high', selectionMode: 'preferred', identityKnown: true
  };
  const singleWorker = validateTask(await readJson('task-single-worker.json'), { forExecution: true });
  const bundled = validateTask(await readJson('task-bundled.json'), { forExecution: true });
  assert.equal(classifyExecutionLane({ task: singleWorker, host }).lane, 'single-worker');
  assert.equal(classifyExecutionLane({ task: bundled, host }).lane, 'bundled');
});

test('review observation example includes model revision and task signature evidence', async () => {
  const input = await readJson('review-observation.json');
  const observation = normalizeObservation({ ...input, quality: verdictToQuality(input.verdict), reviewed: true });
  assert.equal(observation.modelRevision, observation.model);
  assert.equal(observation.taskSignature.repositoryBreadth, 'module');
});


test('prompt manifest schema exposes only delegated bootstrap-only lanes', async () => {
  const schema = await readJson('../schemas/prompt-manifest.schema.json');
  assert.deepEqual(schema.properties.lane.enum, ['single-worker', 'bundled', 'orchestrated']);
  assert.deepEqual(schema.properties.execution.enum, ['delegated']);
});

test('packaged integration agents reference a model and reasoning effort the catalog actually supports', async () => {
  const { readdir } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(path.join(root, 'config/aorch.config.json'), 'utf8'));
  const effortsByModel = new Map(config.models.map((model) => [model.model, new Set(model.efforts.map((effort) => effort.name))]));

  const assertSupported = (label, model, effort) => {
    const efforts = effortsByModel.get(model);
    assert.ok(efforts, `${label} references model ${model} not present in the catalog`);
    assert.ok(efforts.has(effort), `${label} pins ${model} at effort '${effort}', which the catalog does not support (${[...efforts].join(', ')})`);
  };

  const codexDir = path.join(root, 'integrations/codex/agents');
  for (const file of (await readdir(codexDir)).filter((name) => name.endsWith('.toml'))) {
    const text = await readFile(path.join(codexDir, file), 'utf8');
    const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const effort = text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    if (model && effort) assertSupported(`codex agent ${file}`, model, effort);
  }

  const claudeDir = path.join(root, 'integrations/claude/agents');
  for (const file of (await readdir(claudeDir)).filter((name) => name.endsWith('.md'))) {
    const text = await readFile(path.join(claudeDir, file), 'utf8');
    const model = text.match(/^model:\s*(\S+)/m)?.[1];
    const effort = text.match(/^effort:\s*(\S+)/m)?.[1];
    if (model && effort) assertSupported(`claude agent ${file}`, model, effort);
  }
});
