import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWindowsCommandSpec, runCommand } from './executor.js';

const FEATURE_MAP = Object.freeze({
  antigravity: Object.freeze(['structured-output', 'stream-json', 'workspace-permissions', 'native-agents']),
  grok: Object.freeze(['structured-output', 'prompt-file', 'filesystem-policy', 'native-agents', 'no-subagents'])
});

function supportedFeatures(adapter, platform) {
  const features = [...(FEATURE_MAP[adapter] ?? [])];
  if (adapter === 'grok' && (platform === 'linux' || platform === 'darwin')) features.push('os-sandbox');
  return features;
}

function regularFile(filePath) {
  try { return statSync(filePath).isFile(); }
  catch { return false; }
}

function environmentValue(env, name) {
  const key = Object.keys(env ?? {}).findLast((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function defaultExecutable(provider) {
  if (provider?.adapter === 'antigravity' || provider?.id === 'antigravity') return 'agy';
  if (provider?.adapter === 'grok' || provider?.id === 'grok') return 'grok';
  return provider?.adapter;
}

function knownWindowsExecutables(provider, { env, homeDir }) {
  const adapter = provider?.adapter ?? provider?.id;
  if (adapter === 'grok') return [path.win32.join(homeDir, '.grok', 'bin', 'grok.exe')];
  if (adapter !== 'antigravity') return [];
  const localAppData = environmentValue(env, 'LOCALAPPDATA')
    ?? path.win32.join(homeDir, 'AppData', 'Local');
  return [path.win32.join(localAppData, 'agy', 'bin', 'agy.exe')];
}

function windowsPathCandidate(command, env, isFile) {
  const directories = (environmentValue(env, 'PATH') ?? '')
    .split(';').map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1')).filter(Boolean);
  const extension = path.win32.extname(command);
  const names = extension
    ? [command]
    : [`${command}.exe`, ...(environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';').map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry === '.cmd' || entry === '.bat')
      .map((entry) => `${command}${entry}`)];
  for (const directory of directories) {
    const candidate = names.map((name) => path.win32.join(directory, name)).find(isFile);
    if (candidate) return candidate;
  }
  return null;
}

export function resolveProviderExecutable(spec, {
  provider,
  cwd = process.cwd(),
  platform = process.platform,
  env = { ...process.env, ...(spec?.env ?? {}) },
  isFile = regularFile,
  homeDir = os.homedir()
} = {}) {
  if (!spec?.command || typeof spec.command !== 'string') throw new TypeError('command specification is invalid');
  if (platform !== 'win32') {
    return { commandSpec: spec, executablePath: spec.command, source: 'configured', pathIssue: null };
  }

  const pathLike = /[\\/]/u.test(spec.command);
  if (pathLike) {
    const candidate = path.win32.isAbsolute(spec.command) ? spec.command : path.resolve(cwd, spec.command);
    return isFile(candidate)
      ? { commandSpec: { ...spec, command: candidate }, executablePath: candidate, source: 'configured', pathIssue: null }
      : { commandSpec: spec, executablePath: spec.command, source: 'configured', pathIssue: 'configured-not-found' };
  }

  const pathExecutable = windowsPathCandidate(spec.command, env, isFile);
  const fromPath = resolveWindowsCommandSpec(spec, { platform, env, isFile });
  if (fromPath.command !== spec.command || fromPath.verbatim === true) {
    return { commandSpec: fromPath, executablePath: pathExecutable ?? fromPath.command, source: 'path', pathIssue: null };
  }

  const expectedNames = provider?.adapter === 'antigravity' ? ['agy', 'agy.exe']
    : provider?.adapter === 'grok' ? ['grok', 'grok.exe'] : [];
  if (!expectedNames.includes(spec.command.toLowerCase())) {
    return { commandSpec: spec, executablePath: spec.command, source: 'configured', pathIssue: null };
  }
  const discovered = knownWindowsExecutables(provider, { env, homeDir }).find(isFile);
  if (!discovered) return { commandSpec: spec, executablePath: spec.command, source: 'configured', pathIssue: null };
  return {
    commandSpec: { ...spec, command: discovered },
    executablePath: discovered,
    source: 'known-install',
    pathIssue: 'stale-process-path'
  };
}

export function resolveProviderCommandSpec(spec, options = {}) {
  return resolveProviderExecutable(spec, options).commandSpec;
}

function failureText(error, result) {
  return [error?.providerMessage, error?.message, result?.stderr, result?.stdout]
    .filter((value) => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}

export function classifyProviderFailure({ error, result } = {}) {
  if (error?.failureKind === 'protocol' || error?.failureKind === 'action-required') return error.failureKind;
  if (result?.timedOut === true || error?.code === 'ETIMEDOUT') return 'timeout';
  const text = failureText(error, result);
  if (/rate.?limit|quota|usage limit|credits? (?:exhausted|depleted)|insufficient[_ ]quota|\b429\b/u.test(text)) return 'rate-limit';
  if (/authentication required|not authenticated|unauthori[sz]ed|invalid (?:api )?key|login required|sign[ -]?in required|\b401\b/u.test(text)) return 'authentication';
  if (/\beconn(?:reset|refused|aborted)\b|\benotfound\b|\beai_again\b|network (?:error|unavailable)|fetch failed|unable to connect|connection (?:failed|refused)|tls handshake/u.test(text)) return 'network';
  return 'execution';
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function firstLine(result) {
  return stripAnsi(result?.stdout || result?.stderr).split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

function parseModels(adapter, result) {
  const text = stripAnsi([result?.stdout, result?.stderr].filter(Boolean).join('\n'));
  if (adapter === 'antigravity') {
    const models = text.split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.includes('\t'))
      .map((line) => line.split('\t', 1)[0].trim())
      .filter(Boolean);
    return models.length > 0 ? [...new Set(models)] : null;
  }
  if (adapter === 'grok') {
    const models = [...text.matchAll(/^\s*\*\s+([^\s(]+)(?:\s|$)/gmu)].map((match) => match[1]);
    return models.length > 0 ? [...new Set(models)] : null;
  }
  return null;
}

export async function diagnoseProvider(provider, options) {
  const configuredExecutable = provider.executable ?? defaultExecutable(provider);
  const unsetEnv = provider.adapter === 'grok' ? ['XAI_API_KEY']
    : provider.adapter === 'antigravity' ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] : [];
  const baseSpec = { command: configuredExecutable, args: [], stdin: null, env: {}, unsetEnv };
  const resolution = resolveProviderExecutable(baseSpec, { provider, ...options });
  const common = {
    id: provider.id,
    adapter: provider.adapter,
    configuredExecutable,
    resolvedExecutable: resolution.executablePath,
    available: false,
    installed: false,
    configuredEnabled: provider.enabled !== false,
    executionStatus: 'not-probed',
    readiness: 'unknown',
    readinessReason: null,
    checkedAt: new Date().toISOString(),
    version: null,
    models: null,
    modelsStatus: null,
    supportedFeatures: supportedFeatures(provider.adapter, options.platform),
    pathIssue: resolution.pathIssue,
    message: resolution.pathIssue === 'stale-process-path'
      ? `The current process PATH does not contain ${configuredExecutable}; using the discovered installation.`
      : resolution.pathIssue === 'configured-not-found'
        ? `Configured executable was not found: ${configuredExecutable}`
        : null
  };
  if (resolution.pathIssue === 'configured-not-found') return { ...common, readiness: 'blocked', readinessReason: 'executable-missing' };

  const run = options.runCommandImpl ?? runCommand;
  const resolve = (args) => resolveProviderCommandSpec(
    { ...baseSpec, args }, { provider, ...options }
  );
  let versionResult, versionFailure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      versionResult = await run(resolve(['--version']), { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 5_000 });
      versionFailure = versionResult.exitCode === 0 && !versionResult.timedOut ? null : classifyProviderFailure({ result: versionResult });
    } catch (error) { versionFailure = classifyProviderFailure({ error }); }
    if (!['timeout', 'network'].includes(versionFailure)) break;
  }
  if (versionFailure) return { ...common, readinessReason: versionFailure, message: 'Executable probe failed.' };
  const diagnosed = { ...common, available: true, installed: true, version: firstLine(versionResult) };
  const args = provider.adapter === 'claude' ? ['auth', 'status']
    : provider.adapter === 'codex' ? ['login', 'status']
      : ['antigravity', 'grok'].includes(provider.adapter) ? ['models'] : null;
  if (!args) return { ...diagnosed, readiness: provider.enabled === false ? 'blocked' : 'unknown',
    readinessReason: provider.enabled === false ? 'disabled' : 'custom-protocol' };
  let result, failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await run(resolve(args), { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 15_000 });
      failure = result.exitCode === 0 && !result.timedOut ? null : classifyProviderFailure({ result });
    } catch (error) { failure = classifyProviderFailure({ error }); }
    if (!['timeout', 'network'].includes(failure)) break;
  }
  if (failure) {
    diagnosed.readiness = ['authentication', 'action-required', 'rate-limit'].includes(failure) ? 'blocked' : 'unknown';
    diagnosed.readinessReason = failure;
    if (args[0] === 'models') diagnosed.modelsStatus = failure;
    return diagnosed;
  }
  if (args[0] === 'models') {
    diagnosed.models = parseModels(provider.adapter, result);
    diagnosed.modelsStatus = diagnosed.models ? 'available' : 'unsupported';
    diagnosed.readiness = diagnosed.models ? 'ready' : 'unknown';
    diagnosed.readinessReason = diagnosed.models ? null : 'models-unrecognized';
  } else if (provider.adapter === 'claude') {
    let auth;
    try { auth = JSON.parse(result.stdout); } catch { /* Unrecognized status fails closed. */ }
    diagnosed.readiness = auth?.loggedIn === true ? 'ready' : auth?.loggedIn === false ? 'blocked' : 'unknown';
    diagnosed.readinessReason = auth?.loggedIn === true ? null : auth?.loggedIn === false ? 'authentication' : 'auth-status-unrecognized';
  } else {
    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    diagnosed.readiness = /logged in/i.test(output) && !/not logged in/i.test(output) ? 'ready' : 'unknown';
    diagnosed.readinessReason = diagnosed.readiness === 'ready' ? null : 'auth-status-unrecognized';
  }
  if (provider.enabled === false) {
    diagnosed.readiness = 'blocked';
    diagnosed.readinessReason = 'disabled';
  }
  return diagnosed;
}

export async function diagnoseProviders({
  providers,
  cwd = process.cwd(),
  runCommandImpl,
  timeoutMs,
  platform = process.platform,
  env = process.env,
  isFile = regularFile,
  homeDir = os.homedir()
}) {
  if (!Array.isArray(providers)) throw new TypeError('providers must be an array');
  return Promise.all(providers.map((provider) => diagnoseProvider(provider, {
    cwd, runCommandImpl, timeoutMs, platform, env, isFile, homeDir
  })));
}
