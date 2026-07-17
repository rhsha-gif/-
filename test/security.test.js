import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBoundedRegularFile, redactSecrets, redactValue } from '../src/security.js';

const SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';

test('redacts common credentials before evidence persistence', () => {
  const source = [
    `Authorization: Bearer ${SECRET}`,
    `OPENAI_API_KEY=${SECRET}`,
    `tool --api-key ${SECRET}`,
    'https://user:password@example.com/path',
    '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----'
  ].join('\n');
  const redacted = redactSecrets(source);
  assert.doesNotMatch(redacted, new RegExp(SECRET));
  assert.doesNotMatch(redacted, /user:password@/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.match(redacted, /\[REDACTED/);
});

test('redacts nested evidence objects without mutating the input', () => {
  const input = { summary: `token=${SECRET}`, nested: [{ password: 'hunter2' }], count: 3 };
  const output = redactValue(input);
  assert.equal(input.nested[0].password, 'hunter2');
  assert.doesNotMatch(JSON.stringify(output), new RegExp(`${SECRET}|hunter2`));
  assert.equal(output.count, 3);
});

test('bounded receipt reads reject oversized, symbolic-linked, and hard-linked files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-secure-read-'));
  const normal = path.join(root, 'normal.json');
  await writeFile(normal, '{"ok":true}');
  assert.equal((await readBoundedRegularFile(normal, { maxBytes: 1024 })).toString(), '{"ok":true}');

  const oversized = path.join(root, 'oversized.json');
  await writeFile(oversized, 'x'.repeat(2048));
  await assert.rejects(() => readBoundedRegularFile(oversized, { maxBytes: 1024 }), /size limit/i);

  if (process.platform !== 'win32') {
    const symbolic = path.join(root, 'symbolic.json');
    await symlink(normal, symbolic);
    await assert.rejects(() => readBoundedRegularFile(symbolic, { maxBytes: 1024 }), /symbolic link|regular file/i);
    const hard = path.join(root, 'hard.json');
    await link(normal, hard);
    await assert.rejects(() => readBoundedRegularFile(hard, { maxBytes: 1024 }), /hard link|link count/i);
  } else {
    t.diagnostic('link checks skipped on Windows');
  }
});

test('redactSecrets covers compound key names and equals-form flags', () => {
  assert.equal(
    redactSecrets('{"access_token": "eyJhbGciOi.secret.value"}'),
    '{"access_token": "[REDACTED]"}'
  );
  assert.equal(
    redactSecrets('{"client_secret": "abc123def"}'),
    '{"client_secret": "[REDACTED]"}'
  );
  assert.equal(
    redactSecrets('{"refresh_token": "with \\" escaped quote"}'),
    '{"refresh_token": "[REDACTED]"}'
  );
  assert.equal(
    redactSecrets('mycli --token=supersecretvalue123 run'),
    'mycli --token=[REDACTED] run'
  );
  assert.equal(
    redactSecrets('mycli --access-token secretvalue run'),
    'mycli --access-token [REDACTED] run'
  );
});

test('classifyPrompt keeps high-risk development high-risk despite a clause-scoped read-only negation', async () => {
  const { classifyPrompt } = await import('../integrations/shared/gate.mjs');
  const demoted = classifyPrompt('Fix the authentication bypass in the login handler, but do not modify the config file.');
  assert.equal(demoted.requestClass, 'high-risk');
  assert.equal(demoted.failPolicy, 'closed');
  const korean = classifyPrompt('결제 검증 로직을 고쳐줘. 단 config 파일은 수정하지 마.');
  assert.equal(korean.requestClass, 'high-risk');
  const explanation = classifyPrompt('인증 구조를 설명하되 수정하지 말라');
  assert.equal(explanation.requestClass, 'read-only');
  const genuineReadOnly = classifyPrompt('Analyze the auth flow, do not modify anything');
  assert.equal(genuineReadOnly.requestClass, 'read-only');
});

test('redactValue redacts a secret held in an array or nested object under a sensitive key', () => {
  const output = redactValue({
    credentials: { data: 'PlainSecretValueNoPattern' },
    sessionToken: ['plain-one', 'plain-two'],
    apiKey: 'plainkey',
    summary: { note: 'keep this visible' },
    count: 7
  });
  assert.equal(output.credentials, '[REDACTED]');
  assert.equal(output.sessionToken, '[REDACTED]');
  assert.equal(output.apiKey, '[REDACTED]');
  // Non-sensitive content is preserved.
  assert.deepEqual(output.summary, { note: 'keep this visible' });
  assert.equal(output.count, 7);
  assert.doesNotMatch(JSON.stringify(output), /PlainSecretValueNoPattern|plain-one|plainkey/);
});
