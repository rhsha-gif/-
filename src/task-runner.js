import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectRoute } from './router.js';
import { selectCapabilities } from './capabilities.js';
import { providerById } from './config.js';
import { buildTaskPrompt } from './providers/base.js';
import { buildClaudeCommand } from './providers/claude-cli.js';
import { buildCodexCommand } from './providers/codex-cli.js';
import { buildGenericCommand } from './providers/generic-cli.js';
import { runCommand } from './executor.js';
import { formatProgressReport, ProgressReporter } from './progress.js';
import { validateTask } from './task.js';
import { validateReceipt } from './receipt.js';
import { captureWorkspaceState, inspectWorkspaceIsolation, validateClaimedChanges, verifyTaskClaim } from './verifier.js';
import { atomicWriteJson, atomicWriteText } from './file-store.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'worker-receipt.schema.json');

function parseClaudeOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.structured_output ?? parsed.result?.structured_output ?? parsed;
}

async function parseWorkerReceipt({ provider, stdout, outputPath }) {
  if (provider.adapter === 'codex') return JSON.parse(await readFile(outputPath, 'utf8'));
  if (provider.adapter === 'claude') return parseClaudeOutput(stdout);
  return JSON.parse(stdout);
}

function ignoredRunPath(cwd, runDir) {
  const relative = path.relative(cwd, runDir).replaceAll('\\', '/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative] : [];
}

async function enforceWriteIsolation(task, cwd) {
  if (task.write !== true) return;
  const workspace = await inspectWorkspaceIsolation(cwd);
  if (!workspace.available) {
    throw new Error('Write task requires a Git repository and an isolated linked worktree');
  }
  if (workspace.linkedWorktree) return;
  if (['high', 'critical'].includes(task.risk)) {
    throw new Error(`${task.risk}-risk write task must run in an isolated linked worktree`);
  }
  if (task.allowInPlaceWrite !== true) {
    throw new Error('Write task must run in an isolated linked worktree; in-place write requires explicit task.allowInPlaceWrite authorization');
  }
}

export async function executeTask({
  task,
  config,
  observations = [],
  cwd = process.cwd(),
  stateRoot = path.resolve(cwd, config.paths?.stateDir ?? '.aorch'),
  onProgress = (entry) => process.stderr.write(`${formatProgressReport(entry)}\n`),
  // A hung worker must not hang the orchestrator forever; pass 0 explicitly
  // to disable the watchdog.
  timeoutMs = 60 * 60 * 1000,
  verificationTimeoutMs,
  dryRun = false
}) {
  task = validateTask(task, { forExecution: true });
  const route = selectRoute({ task, catalog: config, observations });
  const capabilities = selectCapabilities({
    requestedIds: task.capabilityIds ?? [],
    inventory: config.capabilities,
    provider: route.provider,
    limits: config.capabilityLimits,
    task,
    policy: config.controlPlane ?? {}
  });
  const provider = providerById(config, route.provider);
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(stateRoot, 'task-runs', runId, task.id);
  const receiptPath = path.join(runDir, 'receipt.json');
  const outputPath = path.join(runDir, 'worker-output.json');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const schema = JSON.parse(await readFile(RECEIPT_SCHEMA_PATH, 'utf8'));
  const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath });

  let commandSpec;
  if (provider.adapter === 'claude') {
    commandSpec = buildClaudeCommand({
      prompt,
      route,
      write: task.write === true,
      jsonSchema: schema,
      pluginDirs: capabilities.plugins.map((plugin) => plugin.path).filter(Boolean),
      maxTurns: task.maxTurns ?? 80,
      executable: provider.executable ?? 'claude'
    });
  } else if (provider.adapter === 'codex') {
    commandSpec = buildCodexCommand({
      prompt,
      route,
      write: task.write === true,
      schemaPath: RECEIPT_SCHEMA_PATH,
      outputPath,
      executable: provider.executable ?? 'codex'
    });
  } else {
    commandSpec = buildGenericCommand({ prompt, route, provider, write: task.write === true });
  }
  commandSpec.env = {
    ...commandSpec.env,
    AORCH_SELECTED_CAPABILITIES: (task.capabilityIds ?? []).join(','),
    AORCH_SELECTED_SKILLS: capabilities.skills.map((entry) => entry.id).join(','),
    AORCH_SELECTED_PLUGINS: capabilities.plugins.map((entry) => entry.id).join(','),
    AORCH_SELECTED_HOOKS: capabilities.hooks.map((entry) => entry.id).join(','),
    AORCH_TASK_ID: task.id
  };

  if (dryRun) return { task, route, capabilities, provider, commandSpec, receiptPath, runDir };

  await enforceWriteIsolation(task, cwd);
  const ignoredPaths = ignoredRunPath(cwd, runDir);
  const beforeState = await captureWorkspaceState(cwd, { ignorePaths: ignoredPaths });
  await mkdir(runDir, { recursive: true });
  const intervalMs = (config.progress?.intervalMinutes ?? 30) * 60 * 1000;
  const commandTimeoutMs = verificationTimeoutMs
    ?? config.verification?.commandTimeoutMs
    ?? 15 * 60 * 1000;
  const isolationMode = task.verificationIsolation
    ?? config.verification?.isolationByRisk?.[task.risk]
    ?? 'same-workspace';
  let progressFraction = 0.1;
  const reporter = new ProgressReporter({ onReport: onProgress, intervalMs });
  reporter.start(() => [{ id: task.id, weight: task.weight ?? 1, status: 'running', fraction: progressFraction }]);

  try {
    const result = await runCommand(commandSpec, { cwd, timeoutMs });
    await atomicWriteText(stdoutPath, result.stdout);
    await atomicWriteText(stderrPath, result.stderr);
    await atomicWriteJson(path.join(runDir, 'execution.json'), result);

    if (result.exitCode !== 0) {
      throw new Error(`Worker exited with ${result.exitCode}; evidence: ${stderrPath}`);
    }

    progressFraction = 0.7;
    reporter.meaningfulUpdate();
    const receipt = validateReceipt(
      await parseWorkerReceipt({ provider, stdout: result.stdout, outputPath }),
      { task }
    );
    await atomicWriteJson(receiptPath, receipt);
    const afterState = await captureWorkspaceState(cwd, { ignorePaths: ignoredPaths });

    let attestation = null;
    if (receipt.status !== 'complete' && beforeState.available && afterState.available) {
      // A partial or blocked claim is still a claim: the worker must not hide
      // workspace mutations behind a non-complete status, especially for
      // in-place writes where nothing else would compare claim to evidence.
      validateClaimedChanges({ task, receipt, beforeState, afterState });
    }
    if (receipt.status === 'complete') {
      const totalChecks = task.verificationCommands.length + task.verifierCommands.length;
      attestation = await verifyTaskClaim({
        task,
        receipt,
        cwd,
        runDir,
        beforeState,
        afterState,
        timeoutMs: commandTimeoutMs,
        isolationMode,
        onStep: (completed) => {
          progressFraction = totalChecks > 0 ? 0.7 + (0.29 * completed / totalChecks) : 0.99;
          reporter.meaningfulUpdate();
        }
      });
    }

    const finalPercent = receipt.status === 'complete' ? 100 : receipt.status === 'partial' ? 75 : 0;
    const finalPhase = receipt.status === 'complete'
      ? 'complete'
      : receipt.status === 'blocked'
        ? 'blocked'
        : receipt.status === 'partial'
          ? 'partial'
          : 'failed';
    const confidenceValue = Number(receipt.confidence ?? 0.5);
    const finalConfidence = finalPhase === 'complete'
      ? (confidenceValue >= 0.8 ? 'high' : confidenceValue >= 0.5 ? 'medium' : 'low')
      : 'low';
    const evidenceCount = (receipt.commands?.length ?? 0)
      + (receipt.criteria?.length ?? 0)
      + (attestation?.checks?.length ?? 0);
    onProgress({
      percent: finalPercent,
      label: 'estimated',
      reason: receipt.status,
      phase: finalPhase,
      confidence: finalConfidence,
      evidenceCount,
      lastEvidenceAt: new Date().toISOString(),
      blockers: (receipt.unresolvedRisks ?? []).map((message) => ({ taskId: task.id, message })),
      activeTaskIds: []
    });
    return {
      task,
      route,
      capabilities,
      receipt,
      attestation,
      attestationPath: attestation?.path ?? null,
      result,
      receiptPath,
      runDir
    };
  } catch (error) {
    onProgress({
      percent: Math.max(0, Math.min(99, Math.round(progressFraction * 100))),
      label: 'estimated',
      reason: 'error',
      phase: 'failed',
      confidence: 'low',
      evidenceCount: 0,
      lastEvidenceAt: new Date().toISOString(),
      blockers: [{ taskId: task.id, message: error.message }],
      activeTaskIds: []
    });
    throw error;
  } finally {
    reporter.stop();
  }
}
