# Claude-to-IM

A host-agnostic bridge that connects IM platforms (Telegram, Discord, Feishu/Lark) to Claude, enabling AI-powered conversations through messaging apps.

## Features

- **Multi-platform**: Telegram (long polling), Discord (Gateway), Feishu/Lark (WSClient)
- **Streaming previews**: Real-time response drafts via message editing
- **Permission management**: Interactive inline buttons for tool approvals
- **Session binding**: Each IM chat maps to a persistent conversation session
- **Markdown rendering**: Platform-native formatting (HTML for Telegram, Discord Markdown, Feishu cards)
- **Security**: Input validation, rate limiting, authorization, audit logging
- **Reliable delivery**: Auto-chunking, retry with backoff, HTML fallback, dedup

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  IM Platform (Telegram / Discord / Feishu)                   │
└──────────────┬───────────────────────────────────────────────┘
               │ InboundMessage
┌──────────────▼───────────────────────────────────────────────┐
│  Adapter (platform-specific polling/websocket)               │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│  Bridge Manager (orchestrator)                               │
│  ├── Channel Router   → session binding                      │
│  ├── Conversation Engine → LLM streaming                     │
│  ├── Permission Broker → tool approval flow                  │
│  └── Delivery Layer   → chunking, retry, dedup               │
└──────────────┬───────────────────────────────────────────────┘
               │ Host Interfaces (DI)
┌──────────────▼───────────────────────────────────────────────┐
│  Host Application (implements BridgeStore, LLMProvider, etc.)│
└──────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Implement the host interfaces

```typescript
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from './host';

const store: BridgeStore = { /* your persistence layer */ };
const llm: LLMProvider = { /* your LLM streaming implementation */ };
const permissions: PermissionGateway = { /* your permission resolver */ };
const lifecycle: LifecycleHooks = { /* optional lifecycle callbacks */ };
```

### 2. Initialize the bridge context

```typescript
import { initBridgeContext } from './context';

initBridgeContext({ store, llm, permissions, lifecycle });
```

### 3. Start the bridge

```typescript
import * as bridgeManager from './bridge-manager';

await bridgeManager.start();
```

### 4. Check status

```typescript
const status = bridgeManager.getStatus();
// { running: true, adapters: [{ channelType: 'telegram', running: true, ... }] }
```

## Host Interfaces

The bridge requires four host interfaces (defined in `host.ts`):

| Interface | Purpose | Key Methods |
|-----------|---------|-------------|
| `BridgeStore` | Persistence (sessions, bindings, messages, settings) | `getSetting`, `getSession`, `addMessage`, `acquireSessionLock`, ... |
| `LLMProvider` | AI model streaming | `streamChat(params) → ReadableStream<string>` |
| `PermissionGateway` | Tool permission resolution | `resolvePendingPermission(id, resolution) → boolean` |
| `LifecycleHooks` | Bridge lifecycle notifications | `onBridgeStart?()`, `onBridgeStop?()` |

See `host.ts` for full interface definitions and `hosts/codepilot.ts` for a reference implementation.

## Adding a New Adapter

1. Create a file in `adapters/` extending `BaseChannelAdapter`
2. Call `registerAdapterFactory(channelType, factory)` for self-registration
3. Import the file in `adapters/index.ts`

The adapter must implement: `start()`, `stop()`, `isRunning()`, `consumeOne()`, `send()`, `validateConfig()`, `isAuthorized()`.

Optional: `getPreviewCapabilities()`, `sendPreview()`, `endPreview()`, `onMessageStart()`, `onMessageEnd()`, `acknowledgeUpdate()`.

## Configuration

All settings are read via `BridgeStore.getSetting(key)`. Key settings:

- `remote_bridge_enabled` — master switch
- `bridge_auto_start` — auto-start on app launch
- `bridge_{adapter}_enabled` — per-adapter toggle
- `bridge_{adapter}_bot_token` — bot credentials
- `bridge_{adapter}_allowed_users` — CSV of authorized user IDs
- `bridge_{adapter}_stream_enabled` — streaming preview toggle

## Security

- Input validation: path traversal, command injection, null byte detection
- Rate limiting: 20 messages/minute per chat (token bucket)
- Authorization: per-adapter allowed users/channels/guilds
- Audit logging: all inbound/outbound messages logged
- Permission dedup: atomic claim-and-resolve prevents double-clicks

See `security/validators.ts` and `security/rate-limiter.ts`.

## License

See the root LICENSE file.
