# Weekly local evaluation

The weekly evaluator turns locally recorded execution and independent gate evidence into a reviewable routing policy. It does not call a model or a network service, edit the canonical aorch config, or store prompts, transcripts, command output, credentials, or file contents in user-level learning state.

## Evidence contract

`recordRunEvidence({ root, stateRoot?, evidence, now?, homeDir?, attest? })` appends one version 1 record to `<stateRoot>/run-evidence.jsonl`. `stateRoot` defaults to `<root>/.aorch` and may be an absolute path for a project with a configured state directory. The controller passes `attest: true`; ordinary callers leave it false.

Each record has this exact shape:

```json
{
  "schemaVersion": 1,
  "projectId": "stable-project-id",
  "taskId": "T-1",
  "runId": "run-id",
  "attempt": 1,
  "recordedAt": "2026-09-14T00:00:00.000Z",
  "route": {
    "provider": "openai",
    "adapter": "codex",
    "profileId": "codex-terra-general",
    "model": "gpt-5.6-terra",
    "effort": "high"
  },
  "task": {
    "kind": "implementation",
    "role": "executor",
    "risk": "standard",
    "complexity": "standard",
    "explicitModelPin": false
  },
  "execution": {
    "status": "complete",
    "completed": true,
    "durationMs": 120000,
    "reworkDurationMs": 15000,
    "inputTokens": 1000,
    "outputTokens": 500,
    "reasoningTokens": 100,
    "cacheReadTokens": 300,
    "cacheCreationTokens": 50,
    "totalTokens": 1500
  },
  "artifact": { "status": "pass" },
  "evaluation": {
    "source": "independent-gate",
    "status": "pass",
    "quality": 1,
    "synthetic": false,
    "target": "task-output"
  }
}
```

`projectId + runId + taskId + attempt` is the stable identity. The evaluator prefers the controller record for an identity and deduplicates copied logs and resumed attempts. Producers should reuse all four fields when resuming the same attempt and increment `attempt` only for a new attempt.

Execution completion and artifact status are separate. A reviewer can complete successfully and find that the subject artifact fails; record `execution.completed: true`, `artifact.status: "fail"`, and an independent evaluation of the review itself as `evaluation.status: "pass"`. Finding a defect is not a reviewer failure.

`execution.status` is `complete`, `partial`, `blocked`, `awaiting-input`, or `failed`. Failed execution also requires `failureKind`: `authentication`, `rate-limit`, `network`, `timeout`, `protocol`, `execution`, or `action-required`. Authentication, quota, network, tool availability, required action, and user-input waits stay unscored. Token fields are non-negative integer counts obtained from the provider; omit them when the provider did not report actual counts. The report pairs sums with `metrics.observedCounts` so an omitted count is not presented as measured zero. Do not substitute character estimates.

An independent evaluation is optional. Its status is `pass`, `minor`, `major`, `fail`, `unavailable`, or `error`. Only a real `independent-gate` result on a completed low or standard risk and complexity task is eligible for routing learning. Synthetic fixtures, unavailable/error results, high or critical work, and explicit model pins remain report-only. A reviewer or `review` task with quality below 1 is also report-only unless the independent evaluation explicitly sets `target: "reviewer-output"`; a failed subject artifact can mean the reviewer correctly found a defect.

With `attest: true`, the controller atomically writes a version 2 record containing the full normalized evidence and its digest under `<home>/.aorch/learning/controller-evidence/`. Weekly evaluation enumerates these controller records as its canonical attested source, so deleting a project-local mirror cannot hide an attested failure. It prefers controller records for operational deduplication and accepts a project-local run for quality only when its exact normalized digest matches. Digest-only version 1 controller records are validated but remain unscored; an explicit controller attestation of the same evidence upgrades the record to version 2. Policy reads rederive stored observations from the referenced controller records and fail closed on a missing or mismatched record. Unattested and tampered workspace records remain available for operational counts but cannot affect routing. Legacy observation rows have no controller record and are likewise unscored. The controller directory stores no prompts, transcripts, command output, credentials, or file contents. This boundary trusts the controller process and every process running as the same OS user. It is not tamperproof and does not protect against a malicious or compromised same-user process.

The schema rejects extra fields so free-form content cannot drift into the telemetry log. `readRunEvidence({ root, stateRoot? })` returns `{ filePath, available, records }`; a missing file is explicitly unavailable and malformed JSON or an invalid record throws.

## Root registry

`registerWorkRoot(root, { homeDir?, stateRoot?, now? })` atomically records a work root in `<home>/.aorch/learning/work-roots.json`. This is separate from `<home>/.aorch/installs.json`; registration never changes install bookkeeping. `readRegisteredWorkRoots({ homeDir? })` returns the registered entries.

Weekly evaluation reads three root sources in deterministic path order:

- roots explicitly passed to `evaluateWeekly`;
- the learning work-root registry;
- project paths already present in the read-only install registry.

An explicit root can be a string or `{ root, stateRoot }`. Missing roots and missing `run-evidence.jsonl`, `observations.jsonl`, or `task-runs` sources are marked unavailable in the report. They are not converted to zero-success projects. Corrupt registries and logs stop evaluation with the affected path in the error.

## Weekly evaluation and policy

Call:

```js
const { report, policy, applied } = await evaluateWeekly({
  roots,
  homeDir,
  apply: false,
  now: new Date(),
  config
});
```

Historic receipts and `verification.json` files contribute execution-complete and artifact pass/fail/unscored counts. They never create quality observations by inference. Existing `.aorch/observations.jsonl` entries have no controller record, so they remain visible as unscored legacy evidence and cannot adjust routing.

The policy groups eligible observations by provider, model, effort, and task kind. A group is emitted after at least five accumulated independently verified observations; it does not require five observations in one week. The report separately records seven-day activity. Its estimate calls `estimateRouteQuality` with a 30-day half-life and prior weight 3. The group stores the approved normalized observations that produced the estimate. The estimate mean is a report field and must not be converted into another observation, because that would apply the prior twice.

`apply: false` is read-only. `apply: true` writes an immutable version to `<home>/.aorch/learning/policies/` and atomically updates `current-policy.json` only when a route meets the accumulated sample policy and carries approved evidence not present in the current version. Re-running with the same evidence is a no-op regardless of the new report or decay timestamp. An empty week makes no policy change. Policy and pointer reads validate their versioned schemas and fail closed on corruption.

Use `readWeeklyPolicy({ homeDir, version? })` to read the current or a named version and `restoreWeeklyPolicy({ homeDir, version })` to atomically point back to a validated version.

The router integration consumes raw policy observations:

```js
const observations = policyObservations(policy, task, { minimumSamples });
```

Always pass the task. The helper returns an empty list for high or critical risk/complexity work and for explicit profile/model pins, including `allowedProfileIds`. Feed the returned observations to the existing router observation input. Do not write `routeGroups[].estimate.mean` into `config.models[].quality` and do not edit canonical config as part of evaluation.
