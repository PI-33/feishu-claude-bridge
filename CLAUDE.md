# CLAUDE.md — Feishu Claude Bridge

This file helps AI assistants understand, set up, and maintain this project.
Read this file first before making any changes.

## Project Overview

Feishu Claude Bridge is a **Node.js daemon** that connects Feishu/Lark messaging to Claude Code CLI sessions. Users chat with the bot in Feishu, the daemon invokes Claude Code via the Agent SDK, and streams responses back as CardKit v2 real-time cards.

**Tech stack:** TypeScript, Node.js >= 20, ESM modules, esbuild bundling.
**Dependencies:** `@anthropic-ai/claude-agent-sdk` (Claude SDK), `@larksuiteoapi/node-sdk` (Feishu SDK).
**Tests:** `node:test` runner with `tsx` loader. 55 unit + 5 API + 6 integration tests.
**Lines of code:** ~4,300 (14 source files), ~860 (3 test files).

## End-to-End Message Flow

```
 User sends message in Feishu
       │
       ▼
 Feishu WebSocket (WSClient) ──▶ FeishuClient.handleIncomingEvent()
       │                              │
       │  dedup, auth, @mention check │
       │                              ▼
       │                        enqueue(InboundMessage)
       │
       ▼
 runBridgeLoop() ◀── feishu.consumeOne()  [blocking queue consumer]
       │
       ▼
 handleMessage(ctx, msg)
       │
       ├── Is slash command? ──▶ handleCommand() ──▶ deliver() response
       │
       ├── Is numeric "1"/"2"/"3"? ──▶ handlePermissionCallback() [outside session lock!]
       │
       └── Is regular text? ──▶ processWithSessionLock()
                                     │
                                     ├── acquireSessionLock (600s TTL)
                                     │
                                     ├── resolveBinding() → find or create ChannelBinding + Session
                                     │
                                     ├── feishu.onMessageStart(chatId) → typing indicator + create streaming card
                                     │
                                     ▼
                              processMessage(ctx, binding, text, ...)  [conversation.ts]
                                     │
                                     ├── store.addMessage(sessionId, 'user', text)
                                     │
                                     ├── provider.streamChat({ prompt, sdkSessionId, ... })
                                     │         │
                                     │         ▼
                                     │   Claude Agent SDK query() ──▶ SSE stream
                                     │         │
                                     │         ├── canUseTool callback ──▶ PendingPermissions.waitFor()
                                     │         │                                    │
                                     │         │   [stream PAUSES here]              │
                                     │         │                                    ▼
                                     │         │                          forwardPermissionRequest()
                                     │         │                                    │
                                     │         │                          feishu.sendPermissionCard()
                                     │         │                                    │
                                     │         │                          user clicks button or sends "1"
                                     │         │                                    │
                                     │         │                          PendingPermissions.resolve()
                                     │         │                                    │
                                     │         ◀── stream RESUMES ──────────────────┘
                                     │         │
                                     │         ├── text events ──▶ onPartialText ──▶ feishu.onStreamText()
                                     │         │                                         │
                                     │         │                              updateCardContent() [throttled 200ms]
                                     │         │                                         │
                                     │         │                              cardkit.v1.cardElement.content()
                                     │         │
                                     │         ├── tool_use events ──▶ onToolEvent ──▶ feishu.onToolEvent()
                                     │         │
                                     │         └── result event ──▶ stream ends
                                     │
                                     ├── store.addMessage(sessionId, 'assistant', responseText)
                                     │
                                     ▼
                              return ConversationResult
                                     │
                                     ▼
                              feishu.onStreamEnd() → finalizeCard()
                                     │
                                     ├── cardkit.v1.card.settings({ streaming_mode: false })
                                     └── cardkit.v1.card.update({ card: { type, data } })
                                     │
                                     ▼
                              releaseSessionLock()
```

## File-by-File Guide

### `src/main.ts` (146 lines) — Entry Point

Assembles `AppContext`, starts `FeishuClient`, writes PID/status files, runs `runBridgeLoop()`, handles SIGTERM/SIGINT/SIGHUP graceful shutdown. No exports.

### `src/types.ts` (235 lines) — Type Definitions

All shared interfaces in one file. Key types:
- **`AppContext`** — `{ config, store, provider, permissions, feishu }` — passed explicitly everywhere (no globals).
- **`InboundMessage`** — What comes from Feishu: `messageId, chatId, userId, text, timestamp, callbackData?, attachments?`.
- **`ChannelBinding`** — Links a Feishu chat to a bridge session: `chatId, codepilotSessionId, sdkSessionId, workingDirectory, model, mode`.
- **`ConversationResult`** — Return from `processMessage()`: `responseText, tokenUsage, hasError, sdkSessionId`.
- **`StreamChatParams`** — Input to `ClaudeProvider.streamChat()`: `prompt, sessionId, sdkSessionId?, model?, workingDirectory?, files?`.

### `src/config.ts` (73 lines) — Configuration

Reads `~/.claude-to-im/config.env` via `dotenv`-style parsing. Exports `loadConfig(): Config` and `CTI_HOME` constant.

### `src/feishu.ts` (1040 lines) — Feishu Client [THE BIGGEST FILE]

`FeishuClient` class. Handles everything Feishu-related:

**WebSocket + Events:**
- `start()` — Creates `lark.Client` (REST) + `lark.WSClient` (WebSocket). **Applies monkey-patch** on `wsClient.handleEventData` to convert `type: "card"` → `type: "event"` (SDK bug workaround). Registers `im.message.receive_v1` and `card.action.trigger` dispatchers.
- `consumeOne()` — Blocking queue read. Bridge loop calls this in a `while(true)` loop.
- `handleIncomingEvent()` — Parses Feishu event, extracts text/images/files, deduplicates by message ID, checks authorization, handles @mention requirement, downloads file attachments, enqueues `InboundMessage`.

**CardKit v2 Streaming:**
- `createStreamingCard()` — Creates card via `cardkit.v1.card.create` with `streaming_mode: true`, then sends it as a message in the chat. Stores `CardState` (cardId, messageId, sequence, toolCalls, etc.).
- `updateCardContent()` / `flushCardUpdate()` — Throttled at 200ms. Calls `cardkit.v1.cardElement.content` to update the `streaming_content` element.
- `finalizeCard()` — Closes streaming: `cardkit.v1.card.settings` (set `streaming_mode: false`) → `cardkit.v1.card.update` (final card with footer stats). **Important:** `card.update` requires `{ card: { type, data }, sequence }` wrapper structure.

**Sending (3-layer degradation):**
- `send()` → tries `sendAsCard()` → falls back to `sendAsPost()` → falls back to plain text.
- `sendPermissionCard()` — Sends interactive card with Allow/Deny buttons, falls back to text with "reply 1/2/3" instructions.

**Other:**
- `onMessageStart()` — Typing indicator (emoji reaction) + streaming card creation.
- `isAuthorized()` — Checks `CTI_FEISHU_ALLOWED_USERS`.
- `handleCardAction()` — Card button click → enqueues as `InboundMessage` with `callbackData`.
- File/image download via `im.messageResource.get`.

### `src/bridge.ts` (593 lines) — Message Orchestrator

Single export: `runBridgeLoop(ctx)`. Internal structure:

**Main loop:** `while (feishu.isRunning()) { msg = consumeOne(); handleMessage(msg); }`

**`handleMessage()`** dispatches to:
- Slash commands: `/help`, `/new [dir]`, `/bind <id>`, `/cwd <path>`, `/mode <mode>`, `/status`, `/stop`, `/list`, `/resume <n>`, `/perm`, `/start`
- Numeric shortcuts `1`/`2`/`3` → `handlePermissionCallback()` (processed **outside** session lock to prevent deadlock)
- Regular text → `processWithSessionLock()`

**`processWithSessionLock()`:**
1. `resolveBinding()` — Find existing `ChannelBinding` or create new one with fresh session
2. `acquireSessionLock()` — 600s TTL, retries 3x with 5s delay
3. Wire streaming callbacks: `onPartialText → feishu.onStreamText`, `onToolEvent → feishu.onToolEvent`, `onPermissionRequest → forwardPermissionRequest`
4. Call `processMessage()` (conversation.ts)
5. Handle result: `feishu.onStreamEnd()` or `deliver()` if no card was created
6. `releaseSessionLock()`

**Session management:**
- `resolveBinding()` — Looks up `ChannelBinding` by chatId, creates new if missing
- `computeSdkSessionUpdate()` — If conversation returned a new sdkSessionId, persists it
- `findCliSession()` / `resumeCliSession()` — For `/resume` command

### `src/conversation.ts` (349 lines) — Conversation Engine

Single export: `processMessage(ctx, binding, text, callbacks, abortSignal, files)`.

Flow:
1. Save user message to store
2. Build `StreamChatParams` from binding (sessionId, sdkSessionId, model, workingDirectory)
3. Attach file data if present
4. Call `provider.streamChat(params)` → get `ReadableStream<string>`
5. Parse SSE lines from stream (format: `event: <type>\ndata: <json>\n\n`)
6. Handle events: `text` (accumulate responseText, call onPartialText), `tool_use`/`tool_result` (track tool calls, call onToolEvent), `permission_request` (call onPermissionRequest), `result` (extract final text + usage), `error`
7. Save assistant message to store
8. Return `ConversationResult`

### `src/claude-provider.ts` (514 lines) — Claude SDK Wrapper

`ClaudeProvider` class with one main method: `streamChat(params): ReadableStream<string>`.

**How `streamChat` works:**
1. Spawns `claude` CLI as subprocess via Agent SDK `query()` with `{ resume: sdkSessionId }` for session continuity
2. Configures `canUseTool` callback — creates a `PendingPermissions.waitFor()` Promise that **blocks the stream** until user approves
3. Translates SDK events (`Message`, `ToolUse`, `ToolResult`, `PermissionRequest`, etc.) into SSE-formatted text lines pushed to a `ReadableStream`
4. Handles stderr ring buffer (last 50 lines) for error diagnostics
5. Classifies auth errors (`cli` vs `api`) for better error messages

**Utilities:**
- `resolveClaudeCliPath()` — Searches PATH, common locations, `CTI_CLAUDE_CODE_EXECUTABLE`
- `preflightCheck(cliPath)` — Runs `claude --version` to verify CLI works
- `buildSubprocessEnv()` — Strips `CLAUDECODE` env var (prevents daemon recursion)

### `src/permissions.ts` (199 lines) — Permission Management

**`PendingPermissions`** class — In-memory Map of `toolUseID → { resolve, reject }` Promises.
- `waitFor(id)` — Returns Promise that blocks until `resolve(id)` is called
- `resolve(id, { behavior, message })` — Resolves the Promise, unblocking the stream
- `denyAll()` — Resolves all pending with `deny` (used on session stop)

**`forwardPermissionRequest()`** — Formats tool name + input as markdown, calls `feishu.sendPermissionCard()`, persists link in store.

**`handlePermissionCallback()`** — Called when user clicks card button or sends "1"/"2"/"3". Parses action, resolves the matching `PendingPermissions` entry.

### `src/delivery.ts` (176 lines) — Outbound Message Delivery

`deliver(ctx, chatId, text, opts)` — Sends message through `ctx.feishu.send()` with:
- **Chunking** — Splits at 30KB (Feishu limit), preferring newline boundaries
- **Rate limiting** — 20 messages/minute per chat, sliding window
- **Retry** — 3 attempts with exponential backoff + jitter, no retry on 400/403/404
- **Dedup** — Optional dedupKey checked/stored in store
- **Audit** — Logs outbound messages to audit log

### `src/feishu-markdown.ts` (189 lines) — Markdown & Card Builders

Pure functions, no side effects:
- `hasComplexMarkdown()` — Detects code blocks, tables (triggers card rendering instead of post)
- `preprocessFeishuMarkdown()` — Ensures newlines before code fences (Feishu rendering quirk)
- `buildCardContent()` / `buildPostContent()` — Build Feishu message JSON for card/post types
- `buildStreamingContent()` — Builds markdown for streaming card updates (text + tool progress)
- `buildFinalCardJson()` — Builds complete card with response text, tool list, footer stats
- `buildPermissionButtonCard()` — Interactive card with Allow Once / Allow Session / Deny buttons
- `htmlToFeishuMarkdown()` — Converts `<b>`, `<i>`, `<code>`, entities to Feishu markdown
- `formatElapsed()` / `formatTokenCount()` — Human-readable formatting

### `src/store.ts` (401 lines) — JSON File Persistence

`JsonFileStore` class. All data in `~/.claude-to-im/data/`. Uses atomic writes (write to .tmp, rename).

**Sessions:** `sessions.json` — `createSession()`, `getSession()`, `updateSdkSessionId()`, `updateSessionModel()`
**Bindings:** `bindings.json` — `upsertChannelBinding()`, `getChannelBinding()`, `updateChannelBinding()`, `listChannelBindings()`
**Messages:** `messages/<sessionId>.jsonl` — `addMessage()`, `getMessages()`
**Locks:** In-memory Map — `acquireSessionLock()`, `renewSessionLock()`, `releaseSessionLock()` (600s TTL)
**Dedup:** In-memory Map — `checkDedup()`, `insertDedup()`, `cleanupExpiredDedup()` (5min TTL)
**Permissions:** `permissions.json` — `insertPermissionLink()`, `getPermissionLink()`, `markPermissionLinkResolved()`
**Audit:** `audit.jsonl` — `insertAuditLog()` (fire-and-forget append)
**CLI Sessions:** Delegates to `scanCliSessions()` from session-scanner.ts

### `src/session-scanner.ts` (223 lines) — Local CLI Session Discovery

`scanCliSessions({ limit, maxAgeDays })` — Scans `~/.claude/projects/<dir>/<session>.jsonl` files.
- Reads first 20 lines (head) for session metadata (cwd, branch, first prompt)
- Reads last 500 bytes (tail) to check if session is open or closed
- Returns `CliSessionInfo[]` sorted by modification time, newest first

### `src/validators.ts` (71 lines) — Input Validation

- `validateWorkingDirectory()` — Rejects relative paths, traversal (`..`), empty
- `validateSessionId()` — Checks UUID-like format (32+ hex chars)
- `isDangerousInput()` — Flags null bytes, command substitution (`$(...)`, `` `...` ``)
- `sanitizeInput()` — Strips control chars, truncates to max length
- `validateMode()` — Validates `code | plan | ask`

### `src/logger.ts` (82 lines) — Logging

`setupLogger()` — Redirects `console.log/warn/error` to `~/.claude-to-im/logs/bridge.log` with:
- ISO timestamp prefix
- Log rotation at 10MB (renames to `.log.1`)
- `maskSecrets()` — Redacts tokens/secrets/passwords in log output

## Critical Implementation Details

### 1. WSClient Monkey-Patch (feishu.ts:151-171)
The Feishu SDK's `WSClient.handleEventData()` only processes `type: "event"` messages. Card action callbacks arrive as `type: "card"` and would be **silently dropped**. The patch intercepts `handleEventData`, checks for `type: "card"` in headers, and rewrites it to `type: "event"` before calling the original handler.

### 2. CardKit v2 card.update API Structure
The `card.update` endpoint requires nested structure:
```json
{ "card": { "type": "card_json", "data": "<json string>" }, "sequence": N }
```
NOT flat `{ "type": "card_json", "data": "...", "sequence": N }`. The flat version returns `field validation failed: card is required`.

### 3. Permission Deadlock Prevention (bridge.ts)
Numeric shortcuts ("1"/"2"/"3") for permission approval are processed **outside** the session lock. If they went through `processWithSessionLock()`, they'd wait for the lock which is held by the conversation that's waiting for the permission response — classic deadlock.

### 4. Streaming Card Sequence Numbers
Every card operation increments a `sequence` counter. The API requires strictly increasing sequences. Operations: create(1) → element updates(2,3,...) → settings(N) → update(N+1). The `flushCardUpdate()` is async fire-and-forget, so `finalizeCard()` awaits `cardCreatePromises` first.

### 5. Session Lock Mechanics (store.ts + bridge.ts)
- TTL: 600 seconds, renewed every 60 seconds during active conversation
- Same lockId can re-acquire (idempotent)
- Different lockId fails → returns false → bridge retries 3x with 5s delay
- On conversation end or error, lock is always released in `finally` block

### 6. File Attachment Handling (feishu.ts + conversation.ts)
Images/files in Feishu messages are downloaded via `im.messageResource.get`, saved to temp files, and passed to Claude as `files` in `StreamChatParams`. Max 20MB per file.

## Data Directory Layout

```
~/.claude-to-im/
├── config.env              # User configuration
├── data/
│   ├── sessions.json       # { "sessions": { "<id>": { id, working_directory, model, ... } } }
│   ├── bindings.json       # { "bindings": { "<id>": { chatId, codepilotSessionId, ... } } }
│   ├── permissions.json    # { "links": { "<permReqId>": { chatId, toolName, resolved, ... } } }
│   ├── audit.jsonl         # Append-only audit log
│   └── messages/
│       └── <sessionId>.jsonl  # One JSONL per session: { role, content, timestamp }
├── logs/
│   └── bridge.log          # Rotated at 10MB → bridge.log.1
└── runtime/
    ├── bridge.pid           # Daemon PID
    └── status.json          # { "running": true, "pid": N, "startedAt": "ISO", ... }
```

## Quick Setup (for AI assistants helping users)

```bash
cd /path/to/feishu-claude-bridge
npm install
npm run build
mkdir -p ~/.claude-to-im
cp config.env.example ~/.claude-to-im/config.env
# Edit ~/.claude-to-im/config.env with Feishu app credentials
bash scripts/daemon.sh start
bash scripts/daemon.sh logs   # Verify: look for "[ws] ws client ready"
```

Required Feishu app config: Bot capability, persistent connection (WebSocket), event `im.message.receive_v1`, scopes: `im:message`, `im:message.receive_v1`, `im:message:readonly`, `im:resource`, `im:chat:readonly`, `im:message.reactions:write_only`, `cardkit:card`.

## Development

```bash
npm run typecheck              # tsc --noEmit
npm run dev                    # Foreground mode
npm run build                  # esbuild → dist/daemon.mjs

npx tsx --test src/__tests__/unit.test.ts         # 55 unit tests (no network)
npx tsx --test src/__tests__/feishu-api.test.ts    # 5 API tests (needs config)
npx tsx --test src/__tests__/integration.test.ts   # 6 integration tests (needs config + network)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot start: missing appId or appSecret` | config.env missing | Check `~/.claude-to-im/config.env` |
| WebSocket doesn't connect | App not configured for persistent connection | Enable "使用长连接接收事件" in Feishu dev console |
| Bot doesn't respond in group | `CTI_FEISHU_REQUIRE_MENTION=true` | @mention the bot, or set to `false` |
| Permission denied / 403 | Missing scopes | Add required scopes and republish app |
| `claude` CLI not found | CLI not in PATH | Set `CTI_CLAUDE_CODE_EXECUTABLE` in config.env |
| Card rendering fails | Missing `cardkit:card` scope | Add scope and republish app |
| `field validation failed: card is required` | Wrong card.update structure | Must use `{ card: { type, data }, sequence }` |

## Important Notes for Modifications

- **Do NOT use `async describe()`** in tests — `node:test` won't serialize tests inside async describe blocks. Use top-level `test()` with `before()`/`after()` hooks.
- **Do NOT flatten `card.update` data** — The API requires `{ card: { type, data }, sequence }` wrapper.
- **Do NOT process permission replies inside session lock** — Deadlock risk.
- `flushCardUpdate()` is fire-and-forget — always await `cardCreatePromises` before `finalizeCard()`.
- The session scanner reads only head (20 lines) + tail (500 bytes) of JSONL files — never full content.
- `buildSubprocessEnv()` strips `CLAUDECODE` env var to prevent daemon recursion when spawning Claude CLI.
