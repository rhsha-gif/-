// Install bookkeeping shared by `aorch install`, `aorch update`, and the
// prompt hook's staleness check. Installed copies are snapshots of this
// package's integration payload, so they go stale whenever the package
// changes. A per-project stamp records which payload a project holds, and a
// user-level registry records which projects to refresh.
import { createHash } from 'node:crypto';
import { access, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './fs-util.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const STAMP_RELATIVE_PATH = '.aorch/install-stamp.json';
export const REGISTRY_VERSION = 1;

// The payload the installer copies. `config/aorch.config.json` is deliberately
// absent: an install never overwrites an existing project config, so a config
// change must not mark every project stale.
const PAYLOAD_ROOTS = Object.freeze([
  'integrations/shared',
  'integrations/claude',
  'integrations/codex',
  'schemas'
]);

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export function userHome() {
  return process.env.AORCH_HOME
    ? path.resolve(process.env.AORCH_HOME)
    : path.join(os.homedir(), '.aorch');
}

export function registryPath() {
  return path.join(userHome(), 'installs.json');
}

export function packageRoot() {
  return PACKAGE_ROOT;
}

export async function packageVersion() {
  try {
    return JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

async function collectFiles(root) {
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  // Sort by name so the hash is independent of directory iteration order.
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (/^(desktop\.ini|thumbs\.db|\.DS_Store)$|^\.env(?:\.|$)/i.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(full));
    else found.push(full);
  }
  return found;
}

// Content hash of everything an install copies. Version alone is too coarse:
// this package changes far more often than its version string does.
export async function computePayloadHash() {
  const hash = createHash('sha256');
  for (const root of PAYLOAD_ROOTS) {
    const absoluteRoot = path.join(PACKAGE_ROOT, root);
    for (const file of await collectFiles(absoluteRoot)) {
      hash.update(path.relative(PACKAGE_ROOT, file).replaceAll('\\', '/'));
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export async function readStamp(projectRoot) {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, STAMP_RELATIVE_PATH), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeStamp(projectRoot, { target, payloadHash, version, installedAt }) {
  await writeJsonAtomic(path.join(projectRoot, STAMP_RELATIVE_PATH), {
    version: version ?? await packageVersion(),
    payloadHash,
    target,
    packageRoot: PACKAGE_ROOT.replaceAll('\\', '/'),
    installedAt: installedAt ?? new Date().toISOString()
  });
}

// Which integrations a project actually holds. Used to refresh installs made
// before stamps existed, where the recorded target is unknown.
export async function detectTarget(projectRoot) {
  const hasClaude = await exists(path.join(projectRoot, '.claude/skills/adaptive-orchestrate'));
  const hasCodex = await exists(path.join(projectRoot, '.agents/skills/adaptive-orchestrate'));
  if (hasClaude && hasCodex) return 'both';
  if (hasClaude) return 'claude';
  if (hasCodex) return 'codex';
  return null;
}

export function mergeTargets(previous, next) {
  if (!previous || previous === next) return next;
  return 'both';
}

// 'unmanaged' means no install to refresh — auto-update must never install
// into a project the user never opted in to.
export async function inspectProject(projectRoot, payloadHash) {
  const resolved = path.resolve(projectRoot);
  if (!(await exists(resolved))) return { projectRoot: resolved, status: 'missing', target: null };
  const stamp = await readStamp(resolved);
  const target = stamp?.target ?? await detectTarget(resolved);
  if (!target) return { projectRoot: resolved, status: 'unmanaged', target: null };
  const hash = payloadHash ?? await computePayloadHash();
  const status = stamp?.payloadHash === hash ? 'current' : 'stale';
  return { projectRoot: resolved, status, target, stamp };
}

export async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.projects !== 'object' || parsed.projects === null) {
      return { version: REGISTRY_VERSION, projects: {} };
    }
    return { version: REGISTRY_VERSION, projects: parsed.projects };
  } catch {
    return { version: REGISTRY_VERSION, projects: {} };
  }
}

async function writeRegistry(registry) {
  await writeJsonAtomic(registryPath(), {
    version: REGISTRY_VERSION,
    projects: Object.fromEntries(Object.entries(registry.projects).sort(([a], [b]) => (a < b ? -1 : 1)))
  });
}

export function registryKey(projectRoot) {
  return path.resolve(projectRoot).replaceAll('\\', '/');
}

// Registry bookkeeping must never fail an otherwise successful install, so
// callers get a warning instead of an exception.
export async function recordInstall(projectRoot, target) {
  try {
    const registry = await readRegistry();
    const key = registryKey(projectRoot);
    const previous = registry.projects[key];
    registry.projects[key] = {
      target: mergeTargets(previous?.target, target),
      packageRoot: PACKAGE_ROOT.replaceAll('\\', '/'),
      installedAt: new Date().toISOString()
    };
    await writeRegistry(registry);
    return { recorded: true };
  } catch (error) {
    return { recorded: false, warning: `install registry not updated: ${error.message}` };
  }
}

export async function forgetInstall(projectRoot) {
  try {
    const registry = await readRegistry();
    if (!(registryKey(projectRoot) in registry.projects)) return false;
    delete registry.projects[registryKey(projectRoot)];
    await writeRegistry(registry);
    return true;
  } catch {
    return false;
  }
}

export async function clearRegistry() {
  await rm(registryPath(), { force: true });
}
