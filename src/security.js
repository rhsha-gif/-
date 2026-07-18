import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';

const SENSITIVE_KEY = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|credential|client[_-]?secret|session[_-]?token|cookie)/i;
const TOKEN_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g
];

export function sha256Text(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

export function redactSecrets(value) {
  if (typeof value !== 'string' || value.length === 0) return value ?? '';
  let output = value;
  output = output.replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  output = output.replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"']+/gi, '$1[REDACTED]');
  output = output.replace(/\b(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@');
  output = output.replace(/((?:--(?:api[-_]?key|token|password|secret)|-(?:p))\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
  output = output.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g, '$1=[REDACTED]');
  output = output.replace(/("(?:api[_-]?key|token|password|secret|credential|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
  for (const pattern of TOKEN_PATTERNS.slice(1)) output = output.replace(pattern, '[REDACTED TOKEN]');
  return output;
}

export function redactValue(value, key = '') {
  if (typeof value === 'string') return SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSecrets(value);
  if (Buffer.isBuffer(value)) return Buffer.from(redactSecrets(value.toString('utf8')));
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, entry]) => [
      field,
      SENSITIVE_KEY.test(field) && typeof entry !== 'object' ? '[REDACTED]' : redactValue(entry, field)
    ]));
  }
  return value;
}

function sameIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

export async function readBoundedRegularFile(filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive integer');
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new Error('Receipt file must not be a symbolic link');
  if (!before.isFile()) throw new Error('Receipt path must be a regular file');
  if (before.nlink !== 1) throw new Error('Receipt file must have link count 1; hard links are rejected');
  if (before.size > maxBytes) throw new Error(`Receipt file exceeds size limit of ${maxBytes} bytes`);
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error('Receipt file owner does not match the orchestrator process');
  }

  const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) throw new Error('Receipt file changed before it could be read');
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) throw new Error('Receipt file was only partially read');
    const after = await stat(filePath);
    if (!sameIdentity(before, after)) throw new Error('Receipt file changed while it was being read');
    return buffer;
  } finally {
    await handle.close();
  }
}
