/**
 * Input validation and sanitization for bridge commands.
 */

import * as path from 'node:path';

const MAX_INPUT_LENGTH = 32_000;
const MAX_PATH_LENGTH = 1024;
const SESSION_ID_PATTERN = /^[0-9a-f-]{32,64}$/i;
const VALID_MODES = ['plan', 'code', 'ask'] as const;

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\x00/, reason: 'null byte' },
  { pattern: /\.\.[/\\]/, reason: 'path traversal (../)' },
  { pattern: /\$\(/, reason: 'command substitution $()' },
  { pattern: /`[^`]*`/, reason: 'backtick command substitution' },
  { pattern: /;\s*(rm|cat|curl|wget|chmod|chown|mv|cp|dd|mkfs|shutdown|reboot)\b/, reason: 'chained dangerous command' },
  { pattern: /\|\s*(bash|sh|zsh|exec)\b/, reason: 'pipe to shell' },
  { pattern: />\s*\//, reason: 'redirect to absolute path' },
];

export function validateWorkingDirectory(rawPath: string): string | null {
  if (!rawPath || !rawPath.trim()) return null;
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed)) return null;
  if (trimmed.includes('\0')) return null;
  const segments = trimmed.split(/[/\\]/);
  if (segments.some(s => s === '..')) return null;
  if (trimmed.length > MAX_PATH_LENGTH) return null;
  if (/[$`;|&><(){}\x00-\x1f]/.test(trimmed)) return null;
  return path.normalize(trimmed);
}

export function validateSessionId(id: string): boolean {
  if (!id || !id.trim()) return false;
  return SESSION_ID_PATTERN.test(id.trim());
}

export function isDangerousInput(input: string): { dangerous: boolean; reason?: string } {
  if (!input) return { dangerous: false };
  if (input.length > MAX_INPUT_LENGTH * 2) {
    return { dangerous: true, reason: `excessively long input (${input.length} chars)` };
  }
  if (input.includes('\0')) {
    return { dangerous: true, reason: 'null byte detected' };
  }
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false };
}

export function sanitizeInput(
  text: string,
  maxLength: number = MAX_INPUT_LENGTH,
): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const truncated = sanitized.length > maxLength;
  if (truncated) {
    sanitized = sanitized.slice(0, maxLength);
  }
  return { text: sanitized, truncated };
}

export function validateMode(mode: string): mode is 'plan' | 'code' | 'ask' {
  return VALID_MODES.includes(mode as typeof VALID_MODES[number]);
}
