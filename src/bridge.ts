/**
 * Bridge — message orchestrator for the Feishu-Claude bridge.
 *
 * Consumes inbound messages from FeishuClient, routes slash commands,
 * handles numeric permission shortcuts, and dispatches to the conversation engine.
 * Uses per-session locks for concurrency control.
 */

import type {
  AppContext,
  InboundMessage,
  ChannelBinding,
  CliSessionInfo,
  ToolCallInfo,
} from './types.js';
import * as conversation from './conversation.js';
import { deliver } from './delivery.js';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
} from './permissions.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './validators.js';
import { formatRelativeTime } from './session-scanner.js';
import { htmlToFeishuMarkdown } from './feishu-markdown.js';

// ── /list cache (per-chat, 5 min TTL) ───────────────────────

interface ListCacheEntry {
  sessions: CliSessionInfo[];
  cachedAt: number;
}

const LIST_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map<string, ListCacheEntry>();

function getCachedList(chatId: string): CliSessionInfo[] | null {
  const entry = listCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIST_CACHE_TTL) {
    listCache.delete(chatId);
    return null;
  }
  return entry.sessions;
}

// ── Session locks ────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<void>>();

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  sessionLocks.set(sessionId, current);
  current.finally(() => {
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

// ── Active tasks ─────────────────────────────────────────────

const activeTasks = new Map<string, AbortController>();

// ── Numeric permission shortcut check ────────────────────────

function isNumericPermissionShortcut(ctx: AppContext, rawText: string, chatId: string): boolean {
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const pending = ctx.store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0;
}

// ── Resolve binding ──────────────────────────────────────────

function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

function createNewBinding(ctx: AppContext, chatId: string, workDir?: string): ChannelBinding {
  const cwd = workDir || ctx.config.defaultWorkDir || process.env.HOME || '';
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(`Bridge: ${chatId}`, model, undefined, cwd);
  return ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: cwd,
    model,
  });
}

// ── SDK Session Update Logic ─────────────────────────────────

function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) return sdkSessionId;
  if (hasError) return '';
  return null;
}

// ── CLI Session Helpers ──────────────────────────────────────

function findCliSession(ctx: AppContext, query: string): CliSessionInfo | null {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const q = query.toLowerCase();
  const byId = sessions.find(s => s.sdkSessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const bySlug = sessions.find(s => s.slug.toLowerCase() === q);
  return bySlug || null;
}

function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(
    `Resume: ${target.slug || target.sdkSessionId.slice(0, 8)}`,
    model,
    undefined,
    target.cwd,
  );

  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: target.cwd,
    model,
  });

  ctx.store.updateChannelBinding(binding.id, { sdkSessionId: target.sdkSessionId });

  const icon = target.isOpen ? '🟢' : '⚪';
  const prompt = target.firstPrompt.length > 40 ? target.firstPrompt.slice(0, 40) + '...' : target.firstPrompt;
  return [
    `${icon} 已恢复 CLI 会话`,
    '',
    `Session: \`${target.sdkSessionId.slice(0, 8)}...\``,
    `Project: \`${target.project}\``,
    `CWD: \`${target.cwd}\``,
    target.slug ? `Slug: \`${target.slug}\`` : '',
    `"${prompt}"`,
    '',
    '现在可以直接发消息继续对话。',
  ].filter(Boolean).join('\n');
}

// ── Main loop ────────────────────────────────────────────────

export async function runBridgeLoop(ctx: AppContext): Promise<void> {
  while (ctx.feishu.isRunning()) {
    try {
      const msg = await ctx.feishu.consumeOne();
      if (!msg) continue;

      if (
        msg.callbackData ||
        msg.text.trim().startsWith('/') ||
        isNumericPermissionShortcut(ctx, msg.text.trim(), msg.chatId)
      ) {
        await handleMessage(ctx, msg);
      } else {
        const binding = resolveBinding(ctx, msg.chatId);
        processWithSessionLock(binding.codepilotSessionId, () =>
          handleMessage(ctx, msg),
        ).catch(err => {
          console.error(`[bridge] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
        });
      }
    } catch (err) {
      console.error('[bridge] Error in loop:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(ctx: AppContext, msg: InboundMessage): Promise<void> {
  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = handlePermissionCallback(ctx, msg.callbackData, msg.chatId, msg.callbackMessageId);
    if (handled) {
      await deliver(ctx, msg.chatId, 'Permission response recorded.');
    }
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!rawText && !hasAttachments) return;

  // Numeric shortcut for permission replies (1/2/3)
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (/^[123]$/.test(normalized)) {
    const pendingLinks = ctx.store.listPendingPermissionLinksByChat(msg.chatId);
    if (pendingLinks.length === 1) {
      const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
      const action = actionMap[normalized];
      const permId = pendingLinks[0].permissionRequestId;
      const callbackData = `perm:${action}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
      if (handled) {
        await deliver(ctx, msg.chatId, `${label}: recorded.`);
      } else {
        await deliver(ctx, msg.chatId, 'Permission not found or already resolved.');
      }
      return;
    }
    if (pendingLinks.length > 1) {
      await deliver(ctx, msg.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Use /perm allow|allow_session|deny <id>`,
      );
      return;
    }
    // No pending → fall through as normal message
  }

  // Slash commands
  if (rawText.startsWith('/')) {
    await handleCommand(ctx, msg, rawText);
    return;
  }

  // Sanitize
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge] Input truncated from ${rawText.length} to ${text.length} chars`);
  }

  if (!text && !hasAttachments) return;

  // Regular message → conversation engine
  const binding = resolveBinding(ctx, msg.chatId);

  ctx.feishu.onMessageStart(msg.chatId);

  const taskAbort = new AbortController();
  activeTasks.set(binding.codepilotSessionId, taskAbort);

  // Tool call tracker for streaming card
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onPartialText = (fullText: string) => {
    try { ctx.feishu.onStreamText(msg.chatId, fullText); } catch { /* non-critical */ }
  };

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      ctx.feishu.onToolEvent(msg.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  };

  try {
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await conversation.processMessage(
      ctx,
      binding,
      promptText,
      async (perm) => {
        await forwardPermissionRequest(
          ctx,
          msg.chatId,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      onToolEvent,
    );

    // Finalize streaming card
    let cardFinalized = false;
    try {
      const status = result.hasError ? 'error' : 'completed';
      cardFinalized = await ctx.feishu.onStreamEnd(msg.chatId, status, result.responseText, result.tokenUsage);
    } catch (err) {
      console.warn('[bridge] Card finalize failed:', err instanceof Error ? err.message : err);
    }

    // Send response text (skip if card was finalized)
    if (result.responseText) {
      if (!cardFinalized) {
        await deliver(ctx, msg.chatId, result.responseText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      }
    } else if (result.hasError) {
      const errorText = `**Error:** ${result.errorMessage}`;
      await deliver(ctx, msg.chatId, errorText, {
        sessionId: binding.codepilotSessionId,
        parseMode: 'Markdown',
        replyToMessageId: msg.messageId,
      });
    }

    // Persist SDK session ID
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          ctx.store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    if (taskAbort.signal.aborted) {
      try {
        await ctx.feishu.onStreamEnd(msg.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }
    activeTasks.delete(binding.codepilotSessionId);
    ctx.feishu.onMessageEnd(msg.chatId);
  }
}

// ── Slash commands ───────────────────────────────────────────

async function handleCommand(
  ctx: AppContext,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Dangerous input check
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    console.warn(`[bridge] Blocked dangerous input: ${dangerCheck.reason}`);
    await deliver(ctx, msg.chatId, 'Command rejected: invalid input detected.');
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
    case '/help':
      response = [
        '**Feishu-Claude Bridge**',
        '',
        'Send any message to interact with Claude.',
        '',
        '**Commands:**',
        '/new [path] - Start new session',
        '/bind <session_id> - Bind to existing session',
        '/list - Discover local CLI sessions',
        '/resume <编号或ID> - Resume a CLI session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny <id> - Permission response',
        '1/2/3 - Quick permission reply (single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = createNewBinding(ctx, msg.chatId, workDir);
      response = [
        'New session created.',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind <session_id>';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format.';
        break;
      }
      const session = ctx.store.getSession(args);
      if (session) {
        ctx.store.upsertChannelBinding({
          chatId: msg.chatId,
          codepilotSessionId: args,
          workingDirectory: session.working_directory,
          model: session.model,
        });
        response = `Bound to session \`${args.slice(0, 8)}...\``;
      } else {
        const cliSession = findCliSession(ctx, args);
        if (cliSession) {
          response = resumeCliSession(ctx, msg.chatId, cliSession);
        } else {
          response = 'Session not found.';
        }
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path.';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to \`${validatedPath}\``;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { mode: args as 'code' | 'plan' | 'ask' });
      response = `Mode set to **${args}**`;
      break;
    }

    case '/status': {
      const binding = resolveBinding(ctx, msg.chatId);
      response = [
        '**Bridge Status**',
        '',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Mode: **${binding.mode}**`,
        `Model: \`${binding.model || 'default'}\``,
      ].join('\n');
      break;
    }

    case '/stop': {
      const binding = resolveBinding(ctx, msg.chatId);
      const taskAbort = activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny <permission_id>';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      response = handled
        ? `Permission ${permAction}: recorded.`
        : 'Permission not found or already resolved.';
      break;
    }

    case '/list': {
      const sessions = ctx.store.listCliSessions({ limit: 20 });
      if (sessions.length === 0) {
        response = 'No local CLI sessions found.';
        break;
      }
      listCache.set(msg.chatId, { sessions, cachedAt: Date.now() });

      const lines = ['**本地 CLI 会话:**', ''];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const icon = s.isOpen ? '🟢' : '⚪';
        const prompt = s.firstPrompt.length > 40 ? s.firstPrompt.slice(0, 40) + '...' : s.firstPrompt;
        const timeAgo = formatRelativeTime(s.timestamp);
        lines.push(`${i + 1}. ${icon} \`${s.sdkSessionId.slice(0, 8)}\`  ${s.project}`);
        lines.push(`   "${prompt}" (${timeAgo})`);
      }
      lines.push('');
      lines.push('发送 /resume <编号> 恢复会话');
      response = lines.join('\n');
      break;
    }

    case '/resume': {
      if (!args) {
        response = 'Usage: /resume <编号或ID>\n先发送 /list 查看可用会话。';
        break;
      }

      let target: CliSessionInfo | null = null;

      const num = parseInt(args, 10);
      if (!isNaN(num) && num > 0 && String(num) === args.trim()) {
        const cached = getCachedList(msg.chatId);
        if (cached && num <= cached.length) {
          target = cached[num - 1];
        } else {
          const freshSessions = ctx.store.listCliSessions({ limit: 20 });
          listCache.set(msg.chatId, { sessions: freshSessions, cachedAt: Date.now() });
          if (num <= freshSessions.length) {
            target = freshSessions[num - 1];
          }
        }
        if (!target) {
          response = `编号 ${num} 超出范围。发送 /list 查看可用会话。`;
          break;
        }
      }

      if (!target) {
        target = findCliSession(ctx, args);
      }

      if (!target) {
        response = `未找到匹配 "${args}" 的会话。\n发送 /list 查看可用会话。`;
        break;
      }

      // Abort running task
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      response = resumeCliSession(ctx, msg.chatId, target);
      break;
    }

    default:
      response = `Unknown command: ${command}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(ctx, msg.chatId, response, {
      parseMode: 'Markdown',
      replyToMessageId: msg.messageId,
    });
  }
}
