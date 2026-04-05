/**
 * Pending Permissions — Promise-based gateway for tool permission requests.
 *
 * waitFor() returns a promise that resolves when the IM user allows/denies.
 * 5-minute timeout auto-deny. denyAll() for graceful shutdown.
 *
 * Also contains permission forwarding and callback handling logic
 * (merged from permission-broker.ts + permission-gateway.ts).
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult, AppContext } from './types.js';
import {
  buildPermissionButtonCard,
} from './feishu-markdown.js';

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = 5 * 60 * 1000;

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  resolve(permissionRequestId: string, resolution: { behavior: 'allow' | 'deny'; message?: string }): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (resolution.behavior === 'allow') {
      entry.resolve({ behavior: 'allow' });
    } else {
      entry.resolve({ behavior: 'deny', message: resolution.message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

// ── Permission forwarding ────────────────────────────────────

/** Dedup recent permission forwards. Key: permissionRequestId, value: timestamp. */
const recentPermissionForwards = new Map<string, number>();

/**
 * Forward a permission request to Feishu as an interactive card.
 */
export async function forwardPermissionRequest(
  ctx: AppContext,
  chatId: string,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  // Dedup
  const nowTs = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permissions] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, nowTs);
  for (const [id, ts] of recentPermissionForwards) {
    if (nowTs - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permissions] Forwarding permission request: ${permissionRequestId} tool=${toolName}`);

  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  const mdText = [
    `**Permission Required**`,
    ``,
    `Tool: \`${toolName}\``,
    '```',
    truncatedInput,
    '```',
  ].join('\n');

  // Send permission card with action buttons
  const result = await ctx.feishu.sendPermissionCard(chatId, mdText, permissionRequestId, replyToMessageId);

  // Record the link
  if (result.ok && result.messageId) {
    try {
      ctx.store.insertPermissionLink({
        permissionRequestId,
        chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press or text shortcut.
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  ctx: AppContext,
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':');

  const link = ctx.store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permissions] No permission link found for ${permissionRequestId}`);
    return false;
  }

  if (link.chatId !== callbackChatId) {
    console.warn(`[permissions] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permissions] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  if (link.resolved) {
    console.warn(`[permissions] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  let claimed: boolean;
  try {
    claimed = ctx.store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }
  if (!claimed) return false;

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = ctx.permissions.resolve(permissionRequestId, { behavior: 'allow' });
      break;

    case 'allow_session': {
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through */ }
      }
      // For allow_session we still just resolve as 'allow' — the SDK handles
      // updatedPermissions through its own PermissionResult type
      resolved = ctx.permissions.resolve(permissionRequestId, { behavior: 'allow' });
      break;
    }

    case 'deny':
      resolved = ctx.permissions.resolve(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    default:
      return false;
  }

  return resolved;
}
