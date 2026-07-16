import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReceipt } from '../src/receipt.js';

const task = {
  id: 'T1', objective: 'Implement parser', kind: 'implementation', role: 'executor',
  risk: 'standard', write: true, allowedScope: ['src/**'],
  acceptanceCriteria: ['parser rejects malformed input'],
  verificationCommands: ['node --test test/parser.test.js']
};

function validReceipt(overrides = {}) {
  return {
    status: 'complete',
    summary: 'Implemented and verified parser validation.',
    filesInspected: ['src/parser.js'],
    filesChanged: ['src/parser.js'],
    commands: [{ command: 'node --test test/parser.test.js', exitCode: 0, outcome: '1 test passed' }],
    criteria: [{ criterion: 'parser rejects malformed input', status: 'pass', evidence: 'parser.test.js passed' }],
    unresolvedRisks: [],
    confidence: 0.94,
    ...overrides
  };
}

test('accepts a complete receipt only when criteria, verification, and scope are evidenced', () => {
  const receipt = validateReceipt(validReceipt(), { task });
  assert.equal(receipt.status, 'complete');
});

test('rejects a complete receipt with failed or missing acceptance evidence', () => {
  assert.throws(() => validateReceipt(validReceipt({
    criteria: [{ criterion: 'parser rejects malformed input', status: 'fail', evidence: 'still fails' }]
  }), { task }), /acceptance criterion/i);
  assert.throws(() => validateReceipt(validReceipt({ criteria: [] }), { task }), /acceptance criterion/i);
});

test('rejects a complete receipt when required verification did not pass', () => {
  assert.throws(() => validateReceipt(validReceipt({
    commands: [{ command: 'node --test test/parser.test.js', exitCode: 1, outcome: 'failed' }]
  }), { task }), /verification command/i);
});

test('rejects write claims outside the allowed scope and any write claim for read-only tasks', () => {
  assert.throws(() => validateReceipt(validReceipt({ filesChanged: ['package.json'] }), { task }), /allowed scope/i);
  assert.throws(() => validateReceipt(validReceipt({ filesChanged: ['src/parser.js'] }), {
    task: { ...task, write: false }
  }), /read-only/i);
});

test('rejects unknown fields instead of accepting an ambiguous receipt shape', () => {
  assert.throws(() => validateReceipt({ ...validReceipt(), extraClaim: true }, { task }), /unknown field/i);
});
