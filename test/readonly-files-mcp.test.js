import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/readonly-files-mcp.js', import.meta.url));

async function projectFixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aorch-readonly-mcp-'));
  const root = path.join(temporary, '한글 프로젝트 공간');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, '문서.txt'), '첫째 줄\n둘째 줄 needle 한글\n셋째 줄\n');
  await writeFile(path.join(root, 'other.txt'), 'another needle\n');
  await writeFile(path.join(root, '.env.test'), 'ENV_SENTINEL=never-return\n');
  await writeFile(path.join(root, 'credentials.json'), '{"secret":"CREDENTIAL_SENTINEL"}\n');
  await writeFile(path.join(root, 'my-credentials.backup'), 'CREDENTIAL_ALIAS_SENTINEL\n');
  await writeFile(path.join(root, '.git', 'config'), 'GIT_SENTINEL\n');
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, root };
}

function startClient(t, root) {
  const child = spawn(process.execPath, [SERVER, '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  const messages = [];
  const waiters = [];

  function deliver(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) messages.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  }

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline).replace(/\r$/u, '');
      stdout = stdout.slice(newline + 1);
      if (line) deliver(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => {
    const error = new Error(`MCP child exited unexpectedly (${code}): ${stderr}`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  function next(predicate) {
    const existing = messages.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(messages.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for MCP response: ${stderr}`));
      }, 5000);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      waiter.reject = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return next((message) => message.id === id);
  };
  const callTool = async (id, name, args) => request(id, 'tools/call', { name, arguments: args });

  t.after(async () => {
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      const timer = setTimeout(() => child.kill(), 500);
      await closed;
      clearTimeout(timer);
    }
  });
  return { child, send, request, callTool, next, writeRaw: (value) => child.stdin.write(value) };
}

function toolPayload(response) {
  assert.equal(response.result.isError, undefined);
  return JSON.parse(response.result.content[0].text);
}

test('stdio MCP handshakes and provides bounded read, list, and plain search tools', async (t) => {
  const { root } = await projectFixture(t);
  const client = startClient(t, root);

  const initialized = await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' }
  });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'aorch-readonly-files');
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await client.request(2, 'ping')).result, {});

  const listedTools = await client.request(3, 'tools/list');
  assert.deepEqual(listedTools.result.tools.map((tool) => tool.name), [
    'read_file', 'list_directory', 'search_files'
  ]);
  for (const tool of listedTools.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  }

  const read = toolPayload(await client.callTool(4, 'read_file', {
    path: '문서.txt', offset: 2, limit: 1
  }));
  assert.equal(read.content, '둘째 줄 needle 한글');
  assert.equal(read.startLine, 2);
  assert.equal(read.endLine, 2);
  assert.equal(read.truncated, true);

  const directory = toolPayload(await client.callTool(5, 'list_directory', { path: '.', limit: 20 }));
  assert.ok(directory.entries.some((entry) => entry.name === '문서.txt' && entry.type === 'file'));
  assert.equal(directory.entries.some((entry) => ['.env.test', 'credentials.json', 'my-credentials.backup', '.git'].includes(entry.name)), false);

  const search = toolPayload(await client.callTool(6, 'search_files', {
    query: 'needle', path: '.', maxMatches: 10
  }));
  assert.deepEqual(search.matches.map((entry) => entry.path), ['other.txt', '문서.txt']);
  assert.equal(search.matches[1].line, 2);
  assert.match(search.matches[1].excerpt, /needle 한글/u);
  assert.equal(search.filesScanned, 2);

  await writeFile(path.join(root, 'bounded.txt'), `${'x'.repeat(100)}\n`.repeat(1000));
  const bounded = toolPayload(await client.callTool(7, 'read_file', {
    path: 'bounded.txt', offset: 1, limit: 1000
  }));
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.content.length <= 64 * 1024);
});

test('stdio MCP returns sanitized errors for malformed, unknown, escaping, and sensitive requests', async (t) => {
  const { temporary, root } = await projectFixture(t);
  const outside = path.join(temporary, 'outside.txt');
  await writeFile(outside, 'OUTSIDE_SENTINEL\n');
  await writeFile(path.join(root, 'oversize.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  const link = path.join(root, 'escape-link.txt');
  let linkCreated = true;
  try { await symlink(outside, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) linkCreated = false;
    else throw error;
  }
  const outsideDirectory = path.join(temporary, 'outside-directory');
  const linkedDirectory = path.join(root, 'escape-directory');
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, 'nested.txt'), 'JUNCTION_SENTINEL\n');
  let directoryLinkCreated = true;
  try {
    await symlink(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) directoryLinkCreated = false;
    else throw error;
  }

  const client = startClient(t, root);
  client.writeRaw('{malformed\n');
  const malformed = await client.next((message) => message.id === null);
  assert.equal(malformed.error.code, -32700);
  assert.equal(malformed.error.message, 'Parse error');

  client.send({});
  const invalid = await client.next((message) => message.id === null);
  assert.equal(invalid.error.code, -32600);
  assert.equal(invalid.error.message, 'Invalid Request');

  const unknownMethod = await client.request(10, 'filesystem/read', {});
  assert.equal(unknownMethod.error.code, -32601);

  const unknownTool = await client.callTool(11, 'write_file', { path: 'x' });
  assert.equal(unknownTool.result.isError, true);
  assert.equal(unknownTool.result.content[0].text, 'Request blocked: Unknown tool.');

  const blocked = [];
  blocked.push(await client.callTool(12, 'read_file', { path: '../outside.txt' }));
  blocked.push(await client.callTool(13, 'read_file', { path: outside }));
  blocked.push(await client.callTool(14, 'read_file', { path: '.env.test' }));
  blocked.push(await client.callTool(15, 'read_file', { path: 'credentials.json' }));
  blocked.push(await client.callTool(16, 'read_file', { path: '.git/config' }));
  blocked.push(await client.callTool(17, 'read_file', { path: 'my-credentials.backup' }));
  blocked.push(await client.callTool(18, 'read_file', { path: 'oversize.txt' }));
  blocked.push(await client.callTool(19, 'read_file', { path: '문서.txt', extra: true }));
  if (linkCreated) blocked.push(await client.callTool(20, 'read_file', { path: 'escape-link.txt' }));
  if (directoryLinkCreated) blocked.push(await client.callTool(21, 'read_file', { path: 'escape-directory/nested.txt' }));
  if (!linkCreated && !directoryLinkCreated) t.diagnostic('symlink/junction creation is unavailable; escape case skipped');
  let sensitiveId = 30;
  for (const sensitivePath of ['token.json', 'api-key.txt', 'api_key.json', '.npmrc', '.pypirc', '.netrc', '.ssh/config']) {
    const response = await client.callTool(sensitiveId++, 'read_file', { path: sensitivePath });
    assert.match(response.result.content[0].text, /Sensitive/i);
    blocked.push(response);
  }

  for (const response of blocked) {
    assert.equal(response.result.isError, true);
    const text = response.result.content[0].text;
    assert.match(text, /^Request blocked:/u);
    assert.doesNotMatch(text, /SENTINEL|Error:| at |outside\.txt/u);
  }
});

test('directory traversal bounds count empty entries as well as readable files', async t => {
  const { root } = await projectFixture(t);
  const wide = path.join(root, 'wide');
  await mkdir(wide);
  for (let batch = 0; batch < 21; batch++) {
    await Promise.all(Array.from({length:100}, (_,i) => mkdir(path.join(wide, `empty-${batch * 100 + i}`))));
  }
  const client = startClient(t, root);
  const listed = await client.callTool(100, 'list_directory', {path:'wide'});
  const searched = await client.callTool(101, 'search_files', {path:'wide',query:'absent'});
  assert.match(listed.result.content[0].text, /"truncated":true/);
  assert.match(searched.result.content[0].text, /"truncated":true/);
});
