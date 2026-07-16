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
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await atomicWriteJson(filePath, value);
}

function mergeHook(target, fragment) {
  target.hooks ??= {};
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    target.hooks[event] ??= [];
    for (const group of groups) {
      const command = group.hooks?.[0]?.command;
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

  if (target === 'both' || target === 'claude') {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/skills'), path.join(projectRoot, '.claude/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/claude/agents'), path.join(projectRoot, '.claude/agents'));
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    const settings = await readJson(settingsPath, {});
    const fragment = await readJson(path.join(PACKAGE_ROOT, 'integrations/claude/settings.fragment.json'));
    await writeJson(settingsPath, mergeHook(settings, fragment));
    installed.push('.claude/skills/adaptive-orchestrate', '.claude/skills/post-run-reflection', '.claude/agents', '.claude/settings.json');
  }

  if (target === 'both' || target === 'codex') {
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/skills'), path.join(projectRoot, '.agents/skills'));
    await copyTree(path.join(PACKAGE_ROOT, 'integrations/codex/agents'), path.join(projectRoot, '.codex/agents'));
    const hooksPath = path.join(projectRoot, '.codex/hooks.json');
    const hooks = await readJson(hooksPath, {});
    const fragment = await readJson(path.join(PACKAGE_ROOT, 'integrations/codex/hooks.json'));
    await writeJson(hooksPath, mergeHook(hooks, fragment));
    installed.push('.agents/skills/adaptive-orchestrate', '.agents/skills/post-run-reflection', '.codex/agents', '.codex/hooks.json');
  }

  return { projectRoot, target, installed };
}
