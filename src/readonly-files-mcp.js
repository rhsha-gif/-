#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { lstat, readFile, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 48 * 1024;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_READ_LINES = 1000;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 20;
const MAX_RETURN_PATH_CHARS = 1024;
const MAX_VISITED_ENTRIES = 2000;
const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const TOOLS = Object.freeze([
  {
    name: 'read_file',
    description: 'Read bounded lines from a UTF-8 text file under the project root. offset is 1-based.',
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'list_directory',
    description: 'List a bounded number of non-sensitive entries in a directory under the project root.',
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_DIRECTORY_ENTRIES }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_files',
    description: 'Search UTF-8 text files under a project subdirectory for a plain string.',
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        path: { type: 'string' },
        maxMatches: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_MATCHES }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
]);

class SafeRequestError extends Error {}

function safeError(message) {
  return new SafeRequestError(message);
}

function sensitiveSegment(segment) {
  return /^\.env/iu.test(segment)
    || ['.git', '.ssh', '.npmrc', '.pypirc', '.netrc'].includes(segment.toLowerCase())
    || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|api[_-]?keys?)(?:[._-]|$)/iu.test(segment)
    || /(?:^|[._-])(?:id_(?:rsa|dsa|ecdsa|ed25519)|private[_-]?key)(?:[._-]|$)/iu.test(segment)
    || /\.(?:pem|key|p12|pfx)$/iu.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment);
}

function pathSegments(value) {
  return String(value).split(/[\\/]+/u).filter(Boolean);
}

function assertSafeRelativePath(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw safeError('A relative path is required.');
  if (value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw safeError('Absolute paths are unavailable.');
  }
  const segments = pathSegments(value);
  if (segments.includes('..')) throw safeError('Parent traversal is unavailable.');
  if (segments.some((segment) => segment.includes(':'))) throw safeError('Alternate path namespaces are unavailable.');
  if (segments.some(sensitiveSegment)) throw safeError('Sensitive paths are unavailable.');
  return value === '' ? '.' : value;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertResolvedPath(root, resolved) {
  if (!contained(root, resolved)) throw safeError('The resolved path leaves the project root.');
  const relative = path.relative(root, resolved);
  if (pathSegments(relative).some(sensitiveSegment)) throw safeError('Sensitive paths are unavailable.');
}

async function resolveExisting(root, relative, expected) {
  const safeRelative = assertSafeRelativePath(relative, { allowEmpty: true });
  const candidate = path.resolve(root, safeRelative);
  if (!contained(root, candidate)) throw safeError('The requested path leaves the project root.');
  let resolved;
  let info;
  try {
    resolved = await realpath(candidate);
    assertResolvedPath(root, resolved);
    info = await stat(resolved);
  } catch (error) {
    if (error instanceof SafeRequestError) throw error;
    throw safeError('The requested path is unavailable.');
  }
  if (expected === 'file' && !info.isFile()) throw safeError('The requested path is not a regular file.');
  if (expected === 'directory' && !info.isDirectory()) throw safeError('The requested path is not a directory.');
  return { relative: safeRelative, resolved, info };
}

function objectArguments(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safeError('Tool arguments must be an object.');
  return value;
}

function onlyKeys(value, keys) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw safeError('Tool arguments contain an unsupported field.');
}

function boundedInteger(value, fallback, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) throw safeError('A numeric argument is outside its allowed range.');
  return resolved;
}

function boundedText(value) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= MAX_CONTENT_BYTES) return { value, truncated: false };
  return {
    value: encoded.subarray(0, MAX_CONTENT_BYTES).toString('utf8').replace(/\uFFFD$/u, ''),
    truncated: true
  };
}

function returnedPath(root, resolved) {
  const relative = path.relative(root, resolved).split(path.sep).join('/') || '.';
  if (relative.length > MAX_RETURN_PATH_CHARS) throw safeError('The requested path exceeds the return limit.');
  return relative;
}

async function readTextFile(root, relative) {
  const target = await resolveExisting(root, relative, 'file');
  if (target.info.size > MAX_FILE_BYTES) throw safeError('The requested file exceeds the size limit.');
  let buffer;
  try { buffer = await readFile(target.resolved); }
  catch { throw safeError('The requested file could not be read.'); }
  if (buffer.includes(0)) throw safeError('Binary files are unavailable.');
  return { ...target, text: buffer.toString('utf8') };
}

export async function readFileTool(root, rawArguments) {
  const args = objectArguments(rawArguments);
  onlyKeys(args, ['path', 'offset', 'limit']);
  if (typeof args.path !== 'string' || args.path.length === 0) throw safeError('A relative file path is required.');
  const offset = boundedInteger(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(args.limit, 200, 1, MAX_READ_LINES);
  const file = await readTextFile(root, args.path);
  const lines = file.text.split(/\r?\n/u);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const bounded = boundedText(selected.join('\n'));
  return {
    path: returnedPath(root, file.resolved),
    startLine: offset,
    endLine: selected.length === 0 ? offset - 1 : offset + selected.length - 1,
    totalLines: lines.length,
    truncated: bounded.truncated || offset - 1 + selected.length < lines.length,
    content: bounded.value
  };
}

function entryType(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

export async function listDirectoryTool(root, rawArguments) {
  const args = objectArguments(rawArguments);
  onlyKeys(args, ['path', 'limit']);
  const relative = args.path ?? '.';
  if (typeof relative !== 'string') throw safeError('A relative directory path is required.');
  const limit = boundedInteger(args.limit, MAX_DIRECTORY_ENTRIES, 1, MAX_DIRECTORY_ENTRIES);
  const directory = await resolveExisting(root, relative, 'directory');
  let allEntries;
  try { allEntries = await boundedEntries(directory.resolved, MAX_VISITED_ENTRIES); }
  catch { throw safeError('The requested directory could not be listed.'); }
  const visible = allEntries
    .filter((entry) => !sensitiveSegment(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return {
    path: returnedPath(root, directory.resolved),
    entries: visible.slice(0, limit).map((entry) => ({ name: entry.name, type: entryType(entry) })),
    truncated: visible.length > limit || allEntries.length >= MAX_VISITED_ENTRIES
  };
}

async function boundedEntries(directory, limit) {
  const entries = [];
  for await (const entry of await opendir(directory)) {
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

function safeExcerpt(line, queryIndex, queryLength) {
  const start = Math.max(0, queryIndex - 120);
  return line.slice(start, start + Math.max(300, queryLength)).replaceAll('\0', '');
}

export async function searchFilesTool(root, rawArguments) {
  const args = objectArguments(rawArguments);
  onlyKeys(args, ['query', 'path', 'maxMatches']);
  if (typeof args.query !== 'string' || args.query.length === 0 || args.query.length > 200) {
    throw safeError('A plain search query between 1 and 200 characters is required.');
  }
  const maxMatches = boundedInteger(args.maxMatches, MAX_SEARCH_MATCHES, 1, MAX_SEARCH_MATCHES);
  const start = await resolveExisting(root, args.path ?? '.', 'directory');
  const queue = [{ directory: start.resolved, depth: 0 }];
  const matches = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let bounded = false;
  let visitedEntries = 0;
  const needle = args.query.toLowerCase();

  while (queue.length > 0 && matches.length < maxMatches) {
    if (visitedEntries >= MAX_VISITED_ENTRIES) { bounded = true; break; }
    const current = queue.shift();
    let entries;
    try { entries = await boundedEntries(current.directory, MAX_VISITED_ENTRIES - visitedEntries); }
    catch { continue; }
    visitedEntries += entries.length;
    if (visitedEntries >= MAX_VISITED_ENTRIES) bounded = true;
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (sensitiveSegment(entry.name) || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const candidate = path.join(current.directory, entry.name);
      let actual;
      try { actual = await realpath(candidate); assertResolvedPath(root, actual); }
      catch { continue; }
      if (entry.isDirectory()) {
        if (current.depth < MAX_SEARCH_DEPTH) queue.push({ directory: actual, depth: current.depth + 1 });
        else bounded = true;
        continue;
      }
      if (!entry.isFile()) continue;
      if (filesScanned >= MAX_SEARCH_FILES) { bounded = true; break; }
      let info;
      try { info = await lstat(actual); }
      catch { continue; }
      if (!info.isFile() || info.size > MAX_FILE_BYTES || bytesScanned + info.size > MAX_SEARCH_BYTES) {
        bounded = true;
        continue;
      }
      filesScanned += 1;
      bytesScanned += info.size;
      let buffer;
      try { buffer = await readFile(actual); }
      catch { continue; }
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const matchIndex = lines[index].toLowerCase().indexOf(needle);
        if (matchIndex === -1) continue;
        let resultPath;
        try { resultPath = returnedPath(root, actual); }
        catch { bounded = true; continue; }
        matches.push({
          path: resultPath,
          line: index + 1,
          excerpt: safeExcerpt(lines[index], matchIndex, args.query.length)
        });
        if (matches.length >= maxMatches) break;
      }
    }
  }
  return { matches, filesScanned, truncated: bounded || matches.length >= maxMatches };
}

function toolSuccess(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_RESULT_BYTES) {
    return toolFailure(safeError('The tool result exceeds the output limit.'));
  }
  return { content: [{ type: 'text', text }] };
}

function toolFailure(error) {
  const message = error instanceof SafeRequestError ? error.message : 'The read-only filesystem request failed.';
  return { content: [{ type: 'text', text: `Request blocked: ${message}` }], isError: true };
}

export function createReadonlyFilesServer(root) {
  return async function handle(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { error: { code: -32600, message: 'Invalid Request' } };
    }
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'ping') return { result: {} };
    if (request.method === 'initialize') {
      const requestedVersion = request.params?.protocolVersion;
      return {
        result: {
          protocolVersion: typeof requestedVersion === 'string' ? requestedVersion : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aorch-readonly-files', version: '1.0.0' }
        }
      };
    }
    if (request.method === 'tools/list') return { result: { tools: TOOLS } };
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      try {
        if (name === 'read_file') return { result: toolSuccess(await readFileTool(root, request.params?.arguments)) };
        if (name === 'list_directory') return { result: toolSuccess(await listDirectoryTool(root, request.params?.arguments)) };
        if (name === 'search_files') return { result: toolSuccess(await searchFilesTool(root, request.params?.arguments)) };
        return { result: toolFailure(safeError('Unknown tool.')) };
      } catch (error) {
        return { result: toolFailure(error) };
      }
    }
    return { error: { code: -32601, message: 'Method not found' } };
  };
}

function parseRootArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--root' || !path.isAbsolute(argv[1])) {
    throw new Error('--root must name one absolute project directory');
  }
  const resolved = realpathSync(argv[1]);
  return resolved;
}

export function runStdioServer(root, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createReadonlyFilesServer(root);
  let buffer = '';
  let chain = Promise.resolve();
  const send = (id, payload) => {
    if (id === undefined) return;
    output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
  };
  const consume = (line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
      send(null, { error: { code: -32700, message: 'Parse error' } });
      return;
    }
    let request;
    try { request = JSON.parse(line); }
    catch {
      send(null, { error: { code: -32700, message: 'Parse error' } });
      return;
    }
    chain = chain.then(async () => {
      const response = await handle(request);
      const hasId = request && typeof request === 'object' && !Array.isArray(request)
        && Object.hasOwn(request, 'id');
      const responseId = hasId ? request.id : (response?.error?.code === -32600 ? null : undefined);
      if (response !== null) send(responseId, response);
    }).catch(() => send(request?.id ?? null, { error: { code: -32603, message: 'Internal error' } }));
  };
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') consume(line);
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_RPC_LINE_BYTES) {
      buffer = '';
      send(null, { error: { code: -32700, message: 'Parse error' } });
    }
  });
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isEntrypoint()) {
  try {
    const root = parseRootArgument(process.argv.slice(2));
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error('root is not a directory');
    runStdioServer(root);
  } catch {
    process.stderr.write('readonly-files-mcp: --root must name one accessible absolute project directory\n');
    process.exitCode = 2;
  }
}
