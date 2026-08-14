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

function mergeHook(target, fragment, targetPath) {
  target.hooks ??= {};
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    target.hooks[event] ??= [];
    if (!Array.isArray(target.hooks[event])) {
      throw new Error(`${targetPath} hooks.${event} must be an array to merge into`);
    }
    for (const group of groups) {
      const command = group.hooks?.[0]?.command;
      if (!command) continue;
      const duplicate = target.hooks[event].some((existing) => existing.hooks?.some((hook) => hook.command === command));
      if (!duplicate) target.hooks[event].push(group);
    }
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
  const settingsPath = path.join(projectRoot, '.claude/settings.json');
  const hooksPath = path.join(projectRoot, '.codex/hooks.json');
  const settings = wantsClaude ? await readJson(settingsPath, {}) : null;
  const claudeFragment = wantsClaude ? await readJson(path.join(PACKAGE_ROOT, 'integrations/claude/settings.fragment.json')) : null;
  const codexHooks = wantsCodex ? await readJson(hooksPath, {}) : null;
  const codexFragment = wantsCodex ? await readJson(path.join(PACKAGE_ROOT, 'integrations/codex/hooks.json')) : null;
  const mergedSettings = wantsClaude ? mergeHook(settings, claudeFragment, settingsPath) : null;
  const mergedCodexHooks = wantsCodex ? mergeHook(codexHooks, codexFragment, hooksPath) : null;

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
    installed.push('.claude/skills/adaptive-orchestrate', '.claude/skills/aorch-downshift', '.claude/agents', '.claude/settings.json');
  }

  if (wantsCodex) {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/skills'), path.join(projectRoot, '.agents/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/agents'), path.join(projectRoot, '.codex/agents'));
    await writeJson(hooksPath, mergedCodexHooks);
    installed.push('.agents/skills/adaptive-orchestrate', '.codex/agents', '.codex/hooks.json');
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
