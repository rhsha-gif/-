import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/providers/base.js';
import { buildClaudeCommand } from '../src/providers/claude-cli.js';
import { buildCodexCommand } from '../src/providers/codex-cli.js';
import { buildGenericCommand } from '../src/providers/generic-cli.js';
import {
  buildAntigravityCommand,
  parseAntigravityOutput
} from '../src/providers/antigravity-cli.js';
import {
  buildGrokCommand,
  buildGrokFinalizeCommand,
  parseGrokOutput,
  parseGrokWorkOutput
} from '../src/providers/grok-cli.js';

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
  assert.match(prompt, /exact equality against the working-tree delta between the moment your task started/);
  assert.match(prompt, /source path of any rename/);
  assert.match(prompt, /already modified before your task started/);
  assert.match(prompt, /If you changed nothing, filesChanged must be an empty array/);
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

test('Antigravity Sonnet omits unsupported effort while preserving model and sandbox', () => {
  const spec = buildAntigravityCommand({
    prompt: 'Read evidence.txt', route: { model: 'claude-sonnet-4-6', effort: 'medium' },
    schemaPath: 'receipt.schema.json', cwd: process.cwd(), write: false
  });
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.equal(spec.args.includes('--effort'), false);
  assert.equal(spec.args[spec.args.indexOf('--mode') + 1], 'plan');
  assert.ok(spec.args.includes('--sandbox'));
});

test('Antigravity uses stdin NDJSON, structured output, sandboxing, and scoped modes', () => {
  const schemaPath = 'C:\\작업 공간\\결과 schema.json';
  const cwd = 'C:\\작업 공간';
  const prompt = 'Inspect C:\\작업 공간 & do not interpolate this prompt';
  const readOnly = buildAntigravityCommand({
    prompt,
    route: { model: 'gemini-3.8-flash-high', effort: 'high' },
    schemaPath,
    cwd,
    agent: 'aorch-reviewer'
  });
  assert.equal(readOnly.command, 'agy');
  assert.equal(readOnly.args.includes(prompt), false);
  const message = JSON.parse(readOnly.stdin.trim());
  assert.equal(message.event, 'user');
  assert.match(message.message.content, /do not call run_command/i);
  assert.match(message.message.content, /parent wrapper runs them/i);
  assert.match(message.message.content, /Inspect C:\\작업 공간/);
  assert.equal(readOnly.args[readOnly.args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(readOnly.args[readOnly.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(readOnly.args[readOnly.args.indexOf('--json-schema') + 1], schemaPath);
  assert.equal(readOnly.args[readOnly.args.indexOf('--add-dir') + 1], cwd);
  assert.equal(readOnly.args[readOnly.args.indexOf('--mode') + 1], 'plan');
  assert.equal(readOnly.args[readOnly.args.indexOf('--agent') + 1], 'aorch-reviewer');
  assert.equal(readOnly.args.includes('--sandbox'), true);
  assert.equal(readOnly.args.includes('--disable-slash-commands'), false);
  assert.equal(readOnly.args.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(readOnly.unsetEnv, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);

  const writer = buildAntigravityCommand({
    prompt, route: { model: 'gemini-3.8-flash-high', effort: 'medium' }, schemaPath, cwd, write: true
  });
  assert.equal(writer.args[writer.args.indexOf('--mode') + 1], 'accept-edits');
});

test('Grok keeps prompt paths intact, denies nested agents, and never blanket-approves', () => {
  const promptPath = 'C:\\작업 공간\\프롬프트 파일.md';
  const cwd = 'C:\\작업 공간';
  const readOnly = buildGrokCommand({
    route: { model: 'grok-4.6', effort: 'low' }, promptPath, cwd, agent: 'aorch-reviewer'
  });
  assert.equal(readOnly.command, 'grok');
  assert.equal(readOnly.args[readOnly.args.indexOf('--prompt-file') + 1], promptPath);
  assert.equal(readOnly.args[readOnly.args.indexOf('--cwd') + 1], cwd);
  assert.equal(readOnly.args.includes('--json-schema'), false);
  assert.equal(readOnly.args[readOnly.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(readOnly.args[readOnly.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(readOnly.args.includes('--no-subagents'), true);
  assert.equal(readOnly.args[readOnly.args.indexOf('--disallowed-tools') + 1], 'Agent');
  assert.equal(readOnly.args.includes('--always-approve'), false);
  assert.deepEqual(readOnly.unsetEnv, ['XAI_API_KEY']);
  const tools = readOnly.args[readOnly.args.indexOf('--tools') + 1].split(',');
  assert.deepEqual(tools, ['read_file', 'grep', 'list_dir']);
  assert.equal(tools.includes('task'), false);
  assert.equal(tools.includes('search_tool'), false);
  assert.equal(tools.includes('use_tool'), false);
  assert.equal(readOnly.args[readOnly.args.indexOf('--agent') + 1], 'aorch-reviewer');
  assert.ok(readOnly.args.includes('Read(C:/작업 공간/**)'));
  assert.ok(readOnly.args.includes('Grep(C:/작업 공간/**)'));

  const writer = buildGrokCommand({
    route: { model: 'grok-4.6', effort: 'high' }, promptPath, cwd, write: true
  });
  assert.equal(writer.args[writer.args.indexOf('--sandbox') + 1], 'workspace');
  assert.match(writer.args[writer.args.indexOf('--tools') + 1], /search_replace/);
  assert.ok(writer.args.includes('Edit(C:/작업 공간/**)'));
  assert.ok(writer.args.includes('Write(C:/작업 공간/**)'));

  const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const finalize = buildGrokFinalizeCommand({
    route: { model: 'grok-4.6', effort: 'low' },
    sessionId: '00000000-0000-0000-0000-000000000000', promptPath, cwd, jsonSchema,
    agent: 'aorch-reviewer'
  });
  assert.deepEqual(JSON.parse(finalize.args[finalize.args.indexOf('--json-schema') + 1]), jsonSchema);
  assert.equal(finalize.args[finalize.args.indexOf('--resume') + 1], '00000000-0000-0000-0000-000000000000');
});

test('new provider parsers require structured envelopes and keep only measured token counts', () => {
  const receipt = { status: 'complete' };
  const agy = parseAntigravityOutput([
    JSON.stringify({ event: 'init', init: {} }),
    JSON.stringify({ event: 'result', result: {
      status: 'SUCCESS', structured_output: receipt,
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, total_tokens: 12, account: 'hidden' }
    } })
  ].join('\n'));
  assert.deepEqual(agy, {
    receipt,
    usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1, totalTokens: 12 }
  });

  const grok = parseGrokOutput(JSON.stringify({
    text: JSON.stringify(receipt), structuredOutput: receipt,
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, total_cost_usd: 99 }
  }));
  assert.deepEqual(grok, { receipt, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
  assert.deepEqual(parseGrokWorkOutput(JSON.stringify({
    text: 'worked', sessionId: '00000000-0000-0000-0000-000000000000', num_turns: 2,
    usage: { input_tokens: 5, output_tokens: 1, account: 'omit' }
  })), {
    sessionId: '00000000-0000-0000-0000-000000000000', turns: 2,
    usage: { inputTokens: 5, outputTokens: 1 }
  });
  assert.throws(() => parseAntigravityOutput('{bad json'), /protocol error/i);
  assert.throws(
    () => parseAntigravityOutput(JSON.stringify({ event: 'result', result: {
      status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }]
    } })),
    (error) => error.failureKind === 'action-required' && error.actionRequired === 'permission'
      && error.deniedActionCount === 1 && !error.message.includes('read_file')
  );
  assert.throws(
    () => parseGrokOutput(JSON.stringify({ text: '{}', usage: { input_tokens: 4, account: 'omit' } })),
    (error) => /structuredOutput/.test(error.message) && error.usage.inputTokens === 4
  );
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

test('a Claude worker is granted the tools it needs, since no mode grants them', () => {
  const route = { model: 'haiku', effort: 'medium' };
  const readOnly = buildClaudeCommand({ prompt: 'survey', route, write: false });
  const writer = buildClaudeCommand({ prompt: 'build', route, write: true });

  const listAfter = (spec, flag) => {
    const at = spec.args.indexOf(flag);
    if (at === -1) return null;
    const out = [];
    for (let i = at + 1; i < spec.args.length && !spec.args[i].startsWith('--'); i += 1) out.push(spec.args[i]);
    return out;
  };

  // Measured on claude 2.1.233: every permission mode denies Bash headlessly,
  // so without an allowlist the worker returns prose asking for approval and
  // never produces a receipt. Bash is granted to both because verification
  // runs through it.
  const READ = ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch'];
  assert.deepEqual(listAfter(readOnly, '--allowed-tools'), READ);
  assert.deepEqual(listAfter(writer, '--allowed-tools'), [...READ, 'Write', 'Edit']);

  // PowerShell is a separate tool name on Windows; omitting it costs the worker
  // its turn budget in denials. The web tools go to every role, researcher
  // included, so research does not need a role-conditional allowlist.
  for (const spec of [readOnly, writer]) {
    for (const tool of ['PowerShell', 'WebSearch', 'WebFetch']) {
      assert.ok(spec.args.includes(tool), `${tool} must be granted to every role`);
    }
  }

  // A read-only worker is handed no editing tools at all; the change guard
  // still compares the tree afterwards.
  assert.deepEqual(listAfter(readOnly, '--disallowed-tools'), ['Write', 'Edit', 'NotebookEdit']);
  assert.equal(writer.args.includes('--disallowed-tools'), false, 'a write task keeps its editing tools');

  const mode = (spec) => spec.args[spec.args.indexOf('--permission-mode') + 1];
  assert.equal(mode(readOnly), 'auto');
  assert.equal(mode(writer), 'auto');
});

test('a role preset that carries an MCP server reaches claude as --mcp-config with enumerated tools', () => {
  const route = { model: 'sonnet', effort: 'high' };
  const plain = buildClaudeCommand({ prompt: 'survey', route, agent: 'aorch-researcher' });
  assert.equal(plain.args.includes('--mcp-config'), false);
  assert.equal(plain.args.includes('--strict-mcp-config'), false);
  assert.equal(plain.args.some((arg) => arg.startsWith('mcp__')), false);

  const tools = ['mcp__paper-search__search_arxiv', 'mcp__paper-search__read_arxiv_paper'];
  const withMcp = buildClaudeCommand({
    prompt: 'survey', route, agent: 'aorch-paper-researcher', mcpConfig: '/x/paper.mcp.json', mcpTools: tools
  });
  const at = withMcp.args.indexOf('--mcp-config');
  assert.notEqual(at, -1);
  assert.equal(withMcp.args[at + 1], '/x/paper.mcp.json');
  assert.equal(withMcp.args[at + 2], '--strict-mcp-config');
  const allowedAt = withMcp.args.indexOf('--allowed-tools');
  const allowed = [];
  for (let i = allowedAt + 1; i < withMcp.args.length && !withMcp.args[i].startsWith('--'); i += 1) allowed.push(withMcp.args[i]);
  // The built-in read set stays first and intact; MCP tools are appended by name.
  assert.deepEqual(allowed.slice(0, 7), ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch']);
  assert.deepEqual(allowed.slice(7), tools);
  assert.equal(allowed.includes('mcp__paper-search__download_scihub'), false);
  assert.equal(allowed.some((tool) => tool.endsWith('*')), false, 'no wildcard grant');
  // mcpTools without a config would grant tools no server provides.
  const toolsOnly = buildClaudeCommand({ prompt: 'survey', route, mcpTools: tools });
  assert.equal(toolsOnly.args.some((arg) => arg.startsWith('mcp__')), false);
});

test('a role preset that carries an MCP server reaches codex as -c mcp_servers overrides', () => {
  const route = { model: 'gpt-5.6-terra', effort: 'high' };
  const plain = buildCodexCommand({ prompt: 'survey', route });
  assert.equal(plain.args.some((arg) => arg.startsWith('mcp_servers.')), false);

  const spec = buildCodexCommand({
    prompt: 'survey', route, mcpServers: { 'paper-search': { command: 'uvx', args: ['paper-search-mcp'] } }
  });
  const overrides = spec.args.filter((arg, i) => spec.args[i - 1] === '-c' && arg.startsWith('mcp_servers.'));
  assert.deepEqual(overrides, [
    'mcp_servers.paper-search.command="uvx"',
    'mcp_servers.paper-search.args=["paper-search-mcp"]'
  ]);
});

test('codex workers get web search through the flag exec actually accepts', () => {
  const spec = buildCodexCommand({ prompt: 'find it', route: { model: 'gpt-5.6-terra', effort: 'high' } });
  const at = spec.args.indexOf('--enable');
  assert.notEqual(at, -1, 'exec needs --enable web_search');
  assert.equal(spec.args[at + 1], 'web_search');
  // --search exists only on the interactive command; exec exits 2 on it.
  assert.equal(spec.args.includes('--search'), false);
});

test('Grok finalization preserves the originating sandbox while exposing only a read tool', async () => {
  const {buildGrokFinalizeCommand} = await import('../src/providers/grok-cli.js');
  const spec=buildGrokFinalizeCommand({route:{model:'grok-4.6',effort:'medium'},write:true,sessionId:'11111111-1111-1111-1111-111111111111',promptPath:'C:/work/final.md',cwd:'C:/work',jsonSchema:{type:'object'}});
  assert.equal(spec.args[spec.args.indexOf('--sandbox')+1], 'workspace');
  assert.equal(spec.args[spec.args.indexOf('--tools')+1], 'read_file');
  assert.ok(!spec.args.includes('--always-approve'));
});
