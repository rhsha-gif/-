import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectRoutePlan } from './router.js';
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
import {
  captureWorkspaceState,
  changedPathsBetween,
  inspectWorkspaceIsolation,
  sha256,
  validateClaimedChanges,
  verifyTaskClaim
} from './verifier.js';
import { atomicWriteJson, atomicWriteText } from './file-store.js';
import { normalizeHostContext } from './host.js';
import { resolveExecutionLane } from './lane.js';
import { loadPromptProfiles, resolvePromptProfile } from './prompt-profiles.js';
import {
  compileWorkerPrompt,
  createPromptManifest,
  writePromptManifest
} from './prompt-compiler.js';
import { assertCompiledPrompt } from './prompt-lint.js';
import { appendTraceEvent, readTrace, summarizeTrace } from './trace.js';
import { readBoundedRegularFile, redactSecrets, redactValue } from './security.js';
import {
  assertProtectedChangePolicy,
  configuredProtectedFiles,
  consumeControlPlaneApproval,
  releaseControlPlaneApproval,
  requireApprovedControlPlaneChange,
  reserveControlPlaneApproval
} from './control-plane.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'worker-receipt.schema.json');

function parseClaudeOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.structured_output ?? parsed.result?.structured_output ?? parsed;
}

export async function parseWorkerReceipt({ provider, stdout, outputPath, maxBytes = 2 * 1024 * 1024 }) {
  if (provider.adapter === 'codex') {
    const raw = await readBoundedRegularFile(outputPath, { maxBytes });
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch (error) {
      // Keep the malformed file: it is the only evidence of what the worker
      // actually produced.
      throw new Error(`Worker receipt at ${outputPath} is not valid JSON: ${error.message}`);
    }
    await unlink(outputPath).catch(() => {});
    return parsed;
  }
  if (Buffer.byteLength(stdout ?? '', 'utf8') > maxBytes) throw new Error(`Worker receipt exceeds size limit of ${maxBytes} bytes`);
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

function modelUsePlan(host, lane, routePlan) {
  return {
    host: {
      provider: host.provider ?? null,
      requestedModel: host.requestedModel ?? null,
      resolvedModel: host.resolvedModel ?? null,
      requestedEffort: host.requestedEffort ?? null,
      effectiveEffort: host.effectiveEffort ?? null,
      selectionMode: host.selectionMode ?? null,
      executionMode: host.executionMode ?? 'bootstrap-only'
    },
    lane: lane.lane,
    externalModelCalls: 1,
    executor: {
      provider: routePlan.primary.provider,
      model: routePlan.primary.model,
      modelRevision: routePlan.primary.modelRevision ?? routePlan.primary.model,
      effort: routePlan.primary.effort,
      profileId: routePlan.primary.profileId,
      execution: routePlan.primary.execution
    },
    shadow: routePlan.shadow ? {
      provider: routePlan.shadow.provider,
      model: routePlan.shadow.model,
      modelRevision: routePlan.shadow.modelRevision ?? routePlan.shadow.model,
      effort: routePlan.shadow.effort,
      profileId: routePlan.shadow.profileId,
      mode: routePlan.shadow.mode,
      execute: false,
      evidenceStatus: routePlan.shadow.evidenceStatus ?? 'counterfactual-only'
    } : null,
    prompt: null,
    verification: null,
    reviews: [],
    escalations: []
  };
}

async function appendInitialTrace({ tracePath, host, lane, routePlan, manifest }) {
  await appendTraceEvent(tracePath, {
    type: 'host', role: 'host', provider: host.provider,
    requestedModel: host.requestedModel, resolvedModel: host.resolvedModel,
    requestedEffort: host.requestedEffort, effectiveEffort: host.effectiveEffort,
    selectionMode: host.selectionMode, executionMode: host.executionMode ?? 'bootstrap-only'
  });
  await appendTraceEvent(tracePath, {
    type: 'route', role: 'router', lane: lane.lane,
    provider: routePlan.primary.provider, model: routePlan.primary.model,
    modelRevision: routePlan.primary.modelRevision ?? routePlan.primary.model,
    effort: routePlan.primary.effort, profileId: routePlan.primary.profileId,
    execution: routePlan.primary.execution
  });
  if (routePlan.shadow) {
    await appendTraceEvent(tracePath, {
      type: 'shadow', role: 'shadow', mode: routePlan.shadow.mode, execute: false,
      provider: routePlan.shadow.provider, model: routePlan.shadow.model,
      modelRevision: routePlan.shadow.modelRevision ?? routePlan.shadow.model,
      effort: routePlan.shadow.effort, profileId: routePlan.shadow.profileId,
      reason: routePlan.shadow.reason,
      evidenceStatus: routePlan.shadow.evidenceStatus ?? 'counterfactual-only'
    });
  }
  await appendTraceEvent(tracePath, {
    type: 'prompt', role: 'executor', provider: manifest.provider, model: manifest.model,
    modelRevision: manifest.modelRevision, effort: manifest.effort,
    promptProfileId: manifest.promptProfileId, promptSha256: manifest.promptSha256
  });
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
  timeoutMs,
  verificationTimeoutMs,
  host = {},
  lane = null,
  shadowMode = 'off',
  promptProfiles = null,
  dryRun = false
}) {
  task = validateTask(task, { forExecution: true });
  const protectedFiles = configuredProtectedFiles({ config, cwd, stateRoot });
  const snapshotEvidenceFiles = [...new Set([
    ...(task.evidenceFiles ?? []),
    ...protectedFiles
  ])].sort();
  // Validate approval before prompt compilation or dry-run output. A dry-run
  // may inspect authorization, but it never reserves or consumes it.
  await requireApprovedControlPlaneChange({ root: stateRoot, task });
  const hostContext = normalizeHostContext(host, process.env, config.hostPolicy ?? {});
  const laneDecision = resolveExecutionLane({
    task,
    policy: config.lanePolicy,
    protectedFiles,
    requestedLane: lane?.lane ?? task.executionLane,
    requestedReason: lane?.reason ?? task.laneReason
  });
  const routePlan = selectRoutePlan({
    task,
    catalog: config,
    observations,
    host: hostContext,
    lane: laneDecision,
    shadowMode
  });
  const route = routePlan.primary;
  const capabilities = selectCapabilities({
    requestedIds: task.capabilityIds ?? [],
    inventory: config.capabilities,
    provider: route.provider,
    limits: config.capabilityLimits,
    task,
    policy: config.controlPlane ?? {}
  });
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(stateRoot, 'task-runs', runId, task.id);
  const receiptPath = path.join(runDir, 'receipt.json');
  const outputPath = path.join(runDir, 'worker-output.json');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const promptManifestPath = path.join(runDir, 'prompt-manifest.json');
  const tracePath = path.join(runDir, 'trace.jsonl');
  const schema = JSON.parse(await readFile(RECEIPT_SCHEMA_PATH, 'utf8'));
  const workerTimeoutMs = timeoutMs ?? config.execution?.workerTimeoutMs ?? 60 * 60 * 1000;
  const workerKillGraceMs = config.execution?.killGraceMs ?? 1000;
  const workerMaxOutputBytes = config.execution?.maxOutputBytes ?? 10 * 1024 * 1024;
  const workerMaxReceiptBytes = config.execution?.maxReceiptBytes ?? 2 * 1024 * 1024;


  const provider = providerById(config, route.provider);
  const modelProfile = config.models.find((entry) => entry.id === route.profileId);
  let promptProfile = null;
  let compiled;
  if ((modelProfile?.promptProfileIds?.length ?? 0) > 0) {
    const availableProfiles = promptProfiles ?? await loadPromptProfiles();
    promptProfile = resolvePromptProfile({
      route,
      modelProfile,
      profiles: availableProfiles,
      role: task.role,
      taskKind: task.kind,
      policy: config.promptCompilation ?? {}
    });
    compiled = compileWorkerPrompt({
      task,
      route,
      profile: promptProfile,
      capabilities,
      receiptPath,
      lane: laneDecision
    });
  } else {
    // Enforce the documented invariant "delegated prompts are compiled from a
    // provider-owned official profile" for the official-profile providers. A
    // claude/codex model configured without promptProfileIds would otherwise
    // silently fall back to the generic contract and bypass official
    // compilation while officialSourcesOnly is true. The generic adapter is the
    // explicit, lower-trust exception and keeps the generic contract.
    if ((config.promptCompilation?.officialSourcesOnly ?? true) && ['claude', 'codex'].includes(provider.adapter)) {
      throw new Error(`Model ${route.profileId} on official-source provider ${route.provider} must declare promptProfileIds; refusing to bypass official prompt compilation while promptCompilation.officialSourcesOnly is true`);
    }
    const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath });
    compiled = {
      prompt,
      manifest: createPromptManifest({
        prompt,
        task,
        route,
        profile: null,
        lane: laneDecision,
        capabilities,
        execution: 'delegated'
      })
    };
  }
  assertCompiledPrompt({
    task,
    prompt: compiled.prompt,
    profile: promptProfile,
    capabilities,
    lane: laneDecision,
    maxChars: config.promptCompilation?.maxChars ?? 40_000
  });
  const prompt = compiled.prompt;

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

  if (dryRun) return {
    task,
    host: hostContext,
    lane: laneDecision,
    routePlan,
    route,
    shadow: routePlan.shadow,
    capabilities,
    provider,
    promptProfile,
    promptManifest: compiled.manifest,
    compiledPrompt: prompt,
    commandSpec,
    receiptPath,
    runDir
  };

  await enforceWriteIsolation(task, cwd);
  const ignoredPaths = ignoredRunPath(cwd, runDir);
  const intervalMs = (config.progress?.intervalMinutes ?? 30) * 60 * 1000;
  const commandTimeoutMs = verificationTimeoutMs
    ?? config.verification?.commandTimeoutMs
    ?? 15 * 60 * 1000;
  const isolationMode = task.verificationIsolation
    ?? config.verification?.isolationByRisk?.[task.risk]
    ?? 'same-workspace';
  let progressFraction = 0.1;
  const plannedModelUse = modelUsePlan(hostContext, laneDecision, routePlan);
  const reporter = new ProgressReporter({ onReport: onProgress, intervalMs });
  let controlApproval = null;
  let approvalConsumed = false;

  try {
    // Reserve before the workspace snapshot: the reservation rewrites the
    // retrospective under the state dir, and when that file is visible to git
    // a post-snapshot mutation would surface as an unclaimed mid-task change
    // and deterministically fail claim and protected-change checks.
    controlApproval = await reserveControlPlaneApproval({ root: stateRoot, task });
    const beforeState = await captureWorkspaceState(cwd, {
      ignorePaths: ignoredPaths,
      evidenceFiles: snapshotEvidenceFiles
    });
    await mkdir(runDir, { recursive: true });
    await writePromptManifest(promptManifestPath, compiled.manifest);
    await appendInitialTrace({ tracePath, host: hostContext, lane: laneDecision, routePlan, manifest: compiled.manifest });
    reporter.start(() => [{
      id: task.id, weight: task.weight ?? 1, status: 'running', fraction: progressFraction,
      lane: laneDecision.lane, modelUse: plannedModelUse
    }]);
    const result = await runCommand(commandSpec, { cwd, timeoutMs: workerTimeoutMs, killGraceMs: workerKillGraceMs, maxOutputBytes: workerMaxOutputBytes });
    await appendTraceEvent(tracePath, {
      type: 'execution', role: 'executor', provider: route.provider, model: route.model,
      modelRevision: route.modelRevision ?? route.model, effort: route.effort,
      status: result.status, exitCode: result.exitCode, terminationReason: result.terminationReason ?? null
    });
    await atomicWriteText(stdoutPath, redactSecrets(result.stdout));
    await atomicWriteText(stderrPath, redactSecrets(result.stderr));
    await atomicWriteJson(path.join(runDir, 'execution.json'), redactValue({ ...result, stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr) }));

    // exitCode alone is not success: a timed-out, aborted, or output-truncated
    // worker can still exit 0 after SIGTERM, and its stdout receipt may be
    // truncated mid-stream yet parse as JSON.
    if (result.exitCode !== 0 || result.terminationReason) {
      const cause = result.terminationReason
        ? `was terminated (${result.terminationReason})`
        : result.signal
          ? `was killed by ${result.signal}`
          : `exited with ${result.exitCode}`;
      throw new Error(`Worker ${cause}; evidence: ${stderrPath}`);
    }

    progressFraction = 0.7;
    reporter.meaningfulUpdate();
    const receipt = validateReceipt(
      await parseWorkerReceipt({ provider, stdout: result.stdout, outputPath, maxBytes: workerMaxReceiptBytes }),
      { task }
    );
    await atomicWriteJson(receiptPath, redactValue(receipt));
    const afterState = await captureWorkspaceState(cwd, {
      ignorePaths: ignoredPaths,
      evidenceFiles: snapshotEvidenceFiles
    });
    const changedPaths = changedPathsBetween(beforeState, afterState) ?? [];
    assertProtectedChangePolicy({
      task,
      changedPaths,
      protectedFiles,
      approval: controlApproval
    });

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
        totalTimeoutMs: config.verification?.totalTimeoutMs ?? 30 * 60 * 1000,
        maxOutputBytes: config.verification?.maxOutputBytes ?? 8 * 1024 * 1024,
        maxChecks: config.verification?.maxChecks ?? 20,
        isolationMode,
        onStep: (completed) => {
          progressFraction = totalChecks > 0 ? 0.7 + (0.29 * completed / totalChecks) : 0.99;
          reporter.meaningfulUpdate();
        }
      });
      await appendTraceEvent(tracePath, {
        type: 'verification', role: 'verifier', status: attestation.status,
        evidenceCount: attestation.checks?.length ?? 0
      });
      if (task.controlPlaneChange === true && attestation.status === 'pass') {
        await consumeControlPlaneApproval({
          root: stateRoot,
          approval: controlApproval,
          taskId: task.id,
          evidence: [attestation.path ?? attestation.evidenceDigest]
        });
        approvalConsumed = true;
      }
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
    // An inconclusive attestation means nothing independent stands behind the
    // claim; never report high confidence on the worker's word alone.
    const finalConfidence = finalPhase !== 'complete' || attestation?.status === 'inconclusive'
      ? 'low'
      : (confidenceValue >= 0.8 ? 'high' : confidenceValue >= 0.5 ? 'medium' : 'low');
    const evidenceCount = (receipt.commands?.length ?? 0)
      + (receipt.criteria?.length ?? 0)
      + (attestation?.checks?.length ?? 0);
    const modelUse = summarizeTrace(await readTrace(tracePath));
    onProgress({
      percent: finalPercent,
      label: 'estimated',
      reason: receipt.status,
      phase: finalPhase,
      confidence: finalConfidence,
      evidenceCount,
      lastEvidenceAt: new Date().toISOString(),
      blockers: (receipt.unresolvedRisks ?? []).map((message) => ({ taskId: task.id, message })),
      activeTaskIds: [],
      lane: laneDecision.lane,
      modelUse
    });
    return {
      task,
      host: hostContext,
      lane: laneDecision,
      routePlan,
      route,
      shadow: routePlan.shadow,
      capabilities,
      promptProfile,
      promptManifest: compiled.manifest,
      promptManifestPath,
      tracePath,
      modelUse,
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
      activeTaskIds: [],
      lane: laneDecision.lane,
      modelUse: plannedModelUse
    });
    throw error;
  } finally {
    reporter.stop();
    if (controlApproval && !approvalConsumed) {
      await releaseControlPlaneApproval({
        root: stateRoot,
        approval: controlApproval,
        taskId: task.id
      }).catch(() => {});
    }
  }
}
