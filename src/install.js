import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePayloadHash, mergeTargets, readStamp, recordInstall, writeStamp } from './install-registry.js';
import os from 'node:os';
import { readdir } from 'node:fs/promises';
import { loadDefinitions, renderDefinitions } from './definitions.js';
import { syncGeneratedFiles, readOptional } from './definition-sync.js';

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
  if (Array.isArray(target.hooks.PreToolUse)) {
    target.hooks.PreToolUse = target.hooks.PreToolUse.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !/\.aorch[\\/]hooks[\\/]subagent-gate\.mjs/.test(hook.command ?? ''));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!target.hooks.PreToolUse.length) delete target.hooks.PreToolUse;
  }
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


async function treePayload(source, destination) {
  const files = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (/^(desktop\.ini|thumbs\.db|\.DS_Store)$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Integration payload cannot contain symlinks: ${entry.name}`);
    const src = path.join(source, entry.name);
    const dst = `${destination}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await treePayload(src, dst));
    else files.push({ path: dst, content: resolvePlaceholders(await readFile(src, 'utf8')) });
  }
  return files;
}

export async function installUserDefinitions({ homeDir = os.homedir(), target, check = false } = {}) {
  if (await readStamp(homeDir)) throw new Error('User definitions cannot share a root with a project installation; keep the project in its own directory');
  const ledgerPath = '.aorch/generated-user-files.json';
  const raw = await readOptional(path.join(homeDir, ledgerPath));
  if (raw) {
    const providers = new Set(Object.values(JSON.parse(raw).files ?? {}).map((entry) => entry.provider));
    const previousTarget = providers.has('anthropic') && providers.has('openai') ? 'both' : providers.has('anthropic') ? 'claude' : providers.has('openai') ? 'codex' : undefined;
    target = target ? mergeTargets(previousTarget, target) : previousTarget;
  }
  const definitions = (await loadDefinitions({ cwd: homeDir, includeUser: true })).filter((entry) => entry.sourceScope !== 'project');
  return syncGeneratedFiles({ root: homeDir, files: await renderDefinitions({ definitions, target: target ?? 'both' }), ledgerPath, check });
}

export async function installProject({ projectRoot = process.cwd(), target = 'both', forceConfig = false, check = false } = {}) {
  if (!['both', 'claude', 'codex'].includes(target)) throw new Error(`Unknown installation target: ${target}`);
  projectRoot = path.resolve(projectRoot);
  if (projectRoot === path.resolve(os.homedir()) || await exists(path.join(projectRoot, '.aorch/generated-user-files.json'))) {
    throw new Error('Project installation cannot share the user definition root; use --user or a separate project directory');
  }
  // A narrow re-install keeps the other integration current too.
  target = mergeTargets((await readStamp(projectRoot))?.target, target);
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

  const definitions = await loadDefinitions({ cwd: projectRoot });
  const generated = await renderDefinitions({ definitions, target });
  const files = [...generated, ...await treePayload(path.join(PACKAGE_ROOT, 'schemas'), '.aorch/schemas')];
  for (const script of ['gate.mjs', 'user-prompt-submit.mjs', 'subagent-gate.mjs']) {
    files.push({ path: `.aorch/hooks/${script}`, content: resolvePlaceholders(await readFile(path.join(PACKAGE_ROOT, 'integrations/shared', script), 'utf8')) });
  }
  const configPath = path.join(projectRoot, '.aorch/config.json');
  if (forceConfig || !(await exists(configPath))) files.push({ path: '.aorch/config.json', content: await readFile(path.join(PACKAGE_ROOT, 'config/aorch.config.json')), merge: true });
  if (wantsClaude) files.push({ path: '.claude/settings.json', content: `${JSON.stringify(mergedSettings, null, 2)}\n`, merge: true });
  if (wantsCodex) files.push({ path: '.codex/hooks.json', content: `${JSON.stringify(mergedCodexHooks, null, 2)}\n`, merge: true });
  const sync = await syncGeneratedFiles({ root: projectRoot, files, check });
  if (check) return { projectRoot, target, ...sync };
  if (sync.status === 'conflict') {
    const error = new Error(`Generated-file conflict; edit the canonical source or restore the generated copy: ${sync.conflicts.map((entry) => entry.path).join(', ')}`);
    error.conflicts = sync.conflicts;
    throw error;
  }
  const payloadHash = await computePayloadHash();
  const stamp = await readStamp(projectRoot);
  if (stamp?.payloadHash !== payloadHash || stamp?.target !== target || stamp?.packageRoot !== PACKAGE_ROOT.replaceAll('\\', '/')) await writeStamp(projectRoot, { target, payloadHash });
  const registry = sync.status !== 'current' ? await recordInstall(projectRoot, target) : {};
  return { projectRoot, target, status: sync.status, installed: files.map((entry) => entry.path), changed: sync.changed, payloadHash,
    ...(sync.backup ? { backup: sync.backup } : {}), ...(registry.warning ? { warnings: [registry.warning] } : {}) };
}
