import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/providers/base.js';
import { buildClaudeCommand } from '../src/providers/claude-cli.js';
import { buildCodexCommand } from '../src/providers/codex-cli.js';
import { buildGenericCommand } from '../src/providers/generic-cli.js';

const task = {
  verifierCommands: ['echo hidden verifier sentinel'],
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

test('generic provider argument mode injects the prompt through the {prompt} placeholder', () => {
  const spec = buildGenericCommand({
    prompt: 'do the work', route: { model: 'm1', effort: 'low' }, write: false,
    provider: { executable: 'argcli', promptMode: 'argument', args: ['run', '--model', '{model}', '--prompt', '{prompt}'] }
  });
  assert.deepEqual(spec.args, ['run', '--model', 'm1', '--prompt', 'do the work']);
  assert.equal(spec.stdin, null);
});

test('generic provider argument mode without a {prompt} placeholder fails closed instead of dropping the prompt', () => {
  assert.throws(() => buildGenericCommand({
    prompt: 'lost work', route: { model: 'm1', effort: 'low' }, write: false,
    provider: { id: 'argcli', executable: 'argcli', promptMode: 'argument', args: ['run', '--model', '{model}'] }
  }), /\{prompt\} placeholder/);
});

test('generic provider stdin mode does not interpolate {prompt} into arguments', () => {
  const spec = buildGenericCommand({
    prompt: 'stdin work', route: { model: 'm1', effort: 'low' }, write: false,
    provider: { executable: 'stdcli', args: ['run', '--prompt', '{prompt}'] }
  });
  assert.deepEqual(spec.args, ['run', '--prompt', '']);
  assert.equal(spec.stdin, 'stdin work');
});
