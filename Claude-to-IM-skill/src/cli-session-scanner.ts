/**
 * CLI Session Scanner — discovers local Claude Code CLI sessions.
 *
 * Scans ~/.claude/projects/*\/*.jsonl to extract session metadata
 * without loading entire files (reads first 20 lines + last 500 bytes).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliSessionInfo } from 'claude-to-im/src/lib/bridge/host.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ScanOptions {
  limit?: number;
  maxAgeDays?: number;
}

/**
 * Read the first N lines of a file without loading the entire file.
 */
function readFirstLines(filePath: string, count: number): string[] {
  const lines: string[] = [];
  const bufSize = 4096;
  const buf = Buffer.alloc(bufSize);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    let remainder = '';
    let bytesRead: number;
    let offset = 0;
    while (lines.length < count) {
      bytesRead = fs.readSync(fd, buf, 0, bufSize, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const chunk = remainder + buf.toString('utf-8', 0, bytesRead);
      const parts = chunk.split('\n');
      remainder = parts.pop() || '';
      for (const part of parts) {
        if (lines.length >= count) break;
        lines.push(part);
      }
    }
    // If we still haven't reached count and there's a remainder, add it
    if (lines.length < count && remainder) {
      lines.push(remainder);
    }
  } catch {
    // File read error — return what we have
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return lines;
}

/**
 * Read the last N bytes of a file.
 */
function readLastBytes(filePath: string, count: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - count);
    const readLen = stat.size - start;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Format a relative time string from a timestamp.
 */
export function formatRelativeTime(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

/**
 * Scan ~/.claude/projects/ for local CLI sessions.
 *
 * For each .jsonl file:
 * - Reads first 20 lines to extract sessionId, cwd, gitBranch, slug, first user message
 * - Reads last 500 bytes to check if session is still open (no "last-prompt" line)
 * - Skips files older than maxAgeDays
 *
 * Returns results sorted by mtime descending, limited to `limit` entries.
 */
export function scanCliSessions(opts?: ScanOptions): CliSessionInfo[] {
  const limit = opts?.limit ?? 20;
  const maxAgeDays = opts?.maxAgeDays ?? 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const results: CliSessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(dirPath);
    } catch { continue; }
    if (!dirStat.isDirectory()) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const fileName of files) {
      const filePath = path.join(dirPath, fileName);
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(filePath);
      } catch { continue; }

      const mtime = fileStat.mtimeMs;
      if (mtime < cutoff) continue;

      try {
        const info = parseSessionFile(filePath, fileName, mtime);
        if (info) results.push(info);
      } catch {
        // Corrupted file — skip
      }
    }
  }

  // Sort by mtime descending
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}

/**
 * Parse a single .jsonl session file to extract metadata.
 */
function parseSessionFile(
  filePath: string,
  fileName: string,
  mtime: number,
): CliSessionInfo | null {
  const sdkSessionId = fileName.replace(/\.jsonl$/, '');

  // Read first 20 lines to find metadata
  const headLines = readFirstLines(filePath, 20);

  let sessionId = sdkSessionId;
  let cwd = '';
  let gitBranch: string | undefined;
  let slug = '';
  let firstPrompt = '';
  let foundUser = false;

  for (const line of headLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // Extract slug from any line that has it
      if (!slug && typeof obj.slug === 'string') {
        slug = obj.slug;
      }

      // Extract metadata from user messages
      if (obj.type === 'user') {
        // Always capture cwd/sessionId/gitBranch from the first user line
        if (!foundUser) {
          foundUser = true;
          if (typeof obj.sessionId === 'string') sessionId = obj.sessionId;
          if (typeof obj.cwd === 'string') cwd = obj.cwd;
          if (typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch;
        }

        // Extract first user text content (skip tool_result-only messages)
        if (!firstPrompt) {
          const msg = obj.message as { content?: unknown } | undefined;
          if (msg?.content) {
            if (typeof msg.content === 'string') {
              firstPrompt = msg.content;
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (typeof block === 'object' && block !== null && 'type' in block) {
                  const b = block as { type: string; text?: string };
                  if (b.type === 'text' && typeof b.text === 'string') {
                    firstPrompt = b.text;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // Once we have slug and a user text prompt, stop early
      if (firstPrompt && slug) break;
    } catch {
      // Invalid JSON line — skip
    }
  }

  // Skip files where we couldn't find any user message
  if (!foundUser) return null;

  // Read last 500 bytes to check if session is still open
  const tail = readLastBytes(filePath, 500);
  const tailLines = tail.split('\n').filter(l => l.trim());
  let isOpen = true;
  if (tailLines.length > 0) {
    const lastLine = tailLines[tailLines.length - 1];
    try {
      const obj = JSON.parse(lastLine) as Record<string, unknown>;
      if (obj.type === 'last-prompt') {
        isOpen = false;
      }
    } catch {
      // Can't parse last line — assume still open
    }
  }

  // Derive project name from cwd (last path segment)
  const project = cwd ? path.basename(cwd) : '';

  return {
    sdkSessionId,
    project,
    cwd,
    firstPrompt: firstPrompt.slice(0, 200), // Limit stored length
    slug,
    timestamp: mtime,
    isOpen,
    gitBranch: gitBranch !== 'HEAD' ? gitBranch : undefined,
  };
}
