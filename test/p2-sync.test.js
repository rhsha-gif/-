import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentHash, syncGeneratedFiles } from '../src/definition-sync.js';
import { isSkillCachePath } from '../src/skill-cache.js';

test('cache classification includes Python caches without excluding authored files', () => {
  for (const p of ['scripts/__pycache__/x.pyc', '.pytest_cache/v/cache', 'x.pyo']) assert.ok(isSkillCachePath(p));
  for (const p of ['scripts/x.py', 'tests/test_x.py', 'data/cache.json']) assert.equal(isSkillCachePath(p), false);
});

test('edited skill caches are released without deletion, check is read-only, second apply is current', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-cache-release-'));
  const file = { path: 'skill/__pycache__/x.pyc', content: 'old', definitionId: 'skill:sample' };
  await syncGeneratedFiles({ root, files: [file] });
  await writeFile(path.join(root, file.path), 'runtime');
  const ledger = await readFile(path.join(root, '.aorch/generated-files.json'), 'utf8');
  const check = await syncGeneratedFiles({ root, files: [], check: true });
  assert.deepEqual(check.released, [file.path]);
  assert.equal(await readFile(path.join(root, '.aorch/generated-files.json'), 'utf8'), ledger);
  const result = await syncGeneratedFiles({ root, files: [] });
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(path.join(root, file.path), 'utf8'), 'runtime');
  assert.equal(await readFile(path.join(result.backup, 'previous-ledger.json'), 'utf8'), ledger);
  assert.equal((await syncGeneratedFiles({ root, files: [] })).status, 'current');
});

test('reconciliation requires both hashes and saves the edited copy for rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-reconcile-'));
  const files = [{ path: 'skill/SKILL.md', content: 'original', definitionId: 'skill:sample' }];
  await syncGeneratedFiles({ root, files });
  await writeFile(path.join(root, files[0].path), 'user change');
  files[0].content = 'merged';
  const reconcile = { version: 1, root, files: [{ path: files[0].path, currentHash: contentHash('user change'), desiredHash: contentHash('merged') }] };
  for (const key of ['currentHash', 'desiredHash']) {
    const wrong = structuredClone(reconcile); wrong.files[0][key] = contentHash('wrong');
    assert.equal((await syncGeneratedFiles({ root, files, reconcile: wrong })).status, 'conflict');
    assert.equal(await readFile(path.join(root, files[0].path), 'utf8'), 'user change');
  }
  assert.equal((await syncGeneratedFiles({ root, files, reconcile, check: true })).status, 'stale');
  const result = await syncGeneratedFiles({ root, files, reconcile });
  assert.equal(await readFile(path.join(result.backup, files[0].path), 'utf8'), 'user change');
  assert.equal(await readFile(path.join(root, files[0].path), 'utf8'), 'merged');
  assert.equal((await syncGeneratedFiles({ root, files })).status, 'current');
  await assert.rejects(syncGeneratedFiles({ root, files, reconcile: { ...reconcile, root: path.dirname(root) } }), /matching root/);
});

test('a new unapproved conflict blocks all reconciled writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-reconcile-'));
  const files = ['a', 'b'].map(p => ({ path: p, content: 'old' }));
  await syncGeneratedFiles({ root, files });
  for (const f of files) { await writeFile(path.join(root, f.path), 'edit'); f.content = 'new'; }
  const reconcile = { version: 1, root, files: [{ path: 'a', currentHash: contentHash('edit'), desiredHash: contentHash('new') }] };
  assert.equal((await syncGeneratedFiles({ root, files, reconcile })).status, 'conflict');
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'edit');
});

test('a reviewed installed asset outside the old ledger is adopted only with both hashes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-new-asset-'));
  await writeFile(path.join(root, 'new-test.py'), 'user test');
  const files = [{ path: 'new-test.py', content: 'merged test' }];
  assert.equal((await syncGeneratedFiles({ root, files })).status, 'conflict');
  const reconcile = { version: 1, root, files: [{ path: 'new-test.py', currentHash: contentHash('user test'), desiredHash: contentHash('merged test') }] };
  const result = await syncGeneratedFiles({ root, files, reconcile });
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(path.join(result.backup, 'new-test.py'), 'utf8'), 'user test');
});
