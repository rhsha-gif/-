// Bootstrap-only host policy evaluated on PreToolUse events. This module is
// vendored into .aorch/hooks/ at install time, so it must stay dependency-free
// (node built-ins only) and identical between package and installed copies.
//
// The hook is a workflow guardrail, not an OS sandbox: worker transports keep
// their own sandbox/worktree enforcement.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const INBOX_PREFIX = '.aorch/inbox/';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'create_file', 'str_replace_editor']);
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const MANAGED_WORKER_AGENT = 'aorch-worker';
const PERMIT_MARKER = /\[aorch-permit:([A-Za-z0-9-]+)\]/;

const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame']);
const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'which', 'find']);
// Shell features that can smuggle a mutation through an otherwise read-only
// command line. Denied outright; aorch commands never need them.
const SHELL_ESCAPE_PATTERN = /[><|;&`\n]|\$\(/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function deny(reason) {
  return { allowed: false, reason };
}

function allow(reason = 'allowed by bootstrap-only host policy') {
  return { allowed: true, reason };
}

function normalizeProjectPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim().replaceAll('\\', '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) return null;
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function isProtected(filePath, protectedFiles) {
  return protectedFiles.some((entry) => filePath === entry || filePath.startsWith(`${entry}/`));
}

function evaluateWritePath(rawPath, protectedFiles) {
  const filePath = normalizeProjectPath(rawPath);
  if (!filePath) return deny('host writes must target project-relative paths');
  if (isProtected(filePath, protectedFiles)) return deny(`protected control-plane file: ${filePath}`);
  if (!filePath.startsWith(INBOX_PREFIX)) {
    return deny(`bootstrap-only host cannot edit product files (${filePath}); write a task envelope to ${INBOX_PREFIX} and delegate to a worker`);
  }
  return allow('task envelope write inside .aorch/inbox/');
}

function patchFilePaths(patchText) {
  if (typeof patchText !== 'string') return null;
  const paths = new Set();
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.add(match[1].trim());
  }
  for (const match of patchText.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) {
    paths.add(match[1].trim());
  }
  return paths.size > 0 ? [...paths] : null;
}

function evaluateApplyPatch(toolInput, protectedFiles) {
  const patchText = toolInput?.input ?? toolInput?.patch ?? toolInput?.content;
  const paths = patchFilePaths(patchText);
  if (!paths) return deny('apply_patch content has no recognizable file targets; failing closed');
  for (const rawPath of paths) {
    const result = evaluateWritePath(rawPath, protectedFiles);
    if (!result.allowed) return result;
  }
  return allow('patch touches only .aorch/inbox/ task envelopes');
}

function evaluateBash(command) {
  if (typeof command !== 'string' || command.trim() === '') return deny('empty host command');
  const trimmed = command.trim();
  if (SHELL_ESCAPE_PATTERN.test(trimmed)) {
    return deny('host shell may not use redirection, pipes, chaining, or command substitution');
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    return deny('host shell may not set environment variables (AORCH_WORKER and credentials are not forgeable)');
  }
  const tokens = trimmed.split(/\s+/);
  const executable = tokens[0];
  if (executable === 'aorch') return allow('aorch command');
  if (executable === 'export' || executable === 'env' || executable === 'set') {
    return deny('host shell may not modify the environment');
  }
  if (executable === 'git') {
    const subcommand = tokens[1];
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return allow(`read-only git ${subcommand}`);
    return deny(`git ${subcommand ?? ''} mutates state; delegate to a worker`);
  }
  if (executable === 'node' || executable === 'npm' || executable === 'npx') {
    if (tokens[1] === '--version' || tokens[1] === '-v') return allow('version probe');
    return deny(`${executable} execution from the host is not allowed; delegate to a worker`);
  }
  if (READ_ONLY_COMMANDS.has(executable)) {
    if (executable === 'find' && tokens.some((token) => token === '-delete' || token === '-exec' || token === '-execdir' || token === '-ok')) {
      return deny('find with -delete/-exec mutates state');
    }
    return allow(`read-only ${executable}`);
  }
  return deny(`command ${executable} is not in the bootstrap-only host allowlist`);
}

async function loadPermit(stateRoot, permitId) {
  const permitPath = path.join(stateRoot, 'dispatch', `${permitId}.json`);
  try {
    return { permitPath, permit: JSON.parse(await readFile(permitPath, 'utf8')) };
  } catch {
    return { permitPath, permit: null };
  }
}

async function consumePermit(permitPath, permit) {
  const consumed = { ...permit, consumed: true, consumedAt: new Date().toISOString() };
  const tempPath = `${permitPath}.consuming`;
  await writeFile(tempPath, JSON.stringify(consumed, null, 2), { mode: 0o600 });
  await rename(tempPath, permitPath);
}

async function evaluateAgentInvocation(toolInput, stateRoot) {
  const subagentType = toolInput?.subagent_type ?? toolInput?.subagentType ?? toolInput?.agent;
  if (subagentType !== MANAGED_WORKER_AGENT) {
    return deny(`host may only invoke the managed ${MANAGED_WORKER_AGENT} agent with a dispatch permit`);
  }
  const prompt = typeof toolInput?.prompt === 'string' ? toolInput.prompt : '';
  const marker = prompt.match(PERMIT_MARKER);
  if (!marker) return deny('agent invocation carries no aorch dispatch permit marker');
  const { permitPath, permit } = await loadPermit(stateRoot, marker[1]);
  if (!permit) return deny('dispatch permit not found');
  if (permit.consumed === true) return deny('dispatch permit was already consumed');
  if (typeof permit.expiresAt !== 'string' || Date.parse(permit.expiresAt) <= Date.now()) {
    return deny('dispatch permit is expired');
  }
  if (permit.subagentType !== subagentType) return deny('dispatch permit binds a different agent');
  for (const field of ['model', 'effort']) {
    const requested = toolInput?.[field];
    if (requested !== undefined && permit[field] !== undefined && requested !== permit[field]) {
      return deny(`dispatch permit binds ${field}=${permit[field]}, not ${requested}`);
    }
  }
  const expectedHash = sha256({
    runId: permit.runId, taskId: permit.taskId, provider: permit.provider,
    profileId: permit.profileId, model: permit.model, effort: permit.effort,
    subagentType: permit.subagentType
  });
  if (permit.bindingHash !== expectedHash) return deny('dispatch permit binding hash mismatch');
  await consumePermit(permitPath, permit);
  return allow(`dispatch permit ${permit.id} consumed for ${MANAGED_WORKER_AGENT}`);
}

export async function evaluateHostToolUse(input, {
  projectRoot = process.cwd(),
  protectedFiles = [],
  stateRoot = path.join(projectRoot, '.aorch')
} = {}) {
  const toolName = input?.tool_name ?? input?.toolName ?? input?.tool;
  const toolInput = input?.tool_input ?? input?.toolInput ?? {};
  if (typeof toolName !== 'string' || toolName.trim() === '') return deny('missing tool name');

  if (READ_ONLY_TOOLS.has(toolName)) return allow(`read-only tool ${toolName}`);
  if (WRITE_TOOLS.has(toolName)) {
    return evaluateWritePath(toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path, protectedFiles);
  }
  if (toolName === 'apply_patch') return evaluateApplyPatch(toolInput, protectedFiles);
  if (toolName === 'Bash' || toolName === 'shell' || toolName === 'bash') {
    return evaluateBash(toolInput.command ?? toolInput.cmd);
  }
  if (AGENT_TOOLS.has(toolName)) return evaluateAgentInvocation(toolInput, stateRoot);
  return deny(`tool ${toolName} is not permitted for the bootstrap-only host`);
}

// Issued by aorch before dispatching the managed native worker. One permit
// authorizes exactly one Agent invocation matching its binding.
export async function createDispatchPermit({
  root,
  runId,
  taskId,
  provider,
  profileId,
  model,
  effort,
  ttlMs = 5 * 60 * 1000
}) {
  for (const [name, value] of [['root', root], ['runId', runId], ['taskId', taskId]]) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`dispatch permit requires ${name}`);
  }
  const id = randomUUID();
  const permit = {
    id,
    subagentType: MANAGED_WORKER_AGENT,
    runId,
    taskId,
    provider: provider ?? null,
    profileId: profileId ?? null,
    model: model ?? null,
    effort: effort ?? null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    consumed: false
  };
  permit.bindingHash = sha256({
    runId: permit.runId, taskId: permit.taskId, provider: permit.provider,
    profileId: permit.profileId, model: permit.model, effort: permit.effort,
    subagentType: permit.subagentType
  });
  const dispatchDir = path.join(root, 'dispatch');
  await mkdir(dispatchDir, { recursive: true });
  const permitPath = path.join(dispatchDir, `${id}.json`);
  await writeFile(permitPath, JSON.stringify(permit, null, 2), { mode: 0o600 });
  return { ...permit, path: permitPath, marker: `[aorch-permit:${id}]` };
}
