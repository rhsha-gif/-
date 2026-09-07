import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './fs-util.js';
import { computePayloadHash, mergeTargets, readStamp, recordInstall, writeStamp } from './install-registry.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PLACEHOLDER = '{{AORCH_ROOT}}';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(filePath, fallback = {}) {
  if (!(await exists(filePath))) return structuredClone(fallback);
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse existing JSON at ${filePath}: ${error.message}`);
  }
}

const LEGACY_HOOK_COMMANDS = [
  {
    "event": "PreToolUse",
    "command": "node \"${CLAUDE_PROJECT_DIR}/.aorch/hooks/subagent-gate.mjs\""
  },
  {
    "event": "UserPromptSubmit",
    "command": "node \"${CLAUDE_PROJECT_DIR}/.aorch/hooks/user-prompt-submit.mjs\""
  },
  {
    "event": "UserPromptSubmit",
    "command": "ROOT=\"$PWD\"; while [ ! -e \"$ROOT/.aorch/hooks/user-prompt-submit.mjs\" ] && [ \"$ROOT\" != \"/\" ]; do ROOT=\"$(dirname \"$ROOT\")\"; done; if [ -e \"$ROOT/.aorch/hooks/user-prompt-submit.mjs\" ]; then node \"$ROOT/.aorch/hooks/user-prompt-submit.mjs\"; else echo \"aorch: no .aorch/hooks above $PWD\" >&2; fi"
  }
];

// Quote each argument for the host shell, including spaces and Unicode paths.
export function hookCommand(scriptPath, provider, platform = process.platform, executable = process.execPath) {
  const args = [executable, scriptPath, ...(provider ? [provider] : [])];
  if (platform === 'win32') {
    if (args.some(arg => /["&|<>^%!\x00-\x1f]/u.test(arg))) {
      throw new Error('Cannot generate Windows hook command: argument contains unsafe shell characters');
    }
    return args.map(arg => `"${arg}"`).join(' ');
  }
  return args.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ');
}

function resolveHookCommands(fragment, projectRoot, provider) {
  for (const [event, groups] of Object.entries(fragment.hooks)) {
    const script = event === 'PreToolUse' ? 'subagent-gate.mjs' : 'user-prompt-submit.mjs';
    for (const group of groups) for (const hook of group.hooks) {
      const scriptPath = path.resolve(projectRoot, '.aorch/hooks', script);
      const hostProvider = event === 'PreToolUse' ? provider : undefined;
      hook.command = hookCommand(scriptPath, hostProvider);
      if (provider === 'openai') hook.commandWindows = hookCommand(scriptPath, hostProvider, 'win32');
    }
  }
  return fragment;
}

// Accept only the quoted argv form emitted above, never wrappers or shell tails.
function parseHookCommand(command) {
  if (typeof command !== 'string') return null;
  const windows = command.startsWith('"');
  const token = windows ? /^"([^"]*)"(?: |$)/u : /^'((?:[^']|'"'"')*)'(?: |$)/u;
  const args = [];
  let remaining = command;
  while (remaining) {
    const match = token.exec(remaining);
    if (!match) return null;
    args.push(windows ? match[1] : match[1].replaceAll("'\"'\"'", "'"));
    remaining = remaining.slice(match[0].length);
  }
  if (args.length !== 2 && args.length !== 3) return null;
  try {
    if (hookCommand(args[1], args[2], windows ? 'win32' : 'linux', args[0]) !== command) return null;
  } catch { return null; }
  return { args, windows };
}

function matchesGeneratedHook(command, expectedCommand) {
  const actual = parseHookCommand(command);
  const expected = parseHookCommand(expectedCommand);
  if (!actual || !expected || actual.windows !== expected.windows) return false;
  const paths = actual.windows ? path.win32 : path.posix;
  const executable = paths.basename(actual.args[0]);
  if (!paths.isAbsolute(actual.args[0]) || !(actual.windows ? /^node(?:\.exe)?$/iu : /^node$/u).test(executable)) return false;
  const normalize = value => actual.windows ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  return actual.args.length === expected.args.length
    && paths.isAbsolute(actual.args[1])
    && normalize(actual.args[1]) === normalize(expected.args[1])
    && actual.args[2] === expected.args[2];
}

function validateHookSettings(target, targetPath) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(target)) throw new Error(`${targetPath} must be an object`);
  if (!Object.hasOwn(target, 'hooks')) return;
  if (!isObject(target.hooks)) throw new Error(`${targetPath} hooks must be an object`);
  for (const [event, groups] of Object.entries(target.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${targetPath} hooks.${event} must be an array to merge into`);
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.every(isObject)) {
        throw new Error(`${targetPath} hooks.${event} must contain groups with a hooks array of objects`);
      }
    }
  }
}

function mergeHook(target, fragment, targetPath, removeOnly = false) {
  validateHookSettings(target, targetPath);
  if (removeOnly && !target.hooks) return target;
  target.hooks ??= {};
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    if (removeOnly && !Object.hasOwn(target.hooks, event)) continue;
    target.hooks[event] ??= [];
    if (!Array.isArray(target.hooks[event])) {
      throw new Error(`${targetPath} hooks.${event} must be an array to merge into`);
    }
    const ownedCommands = new Set([
      ...LEGACY_HOOK_COMMANDS.filter(hook => hook.event === event).map(hook => hook.command),
      ...groups.flatMap(group => group.hooks.map(hook => hook.command))
    ]);
    const generatedHooks = groups.flatMap(group => group.hooks);
    // Remove individual owned handlers, not mixed groups containing user hooks.
    target.hooks[event] = target.hooks[event].flatMap(group => {
      if (!Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter(hook => !ownedCommands.has(hook.command)
        && !(hook.type === 'command' && generatedHooks.some(generated =>
          matchesGeneratedHook(hook.command, generated.command)
          && (hook.commandWindows === undefined || matchesGeneratedHook(hook.commandWindows, generated.commandWindows)))));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!removeOnly) target.hooks[event].push(...groups);
  }
  return target;
}

// Installed instruction files cannot know where this package lives, so they
// carry an {{AORCH_ROOT}} placeholder that is resolved at install time.
function resolvePlaceholders(content) {
  if (!content.includes(ROOT_PLACEHOLDER)) return content;
  return content.replaceAll(ROOT_PLACEHOLDER, PACKAGE_ROOT.replaceAll('\\', '/'));
}

// Write only when the bytes actually change. Re-installs (and the automatic
// refresh) must not rewrite an unchanged hook file that a live session is
// executing, which Windows can reject with EBUSY.
async function installFile(source, destination) {
  const raw = await readFile(source);
  const payload = raw.includes(ROOT_PLACEHOLDER)
    ? Buffer.from(resolvePlaceholders(raw.toString('utf8')), 'utf8')
    : raw;
  try {
    if ((await readFile(destination)).equals(payload)) return false;
  } catch {
    // Destination absent or unreadable: fall through and write it.
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, payload);
  return true;
}

async function copyTree(source, destination) {
  const { readdir } = await import('node:fs/promises');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else await installFile(src, dst);
  }
}

export async function installProject({ projectRoot = process.cwd(), target = 'both', forceConfig = false } = {}) {
  if (!['both', 'claude', 'codex'].includes(target)) throw new Error(`Unknown installation target: ${target}`);
  const wantsClaude = target === 'both' || target === 'claude';
  const wantsCodex = target === 'both' || target === 'codex';

  // Parse every JSON file this install will merge into BEFORE mutating
  // anything, so a malformed existing file cannot abort a half-written
  // install with a context-free error.
  const sharedSettingsPath = path.join(projectRoot, '.claude/settings.json');
  const localSettingsPath = path.join(projectRoot, '.claude/settings.local.json');
  const useLocalSettings = wantsClaude && await exists(localSettingsPath);
  const settingsPath = useLocalSettings ? localSettingsPath : sharedSettingsPath;
  const hooksPath = path.join(projectRoot, '.codex/hooks.json');
  const settings = wantsClaude ? await readJson(settingsPath, {}) : null;
  const sharedSettings = useLocalSettings ? await readJson(sharedSettingsPath, {}) : null;
  const sharedSettingsBefore = JSON.stringify(sharedSettings);
  const claudeFragment = wantsClaude ? await readJson(path.join(PACKAGE_ROOT, 'integrations/claude/settings.fragment.json')) : null;
  const codexHooks = wantsCodex ? await readJson(hooksPath, {}) : null;
  const codexFragment = wantsCodex ? await readJson(path.join(PACKAGE_ROOT, 'integrations/codex/hooks.json')) : null;
  const mergedSettings = wantsClaude ? mergeHook(settings, resolveHookCommands(claudeFragment, projectRoot, 'anthropic'), settingsPath) : null;
  const mergedSharedSettings = useLocalSettings ? mergeHook(sharedSettings, claudeFragment, sharedSettingsPath, true) : null;
  const mergedCodexHooks = wantsCodex ? mergeHook(codexHooks, resolveHookCommands(codexFragment, projectRoot, 'openai'), hooksPath) : null;

  const installed = [];
  const warnings = [];
  const aorchDir = path.join(projectRoot, '.aorch');
  await mkdir(path.join(aorchDir, 'hooks'), { recursive: true });
  for (const script of ['gate.mjs', 'user-prompt-submit.mjs', 'subagent-gate.mjs']) {
    await installFile(
      path.join(PACKAGE_ROOT, 'integrations/shared', script),
      path.join(aorchDir, 'hooks', script)
    );
    installed.push(`.aorch/hooks/${script}`);
  }

  const projectConfig = path.join(aorchDir, 'config.json');
  await installFile(path.join(PACKAGE_ROOT, 'integrations/shared/workflow.md'), path.join(aorchDir, 'workflow.md'));
  installed.push('.aorch/workflow.md');
  if (forceConfig || !(await exists(projectConfig))) {
    await installFile(path.join(PACKAGE_ROOT, 'config/aorch.config.json'), projectConfig);
    installed.push('.aorch/config.json');
  }

  // Installed skills reference these schemas; without them the task and
  // receipt instructions point at files that do not exist in the target.
  await copyTree(path.join(PACKAGE_ROOT, 'schemas'), path.join(aorchDir, 'schemas'));
  installed.push('.aorch/schemas');

  if (wantsClaude) {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/skills'), path.join(projectRoot, '.claude/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/agents'), path.join(projectRoot, '.claude/agents'));
    await writeJson(settingsPath, mergedSettings);
    if (useLocalSettings && JSON.stringify(mergedSharedSettings) !== sharedSettingsBefore) {
      await writeJson(sharedSettingsPath, mergedSharedSettings);
      installed.push('.claude/settings.json');
    }
    installed.push('.claude/skills/adaptive-orchestrate', '.claude/skills/aorch-downshift', '.claude/skills/aorch-model-upgrade', '.claude/skills/aorch-manager-map', '.claude/agents', useLocalSettings ? '.claude/settings.local.json' : '.claude/settings.json');
  }

  if (wantsCodex) {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/skills'), path.join(projectRoot, '.agents/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/agents'), path.join(projectRoot, '.codex/agents'));
    await writeJson(hooksPath, mergedCodexHooks);
    installed.push('.agents/skills/adaptive-orchestrate', '.agents/skills/aorch-model-upgrade', '.agents/skills/aorch-manager-map', '.codex/agents', '.codex/hooks.json');
  }

  // Record what this project now holds so `aorch update` and the prompt hook
  // can tell a current install from a stale one.
  // A narrower re-install does not remove the other integration, so the stamp
  // records the union — that is what a later refresh has to keep current.
  const payloadHash = await computePayloadHash();
  const stampTarget = mergeTargets((await readStamp(projectRoot))?.target, target);
  await writeStamp(projectRoot, { target: stampTarget, payloadHash });
  installed.push('.aorch/install-stamp.json');

  const registry = await recordInstall(projectRoot, target);
  if (registry.warning) warnings.push(registry.warning);

  return { projectRoot, target, installed, payloadHash, ...(warnings.length ? { warnings } : {}) };
}
