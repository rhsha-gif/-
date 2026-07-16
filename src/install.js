import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './file-store.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function writeJson(filePath, value) {
  await atomicWriteJson(filePath, value);
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

async function copyTree(source, destination) {
  const { readdir } = await import('node:fs/promises');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else await copyFile(src, dst);
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
  const aorchDir = path.join(projectRoot, '.aorch');
  await mkdir(path.join(aorchDir, 'hooks'), { recursive: true });
  for (const script of ['gate.mjs', 'journal.mjs', 'user-prompt-submit.mjs', 'session-review.mjs']) {
    await copyFile(
      path.join(PACKAGE_ROOT, 'integrations/shared', script),
      path.join(aorchDir, 'hooks', script)
    );
    installed.push(`.aorch/hooks/${script}`);
  }

  const projectConfig = path.join(aorchDir, 'config.json');
  if (forceConfig || !(await exists(projectConfig))) {
    await copyFile(path.join(PACKAGE_ROOT, 'config/aorch.config.json'), projectConfig);
    installed.push('.aorch/config.json');
  }

  // Installed skills reference these schemas; without them the reflection
  // instructions point at files that do not exist in the target project.
  await copyTree(path.join(PACKAGE_ROOT, 'schemas'), path.join(aorchDir, 'schemas'));
  installed.push('.aorch/schemas');

  if (wantsClaude) {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/skills'), path.join(projectRoot, '.claude/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/agents'), path.join(projectRoot, '.claude/agents'));
    await writeJson(settingsPath, mergedSettings);
    installed.push('.claude/skills/adaptive-orchestrate', '.claude/skills/post-run-reflection', '.claude/agents', '.claude/settings.json');
  }

  if (wantsCodex) {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/skills'), path.join(projectRoot, '.agents/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/agents'), path.join(projectRoot, '.codex/agents'));
    await writeJson(hooksPath, mergedCodexHooks);
    installed.push('.agents/skills/adaptive-orchestrate', '.agents/skills/post-run-reflection', '.codex/agents', '.codex/hooks.json');
  }

  return { projectRoot, target, installed };
}
