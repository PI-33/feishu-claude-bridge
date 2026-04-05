/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, and auditing. Feishu-only (30KB limit, no HTML chunking).
 */

import type { AppContext } from './types.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;
const INTER_CHUNK_DELAY_MS = 300;
const FEISHU_MAX_LENGTH = 30000;

// ── Rate limiter (20 messages/minute per chat) ──

class ChatRateLimiter {
  private buckets = new Map<string, number[]>();
  private windowMs = 60_000;
  private maxPerWindow = 20;

  async acquire(chatId: string): Promise<void> {
    const now = Date.now();
    let timestamps = this.buckets.get(chatId);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(chatId, timestamps);
    }
    // Remove expired
    while (timestamps.length > 0 && timestamps[0] < now - this.windowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxPerWindow) {
      const waitMs = timestamps[0] + this.windowMs - now + 100;
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    timestamps.push(Date.now());
  }

  cleanup(): void {
    const now = Date.now();
    for (const [chatId, timestamps] of this.buckets) {
      while (timestamps.length > 0 && timestamps[0] < now - this.windowMs) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.buckets.delete(chatId);
      }
    }
  }
}

const rateLimiter = new ChatRateLimiter();
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a message through the Feishu client with chunking, dedup, retry, and auditing.
 */
export async function deliver(
  ctx: AppContext,
  chatId: string,
  text: string,
  opts?: {
    sessionId?: string;
    dedupKey?: string;
    parseMode?: 'Markdown' | 'HTML' | 'plain';
    replyToMessageId?: string;
  },
): Promise<SendResult> {
  // Dedup check
  if (opts?.dedupKey) {
    if (ctx.store.checkDedup(opts.dedupKey)) {
      return { ok: true, messageId: undefined };
    }
  }

  if (Math.random() < 0.01) {
    try { ctx.store.cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  const chunks = chunkText(text, FEISHU_MAX_LENGTH);
  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    await rateLimiter.acquire(chatId);
    if (i > 0) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    const result = await sendWithRetry(ctx, chatId, chunks[i], opts?.parseMode, opts?.replyToMessageId);
    if (!result.ok) {
      return result;
    }
    lastMessageId = result.messageId;
  }

  // Mark as delivered for dedup
  if (opts?.dedupKey) {
    try { ctx.store.insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  // Audit log
  try {
    ctx.store.insertAuditLog({
      chatId,
      direction: 'outbound',
      messageId: lastMessageId || '',
      summary: text.slice(0, 200),
    });
  } catch { /* best effort */ }

  return { ok: true, messageId: lastMessageId };
}

async function sendWithRetry(
  ctx: AppContext,
  chatId: string,
  text: string,
  parseMode?: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await ctx.feishu.send(chatId, text, parseMode, replyToMessageId);
    if (result.ok) return result;

    lastError = result.error;

    // Don't retry client errors
    if (result.error && /400|403|404/.test(result.error)) {
      return result;
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, backoffDelay(attempt)));
    }
  }

  return { ok: false, error: lastError || 'Max retries exceeded' };
}
