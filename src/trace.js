import { appendJournalRecord, readJournal } from './file-store.js';

const TYPES = new Set(['host', 'route', 'shadow', 'prompt', 'execution', 'verification', 'review', 'escalation']);
const ROLES = new Set(['host', 'router', 'executor', 'reviewer', 'verifier', 'shadow']);

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`trace.${field} must be a non-empty string or null`);
  return value.trim();
}

export function normalizeTraceEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('trace event must be an object');
  if (!TYPES.has(input.type)) throw new Error(`Unsupported trace event type: ${input.type}`);
  if (!ROLES.has(input.role)) throw new Error(`Unsupported trace event role: ${input.role}`);
  if (input.type === 'shadow' && input.mode === 'record-only' && input.execute !== false) {
    throw new Error('A record-only shadow event requires execute=false');
  }
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (Number.isNaN(new Date(recordedAt).getTime())) throw new TypeError('trace.recordedAt must be a valid date');
  return {
    ...structuredClone(input),
    provider: optionalString(input.provider, 'provider'),
    model: optionalString(input.model, 'model'),
    modelRevision: optionalString(input.modelRevision, 'modelRevision'),
    effort: optionalString(input.effort, 'effort'),
    profileId: optionalString(input.profileId, 'profileId'),
    recordedAt: new Date(recordedAt).toISOString()
  };
}

export async function appendTraceEvent(filePath, input) {
  const event = normalizeTraceEvent(input);
  await appendJournalRecord(filePath, event, { recordedAt: event.recordedAt });
  return event;
}

export async function readTrace(filePath) {
  const journal = await readJournal(filePath);
  return journal.records.map(normalizeTraceEvent);
}

export function summarizeTrace(events = []) {
  const summary = {
    host: { provider: null, requestedModel: null, resolvedModel: null, requestedEffort: null, effectiveEffort: null, selectionMode: null, executionMode: null },
    lane: null,
    externalModelCalls: 0,
    executor: null,
    shadow: null,
    prompt: null,
    verification: null,
    reviews: [],
    escalations: []
  };
  for (const event of events) {
    if (event.type === 'host') {
      summary.host = {
        provider: event.provider ?? null,
        requestedModel: event.requestedModel ?? null,
        resolvedModel: event.resolvedModel ?? event.model ?? null,
        requestedEffort: event.requestedEffort ?? null,
        effectiveEffort: event.effectiveEffort ?? event.effort ?? null,
        selectionMode: event.selectionMode ?? null,
        executionMode: event.executionMode ?? null
      };
    } else if (event.type === 'route') {
      summary.lane = event.lane ?? summary.lane;
      summary.executor = {
        provider: event.provider,
        model: event.model,
        modelRevision: event.modelRevision,
        effort: event.effort,
        profileId: event.profileId,
        execution: event.execution ?? 'delegated'
      };
      if ((event.execution ?? 'delegated') === 'delegated') summary.externalModelCalls += 1;
    } else if (event.type === 'shadow') {
      summary.shadow = {
        provider: event.provider,
        model: event.model,
        modelRevision: event.modelRevision,
        effort: event.effort,
        profileId: event.profileId,
        mode: event.mode,
        execute: event.execute,
        evidenceStatus: event.evidenceStatus ?? (event.execute === false ? 'counterfactual-only' : null)
      };
    } else if (event.type === 'prompt') {
      summary.prompt = {
        promptProfileId: event.promptProfileId ?? null,
        promptSha256: event.promptSha256 ?? null
      };
    } else if (event.type === 'verification') {
      summary.verification = {
        status: event.status ?? null,
        evidenceCount: event.evidenceCount ?? 0
      };
    } else if (event.type === 'review') {
      summary.reviews.push(event);
      if (event.provider && event.model && event.execute !== false) summary.externalModelCalls += 1;
    } else if (event.type === 'escalation') {
      summary.escalations.push(event);
      if (event.provider && event.model && event.execute !== false) summary.externalModelCalls += 1;
    }
  }
  return summary;
}

function identity(provider, model) {
  return provider && model ? `${provider}/${model}` : 'unknown';
}

export function formatTraceSummary(summary) {
  const lines = [
    `Host: ${identity(summary.host?.provider, summary.host?.resolvedModel)}${summary.host?.effectiveEffort ? ` effort=${summary.host.effectiveEffort}` : ''}${summary.host?.executionMode ? ` mode=${summary.host.executionMode}` : ''}`,
    `Lane: ${summary.lane ?? 'unknown'}`,
    `Executor: ${identity(summary.executor?.provider, summary.executor?.model)}${summary.executor?.effort ? ` effort=${summary.executor.effort}` : ''}`,
    `External model calls: ${summary.externalModelCalls ?? 0}`
  ];
  if (summary.shadow) lines.push(`Shadow: ${identity(summary.shadow.provider, summary.shadow.model)} mode=${summary.shadow.mode} executed=${summary.shadow.execute}`);
  if (summary.verification) lines.push(`Verifier: ${summary.verification.status} evidence=${summary.verification.evidenceCount}`);
  return lines.join('\n');
}
