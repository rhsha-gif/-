import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyProviderFailure,
  diagnoseProviders,
  resolveProviderExecutable
} from '../src/provider-diagnostics.js';

test('Windows resolver diagnoses stale PATH and discovers known installs', () => {
  const homeDir = 'C:\\Users\\테스트 사용자';
  const discovered = path.win32.join(homeDir, '.grok', 'bin', 'grok.exe');
  const resolved = resolveProviderExecutable(
    { command: 'grok', args: ['--version'], stdin: null },
    {
      provider: { id: 'grok', adapter: 'grok' },
      platform: 'win32',
      env: { PATH: 'C:\\stale-bin', PATHEXT: '.EXE;.CMD' },
      homeDir,
      isFile: (candidate) => candidate === discovered
    }
  );
  assert.equal(resolved.commandSpec.command, discovered);
  assert.equal(resolved.executablePath, discovered);
  assert.equal(resolved.source, 'known-install');
  assert.equal(resolved.pathIssue, 'stale-process-path');
});

test('diagnostics distinguish a cmd launcher from the resolved CLI shim', () => {
  const shim = 'C:\\bin\\grok.cmd';
  const resolved = resolveProviderExecutable(
    { command: 'grok', args: ['--version'], stdin: null },
    {
      provider: { id: 'grok', adapter: 'grok' }, platform: 'win32',
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD', COMSPEC: 'C:\\Windows\\cmd.exe' },
      isFile: (candidate) => candidate.toLowerCase() === shim.toLowerCase()
    }
  );
  assert.equal(resolved.commandSpec.command, 'C:\\Windows\\cmd.exe');
  assert.equal(resolved.executablePath.toLowerCase(), shim.toLowerCase());
});

test('an explicit executable path wins and a missing explicit path fails closed', () => {
  const explicit = 'D:\\tools\\grok-custom.exe';
  const found = resolveProviderExecutable(
    { command: explicit, args: [], stdin: null },
    { provider: { id: 'grok', adapter: 'grok' }, platform: 'win32', isFile: (file) => file === explicit }
  );
  assert.equal(found.commandSpec.command, explicit);
  assert.equal(found.pathIssue, null);

  const missing = resolveProviderExecutable(
    { command: 'D:\\missing\\grok.exe', args: [], stdin: null },
    { provider: { id: 'grok', adapter: 'grok' }, platform: 'win32', isFile: () => false }
  );
  assert.equal(missing.pathIssue, 'configured-not-found');
  assert.equal(missing.commandSpec.command, 'D:\\missing\\grok.exe');
});

test('provider diagnostics report versions, models, and features without returning auth values', async () => {
  const calls = [];
  const runCommandImpl = async (spec) => {
    calls.push([spec.command, ...spec.args]);
    if (spec.args[0] === '--version') {
      return { exitCode: 0, stdout: spec.command === 'agy' ? '1.2.2\n' : 'grok 1.0.30 (build)\n', stderr: '' };
    }
    if (spec.command === 'agy') {
      return { exitCode: 0, stdout: 'gemini-one\tGemini One\ngemini-two\tGemini Two\n', stderr: '' };
    }
    return { exitCode: 0, stdout: 'Available models:\n  * grok-4.6 (default)\n', stderr: 'You are logged in.\n' };
  };
  const providers = [
    { id: 'antigravity', adapter: 'antigravity', executable: 'agy', env: { API_TOKEN: 'never-return-this' } },
    { id: 'grok', adapter: 'grok', executable: 'grok' }
  ];
  const result = await diagnoseProviders({
    providers,
    cwd: 'C:\\작업 공간',
    platform: 'linux',
    runCommandImpl
  });
  assert.deepEqual(result.map((entry) => entry.version), ['1.2.2', 'grok 1.0.30 (build)']);
  assert.deepEqual(result[0].models, ['gemini-one', 'gemini-two']);
  assert.deepEqual(result[1].models, ['grok-4.6']);
  assert.ok(result[0].supportedFeatures.includes('stream-json'));
  assert.ok(result[1].supportedFeatures.includes('no-subagents'));
  assert.ok(result[1].supportedFeatures.includes('filesystem-policy'));
  assert.equal(result[1].supportedFeatures.includes('os-sandbox'), true);
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  assert.deepEqual(calls, [
    ['agy', '--version'], ['grok', '--version'], ['agy', 'models'], ['grok', 'models']
  ]);
});

test('Grok diagnostics do not advertise OS sandbox enforcement on Windows', async () => {
  const executable = 'C:\\tools\\grok.exe';
  const [result] = await diagnoseProviders({
    providers: [{ id: 'grok', adapter: 'grok', executable }],
    cwd: 'C:\\작업 공간', platform: 'win32', isFile: (candidate) => candidate === executable,
    runCommandImpl: async (spec) => spec.args[0] === '--version'
      ? { exitCode: 0, stdout: 'grok 1.0.30\n', stderr: '' }
      : { exitCode: 0, stdout: '  * grok-4.6\n', stderr: '' }
  });
  assert.ok(result.supportedFeatures.includes('filesystem-policy'));
  assert.equal(result.supportedFeatures.includes('os-sandbox'), false);
});

test('failure classification distinguishes operational causes', () => {
  assert.equal(classifyProviderFailure({ result: { timedOut: true } }), 'timeout');
  assert.equal(classifyProviderFailure({ result: { stderr: 'authentication required' } }), 'authentication');
  assert.equal(classifyProviderFailure({ result: { stderr: 'usage quota exhausted' } }), 'rate-limit');
  assert.equal(classifyProviderFailure({ result: { stderr: 'fetch failed: ECONNRESET' } }), 'network');
  assert.equal(classifyProviderFailure({ error: Object.assign(new Error('bad envelope'), { failureKind: 'protocol' }) }), 'protocol');
  assert.equal(classifyProviderFailure({ error: Object.assign(new Error('permission'), { failureKind: 'action-required' }) }), 'action-required');
  assert.equal(classifyProviderFailure({ result: { stderr: 'unknown CLI failure' } }), 'execution');
});
