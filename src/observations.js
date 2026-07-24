import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeObservation } from './performance-store.js';

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

// Plain append-only JSONL: one reviewed observation per line. A personal tool's
// evidence log does not need checksums or sequence-numbered envelopes.
async function readJsonl(filePath) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { records: [], endsWithNewline: true };
    throw error;
  }
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new Error(`Invalid observation ${filePath} at line ${index + 1}: ${error.message}`);
    }
  }
  return { records, endsWithNewline: raw.length === 0 || raw.endsWith('\n') };
}

export async function readObservations(filePath) {
  const { records } = await readJsonl(filePath);
  return records.map((entry, index) => {
    try { return normalizeObservation(entry); }
    catch (error) { throw new Error(`Invalid observation record ${index + 1}: ${error.message}`); }
  });
}

export async function appendObservation(filePath, input) {
  const quality = input.quality ?? verdictToQuality(input.verdict);
  const observation = normalizeObservation({
    ...input,
    quality,
    reviewed: true,
    recordedAt: input.recordedAt ?? new Date().toISOString()
  });
  const { endsWithNewline } = await readJsonl(filePath);
  const record = { recordedAt: observation.recordedAt, ...observation };
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a', 0o600);
  try {
    // A torn tail line has no trailing newline; start a fresh line so the new
    // record is not glued onto a partially written fragment.
    await handle.writeFile(`${endsWithNewline ? '' : '\n'}${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return observation;
}
