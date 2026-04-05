# CLAUDE.md — Feishu Claude Bridge

This file helps AI assistants understand, set up, and maintain this project.

## What This Project Does

Feishu Claude Bridge is a daemon that connects Feishu/Lark messaging to Claude Code CLI sessions. It runs as a background service, receives messages via Feishu WebSocket, invokes Claude Code through the Agent SDK, and streams responses back as CardKit v2 cards.

## Quick Setup (for AI assistants helping users)

### 1. Install Dependencies

```bash
cd /path/to/feishu-claude-bridge
npm install
```

Required: Node.js >= 20, Claude Code CLI installed and logged in.

### 2. Build

```bash
npm run build
```

This runs esbuild to bundle `src/` → `dist/daemon.mjs`. The Claude Agent SDK is kept as an external dependency (not bundled).

### 3. Configure

```bash
mkdir -p ~/.claude-to-im
cp config.env.example ~/.claude-to-im/config.env
```

Then edit `~/.claude-to-im/config.env` with the user's Feishu app credentials:

```bash
# REQUIRED
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx        # Feishu app ID
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx   # Feishu app secret
CTI_DEFAULT_WORKDIR=/path/to/project     # Default working directory

# OPTIONAL
CTI_FEISHU_DOMAIN=feishu                 # "feishu" or "lark"
CTI_DEFAULT_MODE=code                    # code / plan / ask
CTI_FEISHU_REQUIRE_MENTION=true          # Require @bot in group chats
# CTI_FEISHU_ALLOWED_USERS=ou_xxx,oc_xxx # Access control (comma-separated)
# CTI_AUTO_APPROVE=true                  # Skip tool permission prompts
# ANTHROPIC_API_KEY=xxx                  # Third-party API provider
# ANTHROPIC_BASE_URL=https://xxx/v1      # Third-party API base URL
```

### 4. Feishu App Requirements

The user needs a Feishu enterprise self-built app with:
- **Bot capability** enabled
- **Events & Callbacks** → Use persistent connection (WebSocket)
- **Event subscription**: `im.message.receive_v1`
- **Scopes**: `im:message`, `im:message.receive_v1`, `im:message:readonly`, `im:resource`, `im:chat:readonly`, `im:message.reactions:write_only`, `cardkit:card`

### 5. Start

```bash
# Daemon mode (recommended — uses launchd on macOS, auto-restarts)
bash scripts/daemon.sh start

# Or foreground (for debugging)
npm run dev
```

### 6. Verify

```bash
bash scripts/daemon.sh status
bash scripts/daemon.sh logs
```

Look for `[ws] ws client ready` in logs to confirm WebSocket connected.

## Architecture

```
src/
├── main.ts              # Entry point, assembles AppContext, starts daemon
├── config.ts            # Loads ~/.claude-to-im/config.env
├── types.ts             # All TypeScript interfaces (AppContext, InboundMessage, etc.)
├── feishu.ts            # Feishu WebSocket client + REST API + CardKit v2 streaming
├── bridge.ts            # Message dispatcher, slash commands, session management
├── conversation.ts      # Conversation engine: session lock → Claude SDK → SSE stream
├── claude-provider.ts   # Wraps @anthropic-ai/claude-agent-sdk query()
├── permissions.ts       # Blocking permission prompts (stream pauses until user approves)
├── delivery.ts          # Outbound: chunking (30KB), rate limiting, retry, dedup
├── feishu-markdown.ts   # Feishu-specific markdown processing and card JSON builders
├── store.ts             # JSON file persistence (sessions, bindings, messages, locks)
├── session-scanner.ts   # Discovers local Claude Code CLI sessions from ~/.claude/projects/
├── validators.ts        # Input sanitization and validation
└── logger.ts            # File logging with rotation (10MB) and secret masking
```

### Key Design Patterns

- **AppContext** — All shared state is passed as an explicit `AppContext` object (no globals).
- **WSClient monkey-patch** — The Feishu SDK's WSClient only handles `type: "event"` messages. Card action callbacks arrive as `type: "card"` and must be patched to `type: "event"` to be processed. See `feishu.ts` `start()` method.
- **CardKit v2 streaming** — Card lifecycle: `cardkit.v1.card.create` → `cardkit.v1.cardElement.content` (throttled updates) → `cardkit.v1.card.settings` (close streaming) → `cardkit.v1.card.update` (final content).
- **3-layer send degradation** — Card → Post → Text fallback for different bot permission levels.
- **Blocking tool permission** — The `canUseTool` callback in claude-provider.ts creates a Promise that blocks the stream until the user approves/denies in Feishu.
- **Session lock** — 600s TTL + 60s renewal. Numeric shortcuts (1/2/3 for permissions) are processed OUTSIDE the session lock to prevent deadlock.

### Data Directory

All runtime data lives in `~/.claude-to-im/`:
- `config.env` — Configuration
- `data/sessions.json` — Session records
- `data/bindings.json` — Chat-to-session bindings
- `data/permissions.json` — Permission request links
- `data/messages/<session-id>.jsonl` — Message history
- `logs/bridge.log` — Daemon log
- `runtime/bridge.pid` — PID file
- `runtime/status.json` — Running status

## Development

```bash
# Type check
npm run typecheck

# Run in dev mode (foreground, auto-reload not included)
npm run dev

# Build for production
npm run build

# Run tests
npx tsx --test src/__tests__/unit.test.ts         # Unit tests (no network)
npx tsx --test src/__tests__/feishu-api.test.ts    # Feishu API tests (needs config)
npx tsx --test src/__tests__/integration.test.ts   # Full integration (needs config + network)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[feishu] Cannot start: missing appId or appSecret` | config.env not found or incomplete | Check `~/.claude-to-im/config.env` |
| `[feishu] Feishu client not initialized` | FeishuClient didn't start | Check app credentials and network |
| WebSocket doesn't connect | App not configured for persistent connection | Enable "使用长连接接收事件" in Feishu dev console |
| Bot doesn't respond in group | `CTI_FEISHU_REQUIRE_MENTION=true` | @mention the bot, or set to `false` |
| Permission denied / 403 | Missing scopes | Add required scopes and republish app |
| `claude` CLI not found | CLI not in PATH | Set `CTI_CLAUDE_CODE_EXECUTABLE` in config.env |
| Card rendering fails | Missing `cardkit:card` scope | Add scope and republish app |

## Important Notes for Modifications

- The `card.update` API requires `{ card: { type, data }, sequence }` structure (not flat `{ type, data, sequence }`).
- The `cardkit.v1.cardElement.content` calls are fire-and-forget (async, throttled at 200ms). Ensure `finalizeCard` awaits pending card creation promises before proceeding.
- The session scanner reads only the first 20 lines + last 500 bytes of JSONL files to avoid loading large files into memory.
- Test files use top-level `test()` with `before()`/`after()` hooks — do NOT use `async describe()` as `node:test` won't properly serialize tests inside async describe blocks.
