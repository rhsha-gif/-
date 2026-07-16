const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

function completionFraction(task) {
  if (['complete', 'accepted', 'done'].includes(task.status)) return 1;
  if (['cancelled', 'skipped'].includes(task.status)) return 1;
  if (task.status === 'running' || task.status === 'verifying') {
    const fraction = Number(task.fraction ?? 0);
    return Math.min(0.99, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  }
  return 0;
}

function progressPhase(tasks) {
  if (tasks.length === 0 || tasks.every((task) => ['complete', 'accepted', 'done', 'cancelled', 'skipped'].includes(task.status))) return 'complete';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  if (tasks.some((task) => task.status === 'verifying')) return 'verifying';
  if (tasks.some((task) => task.status === 'running')) return 'executing';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  return 'planning';
}

function progressConfidence(tasks, phase) {
  if (phase === 'blocked' || phase === 'failed') return 'low';
  if (phase === 'complete') return 'high';
  const values = tasks.map((task) => Number(task.progressConfidence))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  if (values.length === 0) return 'medium';
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return mean >= 0.8 ? 'high' : mean >= 0.5 ? 'medium' : 'low';
}

function evidenceCount(task) {
  if (Number.isInteger(task.evidenceCount) && task.evidenceCount >= 0) return task.evidenceCount;
  if (Array.isArray(task.evidence)) return task.evidence.length;
  return 0;
}

export function calculateProgress(tasks = []) {
  const normalized = tasks.map((task) => ({
    ...task,
    weight: Number.isFinite(Number(task.weight)) && Number(task.weight) > 0 ? Number(task.weight) : 1
  }));
  const totalWeight = normalized.reduce((sum, task) => sum + task.weight, 0);
  const completedWeight = normalized.reduce(
    (sum, task) => sum + task.weight * completionFraction(task),
    0
  );
  const ratio = totalWeight > 0 ? completedWeight / totalWeight : 1;
  const phase = progressPhase(normalized);
  const blockers = normalized
    .filter((task) => ['blocked', 'failed'].includes(task.status) || task.blocker)
    .map((task) => ({ taskId: task.id, message: task.blocker ?? task.note ?? 'Task is blocked.' }));
  const evidenceTimestamps = normalized
    .map((task) => task.lastEvidenceAt)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort();
  return {
    percent: Math.round(ratio * 100),
    label: 'estimated',
    phase,
    confidence: progressConfidence(normalized, phase),
    blockers,
    evidenceCount: normalized.reduce((sum, task) => sum + evidenceCount(task), 0),
    lastEvidenceAt: evidenceTimestamps.at(-1) ?? null,
    completedWeight,
    totalWeight,
    activeTaskIds: normalized
      .filter((task) => task.status === 'running' || task.status === 'verifying')
      .map((task) => task.id)
  };
}

function inlineText(value, fallback, maximum = 500) {
  const normalized = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

export function formatProgressReport(entry = {}) {
  const blockers = Array.isArray(entry.blockers) && entry.blockers.length > 0
    ? entry.blockers.map((blocker) => `${inlineText(blocker.taskId, 'task', 80)}: ${inlineText(blocker.message, 'blocked')}`).join('; ')
    : 'none';
  const percentValue = Number(entry.percent ?? 0);
  const percent = Number.isFinite(percentValue) ? Math.max(0, Math.min(100, percentValue)) : 0;
  return `[aorch] ${inlineText(entry.label, 'estimated', 40)} progress ${percent}%` +
    ` phase=${inlineText(entry.phase, 'unknown', 40)}` +
    ` confidence=${inlineText(entry.confidence, 'unknown', 40)}` +
    ` evidence=${Number.isFinite(Number(entry.evidenceCount)) ? Math.max(0, Number(entry.evidenceCount)) : 0}` +
    ` lastEvidenceAt=${inlineText(entry.lastEvidenceAt, 'none', 80)}` +
    ` blockers=${blockers}`;
}

export class ProgressReporter {
  constructor({
    onReport,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    intervalMs = DEFAULT_INTERVAL_MS
  } = {}) {
    if (typeof onReport !== 'function') throw new TypeError('onReport callback is required');
    this.onReport = onReport;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.snapshotFn = null;
  }

  report(reason = 'interval') {
    if (!this.snapshotFn) return null;
    const entry = {
      ...calculateProgress(this.snapshotFn()),
      reason,
      reportedAt: new Date().toISOString()
    };
    this.onReport(entry);
    return entry;
  }

  start(snapshotFn) {
    if (typeof snapshotFn !== 'function') throw new TypeError('snapshotFn is required');
    this.stop();
    this.snapshotFn = snapshotFn;
    this.report('start');
    this.timer = this.setIntervalFn(() => this.report('interval'), this.intervalMs);
    return this.timer;
  }

  meaningfulUpdate() {
    return this.report('state-change');
  }

  stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

export { DEFAULT_INTERVAL_MS };
