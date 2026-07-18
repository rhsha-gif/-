import { spawnSync } from 'node:child_process';
import { access, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inspectFileStore } from './file-store.js';
import { inspectSubscriptionEnvironment, inspectHostSurface } from './subscription.js';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function resolveReal(candidate) {
  try { return await realpath(candidate); }
  catch { return path.resolve(candidate); }
}

// Compare realpaths: a pointer created through a symlinked project alias must
// not be judged "outside the state root" (and deleted by --repair) merely
// because doctor runs from the physical path.
async function assertInsideRoot(root, candidate) {
  const resolvedRoot = await resolveReal(root);
  const resolved = await resolveReal(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Active run path is outside state root: ${resolved}`);
  }
  return resolved;
}

async function inspectActiveRunPointer(root, { repair = false } = {}) {
  const pointerPath = path.join(root, 'active-run.json');
  if (!(await exists(pointerPath))) {
    return { status: 'pass', present: false, repaired: false, pointerPath };
  }

  try {
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    if (typeof pointer.runPath !== 'string' || pointer.runPath.trim() === '') {
      throw new Error('Active run pointer requires a non-empty runPath');
    }
    const runPath = await assertInsideRoot(root, pointer.runPath);
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    if (!run || typeof run !== 'object' || typeof run.id !== 'string' || run.id.trim() === '') {
      throw new Error('Active run target is not a valid run state');
    }
    return {
      status: 'pass',
      present: true,
      repaired: false,
      pointerPath,
      runPath,
      runId: run.id
    };
  } catch (error) {
    if (repair) {
      await unlink(pointerPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      return {
        status: 'pass',
        present: true,
        repaired: true,
        pointerPath,
        issue: error.message
      };
    }
    return {
      status: 'fail',
      present: true,
      repaired: false,
      pointerPath,
      issue: error.message
    };
  }
}

export function checkExecutable(provider) {
  const executable = provider.executable ?? (provider.adapter === 'claude' ? 'claude' : provider.adapter === 'codex' ? 'codex' : null);
  if (!executable) return { id: provider.id, status: 'fail', reason: 'no executable configured' };
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  return {
    id: provider.id,
    executable,
    status: result.status === 0 ? 'pass' : 'fail',
    version: result.status === 0 ? result.stdout.trim() || result.stderr.trim() : null,
    reason: result.status === 0 ? null : (result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`))
  };
}

export function runDoctor(config) {
  const node = { status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail', version: process.versions.node };
  const providers = config.providers.filter((provider) => provider.enabled !== false).map(checkExecutable);
  const status = node.status === 'pass' && providers.every((provider) => provider.status === 'pass') ? 'pass' : 'fail';
  return {
    status,
    node,
    providers,
    catalog: { status: 'pass', providers: config.providers.length, models: config.models.length, capabilities: config.capabilities.length, modelSupport: 'not-probed' }
  };
}

function defaultExec(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
}

function claudeAuthCheck(executable, exec) {
  let result;
  try {
    result = exec(executable, ['auth', 'status']);
  } catch (error) {
    return { status: 'unknown', reason: `auth status unavailable: ${error.message}` };
  }
  if (result.error) return { status: 'unknown', reason: `auth status unavailable: ${result.error.message}` };
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* older clients may not emit JSON */ }
  if (result.status === 0 && parsed?.loggedIn !== false) {
    return { status: 'pass', loggedIn: true, detail: parsed ?? result.stdout.trim() };
  }
  if (result.status === 0 || result.status === 1) {
    // Documented contract: exit 0 logged in, exit 1 not logged in. This is a
    // user-resolvable login problem, not a model-quality failure.
    return { status: 'fail', loggedIn: false, reason: 'not logged in; run claude /login to renew the subscription session' };
  }
  return { status: 'unknown', reason: `unrecognized auth status exit ${result.status}` };
}

function codexAuthCheck(executable, exec) {
  let result;
  try {
    result = exec(executable, ['login', 'status']);
  } catch (error) {
    return { status: 'unknown', reason: `auth status unavailable: ${error.message}` };
  }
  if (result.error) return { status: 'unknown', reason: `auth status unavailable: ${result.error.message}` };
  if (result.status === 0) {
    return { status: 'pass', detail: result.stdout.trim() || null };
  }
  // Without a machine-readable confirmation the status is unknown, never
  // assumed authenticated; app storage is not inspected to infer login.
  return { status: 'unknown', reason: result.stderr.trim() || `exit ${result.status}` };
}

export function runSubscriptionDoctor({ config, env = process.env, settings = {}, exec = defaultExec }) {
  const providers = {};
  for (const provider of config.providers.filter((entry) => entry.enabled !== false)) {
    if (provider.adapter !== 'claude' && provider.adapter !== 'codex') continue;
    const subscriptionProvider = provider.adapter === 'claude' ? 'anthropic' : 'openai';
    const environment = inspectSubscriptionEnvironment({
      env,
      provider: subscriptionProvider,
      settings,
      policy: { allowAutomationCredential: config.access?.allowAutomationCredential === true }
    });
    const auth = provider.adapter === 'claude'
      ? claudeAuthCheck(provider.executable ?? 'claude', exec)
      : codexAuthCheck(provider.executable ?? 'codex', exec);
    providers[subscriptionProvider] = {
      providerId: provider.id,
      auth,
      environment: {
        status: environment.status === 'blocked' ? 'fail' : environment.status === 'policy-required' ? 'warning' : 'pass',
        conflicts: environment.conflicts,
        automationCredentials: environment.automationCredentials,
        warnings: environment.warnings
      },
      usagePool: subscriptionProvider === 'anthropic' ? 'anthropic-subscription' : 'openai-agentic'
    };
  }

  const statuses = Object.values(providers).flatMap((entry) => [entry.auth.status, entry.environment.status]);
  const status = statuses.includes('fail') ? 'fail'
    : statuses.includes('unknown') ? 'unknown'
    : statuses.includes('warning') ? 'warning'
    : 'pass';
  return { status, access: config.access ?? null, providers };
}

export async function inspectCodexAppEnforcement({ root }) {
  const evidencePath = path.join(root, 'evidence', 'codex-app.json');
  const warnings = [];
  let evidence = [];
  if (await exists(evidencePath)) {
    try {
      const raw = JSON.parse(await readFile(evidencePath, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('evidence file must contain an array');
      for (const entry of raw) {
        if (!entry || typeof entry.kind !== 'string' || typeof entry.detail !== 'string') {
          warnings.push('evidence entry without kind/detail was ignored');
          continue;
        }
        if (entry.kind === 'authenticated-fixture' && (typeof entry.verifiedAt !== 'string' || Number.isNaN(Date.parse(entry.verifiedAt)))) {
          warnings.push('authenticated-fixture evidence without a valid verifiedAt cannot support strict and was downgraded');
          evidence.push({ ...entry, kind: 'claimed-strict' });
          continue;
        }
        evidence.push(entry);
      }
    } catch (error) {
      warnings.push(`evidence file unreadable: ${error.message}`);
      evidence = [];
    }
  }
  const surface = inspectHostSurface({ surface: 'codex-app', evidence });
  return { ...surface, evidencePath, warnings };
}

export async function inspectStateHealth(root, options = {}) {
  const files = await inspectFileStore(root, options);
  const activeRun = await inspectActiveRunPointer(root, options);
  return {
    ...files,
    status: files.status === 'pass' && activeRun.status === 'pass' ? 'pass' : 'fail',
    activeRun
  };
}
