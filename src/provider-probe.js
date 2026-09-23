import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnoseProviders } from './provider-diagnostics.js';
import { createReadinessContext } from './provider-readiness.js';
import { executeTask } from './task-runner.js';
import { selectRoute } from './router.js';
import { captureGitSnapshot, evaluateChangeGuard, runGit } from './change-guard.js';
import { writeJsonAtomic } from './fs-util.js';

async function probeConfig(config, provider, root) {
  // The fixture has one file and needs no project-wide plugins or shell tools.
  const id = 'aorch-probe-reader';
  const instructions = 'Read the requested file with the native file tool. Return the requested structured receipt. Do not modify files, run commands or delegate.';
  const relative = provider.adapter === 'codex' ? `.codex/agents/${id}.toml`
    : provider.adapter === 'claude' ? `.claude/agents/${id}.md`
      : provider.adapter === 'antigravity' ? `.agents/agents/${id}/agent.md` : `.grok/agents/${id}.md`;
  const tools = provider.adapter === 'antigravity' ? ['view_file', 'finish'] : provider.adapter === 'grok' ? ['read_file'] : ['Read'];
  const content = provider.adapter === 'codex'
    ? `name = "${id}"\nsandbox_mode = "read-only"\nfeatures.shell_tool = false\ndeveloper_instructions = """\n${instructions}\n"""\n`
    : `---\nname: ${id}\ndescription: Bounded read probe\ntools: ${JSON.stringify(tools)}\n${provider.adapter === 'antigravity' ? 'mainAgent: true\nsubagent: false\n' : 'disallowedTools: ["Agent"]\n'}---\n${instructions}\n`;
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const key = provider.adapter === 'codex' ? 'openai' : provider.adapter === 'claude' ? 'anthropic' : provider.adapter;
  const capability = { id, type: 'agent', enabled: true, executionProviders: [key], bindings: {
    [key]: { name: id, path: file, mode: 'native', enabled: true, syncStatus: 'current', instructions,
      settings: { sandbox_mode: 'read-only', tools, features: { shell_tool: false } } }
  } };
  return { ...config, capabilities: [...(config.capabilities ?? []), capability], learning: { ...config.learning, enabled: false } };
}

export function chooseProbeTask(config, provider, models) {
  const task = {
    id: 'provider-read-probe', objective: 'Read evidence.txt using a file tool. Return its complete trimmed content as receipt.summary, with no other text in summary. List evidence.txt in filesInspected. Do not modify files or run commands.',
    role: 'executor', risk: 'low', complexity: 'low', write: false,
    allowedProviders: [provider.id], allowedScope: ['evidence.txt'], forbiddenScope: [],
    acceptanceCriteria: ['The summary exactly matches the file content and no file was changed'],
    verificationCommands: [], capabilityIds: [], tags: ['protocol-fixture', 'local-evidence'], maxTurns: 6
  };
  // Prefer an admitted route. A smoke test never promotes a profile.
  for (const kind of ['exploration', 'research', 'documentation']) {
    try {
      const route = selectRoute({ task: { ...task, kind }, catalog: config, observations: [], quota: null });
      if (!models || models.includes(route.model)) return { ...task, kind, allowedProfileIds: [route.profileId] };
    } catch { /* Try the next supported task kind. */ }
  }
  const profiles = config.models.filter((m) => m.provider === provider.id && m.enabled !== false && (!models || models.includes(m.model)))
    .sort((a, b) => a.tokenIndex - b.tokenIndex || a.id.localeCompare(b.id));
  for (const profile of profiles) {
    for (const kind of ['exploration', 'research', 'documentation']) {
      for (const complexity of ['low', 'standard', 'high']) {
        const pinned = { ...task, kind, complexity, allowedProfileIds: [profile.id] };
        try { selectRoute({ catalog: config, task: pinned, observations: [], quota: null }); return pinned; }
        catch { /* Explicit evaluation still respects supported effort levels. */ }
      }
    }
  }
  throw new Error('No configured subscription profile supports the read probe');
}

export async function probeProviders({ config, cwd = process.cwd(), diagnoseImpl = diagnoseProviders, executeImpl = executeTask }) {
  const diagnostics = await diagnoseImpl({ providers: config.providers, cwd });
  const results = [];
  for (const status of diagnostics) {
    if (status.readiness !== 'ready') { results.push(status); continue; }
    const provider = config.providers.find((p) => p.id === status.id);
    let root, task;
    try {
      task = chooseProbeTask(config, provider, status.models);
      root = await mkdtemp(path.join(tmpdir(), 'aorch-provider-probe-'));
      const git = await runGit(['init', '--quiet'], root);
      if (git.exitCode !== 0) throw new Error('Cannot initialize probe repository');
      const expected = `aorch-evidence-${randomUUID()}`;
      await writeFile(path.join(root, 'evidence.txt'), `${expected}\n`);
      const isolatedConfig = await probeConfig(config, provider, root);
      task = { ...task, agentId: 'aorch-probe-reader' };
      const before = await captureGitSnapshot({ cwd: root });
      const readinessContext = createReadinessContext({ diagnose: async () => [status] });
      const execution = await executeImpl({ task, config: isolatedConfig, cwd: root,
        timeoutMs: 120_000, readinessContext });
      const after = await captureGitSnapshot({ cwd: root });
      const guard = evaluateChangeGuard({ task, receipt: execution.receipt, before, after,
        ignoredPaths: [path.resolve(root, config.paths?.stateDir ?? '.aorch')] });
      const receipt = execution.receipt;
      const passed = guard.applicable && guard.passed && receipt?.status === 'complete'
        && receipt.summary === expected && receipt.filesInspected?.some((p) => path.resolve(root, p) === path.join(root, 'evidence.txt'))
        && receipt.criteria?.length > 0 && receipt.criteria.every((entry) => entry.status === 'pass');
      const verificationPath = path.resolve(root, config.paths?.stateDir ?? '.aorch', 'probe-verification.json');
      await writeJsonAtomic(verificationPath, { passed, changeGuard: guard, valueMatched: receipt?.summary === expected,
        route: execution.route, durationMs: execution.result?.durationMs });
      results.push({ ...status, executionStatus: passed ? 'passed' : 'failed', model: execution.route.model,
        profileId: execution.route.profileId, effort: execution.route.effort, probeRoot: root, receiptPath: execution.receiptPath,
        verificationPath, probeReason: passed ? null : 'receipt-or-change-verification-failed', changeGuardPassed: guard.passed });
    } catch (error) {
      const failurePath = root ? path.resolve(root, config.paths?.stateDir ?? '.aorch', 'probe-failure.json') : undefined;
      if (failurePath) await writeJsonAtomic(failurePath, { failureKind: error.failureKind ?? 'probe-failed',
        exitCode: error.result?.exitCode, timedOut: error.result?.timedOut, durationMs: error.result?.durationMs });
      results.push({ ...status, executionStatus: 'failed', probeRoot: root,
        profileId: task?.allowedProfileIds?.[0], failurePath, probeReason: error.failureKind ?? 'probe-failed',
        message: root ? 'Read probe did not complete; inspect the local probe evidence.' : 'No compatible configured probe route.' });
    }
  }
  return results;
}
