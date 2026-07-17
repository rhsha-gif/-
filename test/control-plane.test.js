import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertProtectedChangePolicy, configuredProtectedFiles } from '../src/control-plane.js';

const approval = {
  runId: 'R-source',
  proposalId: 'P1',
  proposal: { affectedFiles: ['.aorch/config.json', '.claude/settings.json'] }
};

test('protected control-plane files require bounded approved scope', () => {
  const protectedFiles = ['.aorch/config.json', '.claude/settings.json'];
  assert.deepEqual(assertProtectedChangePolicy({ task: { controlPlaneChange: false }, changedPaths: ['src/app.js'], protectedFiles, approval: null }), { protectedChanged: [] });
  assert.throws(() => assertProtectedChangePolicy({
    task: { controlPlaneChange: false }, changedPaths: ['.aorch/config.json'], protectedFiles, approval: null
  }), /protected control-plane files/i);
  assert.throws(() => assertProtectedChangePolicy({
    task: { controlPlaneChange: true }, changedPaths: ['.aorch/config.json', '.claude/settings.json'], protectedFiles,
    approval: { ...approval, proposal: { affectedFiles: ['.aorch/config.json'] } }
  }), /exceeds approved proposal files/i);
  assert.deepEqual(assertProtectedChangePolicy({
    task: { controlPlaneChange: true }, changedPaths: ['.aorch/config.json'], protectedFiles, approval
  }).protectedChanged, ['.aorch/config.json']);
});

test('configured protected files include the active project config without escaping the project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-protected-files-'));
  const files = configuredProtectedFiles({
    config: { _configPath: path.join(cwd, '.aorch/config.json'), controlPlane: { protectedFiles: ['.claude/settings.json'] } },
    cwd,
    stateRoot: path.join(cwd, '.aorch')
  });
  assert.deepEqual(files, [
    '.aorch/config.json',
    '.aorch/learning/lessons.json',
    '.aorch/observations.jsonl',
    '.claude/settings.json'
  ]);
});

test('route observations and lesson memory are protected change surfaces by default', () => {
  const config = { controlPlane: { protectedFiles: [] }, paths: { stateDir: '.aorch', observationsFile: '.aorch/observations.jsonl' } };
  const files = configuredProtectedFiles({ config, cwd: '/project', stateRoot: '/project/.aorch' });
  assert.ok(files.includes('.aorch/observations.jsonl'), files.join(','));
  assert.ok(files.includes('.aorch/learning/lessons.json'), files.join(','));
});
