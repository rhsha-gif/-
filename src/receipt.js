import path from 'node:path';

const TOP_LEVEL_FIELDS = new Set([
  'status', 'summary', 'filesInspected', 'filesChanged', 'commands', 'criteria', 'unresolvedRisks', 'confidence'
]);
const COMMAND_FIELDS = new Set(['command', 'exitCode', 'outcome']);
const CRITERION_FIELDS = new Set(['criterion', 'status', 'evidence']);
const STATUSES = new Set(['complete', 'partial', 'blocked']);
const CRITERION_STATUSES = new Set(['pass', 'fail', 'not-run']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

function normalizeProjectPath(value, label) {
  requireNonEmptyString(value, label);
  const slashPath = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slashPath)) throw new Error(`${label} must be project-relative`);
  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`${label} escapes the project root`);
  return normalized;
}

function globToRegExp(pattern) {
  const normalized = normalizeProjectPath(pattern, 'scope pattern');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        // A leading `**/` matches zero or more path segments, so `**/x` must
        // also match a top-level `x`; make the following slash optional.
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

function matchesAnyScope(filePath, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

function validateCommands(commands) {
  if (!Array.isArray(commands)) throw new TypeError('receipt.commands must be an array');
  return commands.map((entry, index) => {
    assertPlainObject(entry, `receipt.commands[${index}]`);
    rejectUnknownFields(entry, COMMAND_FIELDS, `receipt.commands[${index}]`);
    requireNonEmptyString(entry.command, `receipt.commands[${index}].command`);
    if (entry.exitCode !== null && !Number.isInteger(entry.exitCode)) {
      throw new TypeError(`receipt.commands[${index}].exitCode must be an integer or null`);
    }
    requireNonEmptyString(entry.outcome, `receipt.commands[${index}].outcome`);
    return entry;
  });
}

function validateCriteria(criteria) {
  if (!Array.isArray(criteria)) throw new TypeError('receipt.criteria must be an array');
  return criteria.map((entry, index) => {
    assertPlainObject(entry, `receipt.criteria[${index}]`);
    rejectUnknownFields(entry, CRITERION_FIELDS, `receipt.criteria[${index}]`);
    requireNonEmptyString(entry.criterion, `receipt.criteria[${index}].criterion`);
    if (!CRITERION_STATUSES.has(entry.status)) {
      throw new Error(`Invalid receipt criterion status: ${entry.status}`);
    }
    requireNonEmptyString(entry.evidence, `receipt.criteria[${index}].evidence`);
    return entry;
  });
}

function validateCompletionEvidence(receipt, task) {
  if (receipt.status !== 'complete') return;

  const criteriaByName = new Map(receipt.criteria.map((entry) => [entry.criterion, entry]));
  for (const expected of task?.acceptanceCriteria ?? []) {
    const evidence = criteriaByName.get(expected);
    if (!evidence || evidence.status !== 'pass') {
      throw new Error(`Complete receipt lacks passing acceptance criterion evidence: ${expected}`);
    }
  }
  const incompleteCriterion = receipt.criteria.find((entry) => entry.status !== 'pass');
  if (incompleteCriterion) {
    throw new Error(`Complete receipt contains non-passing acceptance criterion: ${incompleteCriterion.criterion}`);
  }

  const commandsByText = new Map(receipt.commands.map((entry) => [entry.command, entry]));
  for (const expected of task?.verificationCommands ?? []) {
    const evidence = commandsByText.get(expected);
    if (!evidence || evidence.exitCode !== 0) {
      throw new Error(`Complete receipt lacks passing verification command evidence: ${expected}`);
    }
  }
}

function validateChangedFiles(receipt, task) {
  const changed = receipt.filesChanged.map((entry, index) => normalizeProjectPath(entry, `receipt.filesChanged[${index}]`));
  if (task?.write !== true && changed.length > 0) {
    throw new Error('Read-only task receipt cannot claim changed files');
  }
  if (task?.write === true) {
    const allowed = task.allowedScope ?? [];
    const forbidden = task.forbiddenScope ?? [];
    for (const filePath of changed) {
      if (!matchesAnyScope(filePath, allowed)) {
        throw new Error(`Changed file is outside the allowed scope: ${filePath}`);
      }
      if (matchesAnyScope(filePath, forbidden)) {
        throw new Error(`Changed file is inside the forbidden scope: ${filePath}`);
      }
    }
  }
  receipt.filesChanged = changed;
}

export function validateReceipt(input, { task } = {}) {
  assertPlainObject(input, 'worker receipt');
  rejectUnknownFields(input, TOP_LEVEL_FIELDS, 'worker receipt');
  if (!STATUSES.has(input.status)) throw new Error(`Invalid receipt status: ${input.status}`);
  requireNonEmptyString(input.summary, 'receipt.summary');
  requireStringArray(input.filesInspected, 'receipt.filesInspected');
  requireStringArray(input.filesChanged, 'receipt.filesChanged');
  requireStringArray(input.unresolvedRisks, 'receipt.unresolvedRisks');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError('Receipt confidence must be between 0 and 1');
  }

  const receipt = structuredClone(input);
  receipt.commands = validateCommands(receipt.commands);
  receipt.criteria = validateCriteria(receipt.criteria);
  validateChangedFiles(receipt, task);
  validateCompletionEvidence(receipt, task);
  return receipt;
}
