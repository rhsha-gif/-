import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/providers/base.js';
import { buildClaudeCommand } from '../src/providers/claude-cli.js';
import { buildCodexCommand } from '../src/providers/codex-cli.js';
import { buildGenericCommand } from '../src/providers/generic-cli.js';

const task = {
  internalNote: 'hidden verifier sentinel',
  id: 'T1', title: 'Implement parser', objective: 'Implement the parser', kind: 'implementation',
  role: 'executor', risk: 'standard', write: true, acceptanceCriteria: ['all parser tests pass']
};
const route = { provider: 'anthropic', model: 'sonnet', effort: 'high', profileId: 'claude-sonnet' };
const capabilities = { skills: [{ id: 'tdd' }], plugins: [], hooks: [{ id: 'quality-gate', phase: 'post' }] };

test('task prompt contains bounded scope, capabilities, evidence, and no delegation', () => {
  const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath: '.aorch/receipts/T1.json' });
  assert.match(prompt, /Do not delegate/);
  assert.match(prompt, /tdd/);
  assert.match(prompt, /all parser tests pass/);
  assert.match(prompt, /\.aorch\/receipts\/T1\.json/);
  assert.match(prompt, /pre-installed provider lifecycle policies/);
  assert.match(prompt, /exact equality against the Git working-tree delta/);
  assert.match(prompt, /source path of any rename/);
  assert.doesNotMatch(prompt, /activated by the wrapper/);
  assert.doesNotMatch(prompt, /hidden verifier sentinel/i);
});

test('Claude command pins model and effort and bypasses recursive orchestration', () => {
  const spec = buildClaudeCommand({ prompt: 'do it', route, write: true });
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args.slice(0, 2), ['-p', 'do it']);
  assert.ok(spec.args.includes('--model'));
  assert.ok(spec.args.includes('sonnet'));
  assert.ok(spec.args.includes('--effort'));
  assert.ok(spec.args.includes('high'));
  assert.equal(spec.env.AORCH_WORKER, '1');
});

test('Claude command strips the $schema meta-declaration the CLI validator rejects', () => {
  const spec = buildClaudeCommand({
    prompt: 'do it',
    route,
    write: true,
    jsonSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status']
    }
  });
  const payload = JSON.parse(spec.args[spec.args.indexOf('--json-schema') + 1]);
  assert.equal(payload.$schema, undefined);
  assert.deepEqual(payload.required, ['status']);
  assert.equal(payload.properties.status.type, 'string');
});

test('Codex command uses explicit sandbox, model, effort, and structured output', () => {
  const spec = buildCodexCommand({
    prompt: 'do it',
    route: { ...route, provider: 'openai', model: 'gpt-5.6', effort: 'xhigh' },
    write: false,
    schemaPath: '/tmp/schema.json',
    outputPath: '/tmp/result.json'
  });
  assert.equal(spec.command, 'codex');
  assert.ok(spec.args.includes('read-only'));
  assert.ok(spec.args.includes('gpt-5.6'));
  assert.ok(spec.args.includes('--json'));
  assert.ok(!spec.args.includes('--output-format'));
  assert.ok(spec.args.some((x) => x.includes('model_reasoning_effort')));
  assert.ok(spec.args.includes('/tmp/schema.json'));
  assert.equal(spec.stdin, 'do it');
  assert.equal(spec.env.AORCH_WORKER, '1');
});

test('generic provider supports config-only command templates', () => {
  const spec = buildGenericCommand({
    prompt: 'work', route: { model: 'new-model', effort: 'high' }, write: false,
    provider: { executable: 'newcli', args: ['run', '--model', '{model}', '--effort', '{effort}', '-'] }
  });
  assert.equal(spec.command, 'newcli');
  assert.deepEqual(spec.args, ['run', '--model', 'new-model', '--effort', 'high', '-']);
  assert.equal(spec.stdin, 'work');
});

test('provider executables can be replaced without changing adapter code', () => {
  const claude = buildClaudeCommand({ prompt: 'x', route, write: false, executable: '/opt/claude' });
  const codex = buildCodexCommand({
    prompt: 'x', route: { ...route, provider: 'openai', model: 'gpt-5.6', effort: 'high' },
    write: false, executable: '/opt/codex'
  });
  assert.equal(claude.command, '/opt/claude');
  assert.equal(codex.command, '/opt/codex');
});

test('ultracode route passes through as a native effort with per-agent guidance and a raised turn budget', () => {
  const spec = buildClaudeCommand({
    prompt: 'audit the repo',
    route: { ...route, model: 'opus', effort: 'ultracode' },
    write: true
  });
  const prompt = spec.args[spec.args.indexOf('-p') + 1];
  assert.match(prompt, /^Assign each workflow agent/);
  assert.match(prompt, /reasoning effort by purpose/);
  assert.match(prompt, /audit the repo/);
  assert.equal(spec.args[spec.args.indexOf('--effort') + 1], 'ultracode');
  assert.equal(spec.args[spec.args.indexOf('--max-turns') + 1], '200');
});

test('an explicit turn budget above the ultracode floor is respected', () => {
  const spec = buildClaudeCommand({
    prompt: 'x',
    route: { ...route, model: 'opus', effort: 'ultracode' },
    write: false,
    maxTurns: 300
  });
  assert.equal(spec.args[spec.args.indexOf('--max-turns') + 1], '300');
});

test('codex ultra and max efforts pass through as model_reasoning_effort', () => {
  for (const effort of ['ultra', 'max']) {
    const spec = buildCodexCommand({
      prompt: 'x',
      route: { provider: 'openai', model: 'gpt-5.6-sol', effort },
      write: false
    });
    assert.ok(spec.args.includes(`model_reasoning_effort="${effort}"`));
  }
});

test('a role preset reaches claude as --agent and is absent when no role is set', () => {
  const route = { model: 'sonnet', effort: 'high' };
  const without = buildClaudeCommand({ prompt: 'do it', route });
  assert.equal(without.args.includes('--agent'), false);

  const with_ = buildClaudeCommand({ prompt: 'do it', route, agent: 'aorch-reviewer' });
  const at = with_.args.indexOf('--agent');
  assert.notEqual(at, -1);
  assert.equal(with_.args[at + 1], 'aorch-reviewer');
  // The router still supplies the tier; the preset supplies behaviour and tools.
  assert.equal(with_.args[with_.args.indexOf('--model') + 1], 'sonnet');
});

test('codex has no agent flag, so the preset arrives as prompt instructions', () => {
  const route = { model: 'gpt-5.6-terra', effort: 'high' };
  const without = buildCodexCommand({ prompt: 'do it', route });
  assert.equal(without.stdin, 'do it');
  assert.equal(without.args.includes('--agent'), false);

  const with_ = buildCodexCommand({ prompt: 'do it', route, agentInstructions: 'Fix only the named cause.' });
  assert.equal(with_.stdin, 'Fix only the named cause.\n\ndo it');
  assert.equal(with_.args.includes('--agent'), false);
});
