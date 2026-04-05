/**
 * Type definitions for the Feishu-Claude Bridge v2.
 *
 * Consolidated from Claude-to-IM host.ts + types.ts — stripped of
 * multi-platform abstractions (ChannelType, OutboundMessage, AdapterStatus, etc.).
 */

// ── AppContext ───────────────────────────────────────────────

import type { Config } from './config.js';

export interface AppContext {
  config: Config;
  store: import('./store.js').JsonFileStore;
  provider: import('./claude-provider.js').ClaudeProvider;
  permissions: import('./permissions.js').PendingPermissions;
  feishu: import('./feishu.js').FeishuClient;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from Feishu. */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message */
  callbackMessageId?: string;
  /** File attachments (images, documents) */
  attachments?: FileAttachment[];
}

/** File attachment from Feishu (images, documents). */
export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links a Feishu chat to a bridge session. */
export interface ChannelBinding {
  id: string;
  chatId: string;
  /** Bridge session ID */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── SSE Event Types ──────────────────────────────────────────

/** Server-Sent Event from the LLM stream. */
export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

// ── Session & Message ────────────────────────────────────────

/** Minimal session object. */
export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}

/** Minimal message object. */
export interface BridgeMessage {
  role: string;
  content: string;
}

/** Content block in an LLM response message. */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

/** Token usage statistics from an LLM response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

// ── CLI Session Discovery ────────────────────────────────────

/** Metadata for a local Claude Code CLI session discovered on disk. */
export interface CliSessionInfo {
  /** UUID matching the .jsonl file name — used as sdkSessionId for resume */
  sdkSessionId: string;
  /** Project name (last segment of cwd) */
  project: string;
  /** Working directory from the session */
  cwd: string;
  /** First user message (truncated for display) */
  firstPrompt: string;
  /** Human-readable slug */
  slug: string;
  /** File mtime in milliseconds */
  timestamp: number;
  /** True if the session has no "last-prompt" line (may still be running) */
  isOpen: boolean;
  /** Git branch, if available */
  gitBranch?: string;
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming card progress display. */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

// ── Permission ───────────────────────────────────────────────

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

// ── Permission Link ──────────────────────────────────────────

/** Input for inserting a permission link. */
export interface PermissionLinkInput {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
}

/** Stored permission link record. */
export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
}

// ── Audit ───────────────────────────────────────────────────

/** Audit log entry input. */
export interface AuditLogInput {
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

// ── Upsert Binding Input ─────────────────────────────────────

/** Input for upserting a channel binding. */
export interface UpsertChannelBindingInput {
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId?: string;
  workingDirectory: string;
  model: string;
  mode?: string;
}

// ── Conversation Result ──────────────────────────────────────

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  permissionRequests: PermissionRequestInfo[];
  sdkSessionId: string | null;
}

// ── Stream Chat Params ───────────────────────────────────────

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  files?: FileAttachment[];
}
