import { normalizeObservation } from './performance-store.js';
import { appendJournalRecord, readJournal } from './file-store.js';

const VERDICT_QUALITY = Object.freeze({
  approved: 1,
  minor: 0.85,
  major: 0.55,
  failed: 0.2,
  unsafe: 0
});

export function verdictToQuality(verdict) {
  if (!(verdict in VERDICT_QUALITY)) throw new Error(`Unknown verdict: ${verdict}`);
  return VERDICT_QUALITY[verdict];
}

export async function readObservations(filePath) {
  const journal = await readJournal(filePath);
  return journal.records.map((entry, index) => {
    try { return normalizeObservation(entry); }
    catch (error) { throw new Error(`Invalid observation record ${index + 1}: ${error.message}`); }
  });
}

export async function appendObservation(filePath, input) {
  // `aorch record` asserts an independently reviewed observation; silently
  // flipping an explicit reviewed:false to true would launder an unreviewed
  // sample into route evidence. Reject it instead.
  if (input.reviewed === false) {
    throw new Error('aorch record only accepts independently reviewed observations; refusing to record reviewed:false');
  }
  const quality = input.quality ?? verdictToQuality(input.verdict);
  const observation = normalizeObservation({
    ...input,
    quality,
    reviewed: true,
    recordedAt: input.recordedAt ?? new Date().toISOString()
  });
  await appendJournalRecord(filePath, observation, { recordedAt: observation.recordedAt });
  return observation;
}
