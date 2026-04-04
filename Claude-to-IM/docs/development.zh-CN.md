# 开发指南

[English](development.md) | 中文

本文档涵盖将 Claude-to-IM 集成到你自己应用中所需的全部内容：宿主接口规范、SSE 流格式、分步集成教程、适配器开发指南和故障排查。

## 目录

- [集成概览](#集成概览)
- [宿主接口](#宿主接口)
  - [BridgeStore](#bridgestore)
  - [LLMProvider](#llmprovider)
  - [PermissionGateway](#permissiongateway)
  - [LifecycleHooks](#lifecyclehooks)
- [SSE 流格式](#sse-流格式)
- [分步集成教程](#分步集成教程)
- [开发新适配器](#开发新适配器)
- [测试](#测试)
- [故障排查](#故障排查)

---

## 集成概览

Claude-to-IM 通过全局上下文实现依赖注入。你的应用需要：

1. 实现四个宿主接口（`BridgeStore`、`LLMProvider`、`PermissionGateway`、`LifecycleHooks`）
2. 在使用任何桥接模块之前调用 `initBridgeContext()`
3. 调用 `bridgeManager.start()` 开始在 IM 平台上轮询/监听
4. 通过 `BridgeStore.getSetting()` 配置平台凭据

```
你的应用
    |
    |-- initBridgeContext({ store, llm, permissions, lifecycle })
    |-- bridgeManager.start()
    |
    v
Claude-to-IM（自动处理 IM <-> LLM 消息流）
```

启动后，桥接自主运行：轮询适配器获取入站消息、通过对话引擎路由、将响应投递回 IM 平台。你的应用只需要提供持久化层和 LLM 流式调用层。

---

## 宿主接口

所有接口定义在 [`src/lib/bridge/host.ts`](../src/lib/bridge/host.ts)。

### BridgeStore

持久化层。这是最大的接口，包含约 30 个方法，按类别组织。

#### 设置（Settings）

```typescript
getSetting(key: string): string | null;
```

按 key 返回配置值。所有桥接配置（Bot Token、授权用户、功能开关）都通过此方法读取。未设置的 key 返回 `null`。

**必需的 key**（要让对应的适配器工作，这些必须返回非 null 值）：

| Key | 示例值 | 用途 |
|-----|--------|------|
| `remote_bridge_enabled` | `"true"` | 总开关 |
| `bridge_telegram_bot_token` | `"123456:ABC..."` | Telegram Bot Token |
| `bridge_telegram_allowed_users` | `"12345,67890"` | 授权的 Telegram 用户 ID |
| `bridge_telegram_enabled` | `"true"` | 启用 Telegram 适配器 |
| `bridge_discord_bot_token` | `"MTIz..."` | Discord Bot Token |
| `bridge_discord_allowed_users` | `"111,222"` | 授权的 Discord 用户 ID |
| `bridge_discord_enabled` | `"true"` | 启用 Discord 适配器 |
| `bridge_feishu_app_id` | `"cli_xxx"` | 飞书 App ID |
| `bridge_feishu_app_secret` | `"xxx"` | 飞书 App Secret |
| `bridge_feishu_enabled` | `"true"` | 启用飞书适配器 |
| `bridge_default_cwd` | `"/home/user/projects"` | 默认工作目录 |
| `bridge_model` | `"claude-sonnet-4-20250514"` | 默认模型 |
| `bridge_{adapter}_stream_enabled` | `"true"` | 启用流式预览 |

#### 通道绑定（Channel Bindings）

```typescript
getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
listChannelBindings(channelType?: ChannelType): ChannelBinding[];
```

通道绑定将 IM 聊天（由 `channelType` + `chatId` 标识）映射到一个会话。当用户从一个新聊天发送消息时，桥接通过 `upsertChannelBinding()` 创建新绑定。同一聊天的后续消息复用已有绑定。

`ChannelBinding` 结构：

```typescript
interface ChannelBinding {
  id: string;
  channelType: string;    // 'telegram', 'discord', 'feishu'
  chatId: string;         // 平台特定的聊天 ID
  codepilotSessionId: string;  // 此聊天绑定的会话 ID
  sdkSessionId: string;   // Claude Code SDK 会话 ID，用于恢复
  workingDirectory: string;
  model: string;
  mode: 'code' | 'plan' | 'ask';
  active: boolean;
  createdAt: string;      // ISO 时间戳
  updatedAt: string;      // ISO 时间戳
}
```

#### 会话（Sessions）

```typescript
getSession(id: string): BridgeSession | null;
createSession(name: string, model: string, systemPrompt?: string, cwd?: string, mode?: string): BridgeSession;
updateSessionProviderId(sessionId: string, providerId: string): void;
```

会话代表进行中的对话。每个通道绑定指向一个会话。`createSession()` 应该生成唯一 ID 并存储会话。

`BridgeSession` 结构：

```typescript
interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}
```

#### 消息（Messages）

```typescript
addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };
```

存储对话历史。`role` 通常是 `"user"` 或 `"assistant"`。`usage` 参数（可选）是 Token 用量数据的 JSON 字符串。

#### 会话锁（Session Locking）

```typescript
acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
releaseSessionLock(sessionId: string, lockId: string): void;
setSessionRuntimeStatus(sessionId: string, status: string): void;
```

桥接使用锁来串行化同一会话内的消息。`acquireSessionLock()` 必须是原子操作：仅当该会话没有其他锁（或已有锁已过期）时返回 `true`。单进程部署中，一个简单的 `Map<string, { lockId, expiry }>` 就够了。

**锁的生命周期：**
1. 桥接在处理消息前调用 `acquireSessionLock(sessionId, lockId, 'bridge', 300)`
2. 处理过程中，`renewSessionLock()` 每约 60 秒延长一次 TTL
3. 处理完成后，`releaseSessionLock()` 释放锁
4. 如果进程崩溃，TTL 确保锁自动过期

#### SDK 会话

```typescript
updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
updateSessionModel(sessionId: string, model: string): void;
syncSdkTasks(sessionId: string, todos: unknown): void;
```

这些方法跟踪 Claude Code SDK 特定的状态。`sdkSessionId` 用于会话恢复——如果 SDK 在流响应中提供了会话 ID，桥接会存储它，以便后续消息可以恢复同一个 SDK 会话。

#### 提供商（Provider）

```typescript
getProvider(id: string): BridgeApiProvider | undefined;
getDefaultProviderId(): string | null;
```

如果你的应用支持多个 API 提供商（如不同的 API Key 或端点），实现这些方法来选择提供商。桥接将提供商传递给 `LLMProvider.streamChat()`。如果只有一个提供商，`getProvider()` 返回 `undefined`，`getDefaultProviderId()` 返回 `null`。

#### 审计与去重（Audit & Dedup）

```typescript
insertAuditLog(entry: AuditLogInput): void;
checkDedup(key: string): boolean;
insertDedup(key: string): void;
cleanupExpiredDedup(): void;
insertOutboundRef(ref: OutboundRefInput): void;
```

- **审计日志**：每条入站和出站消息都会记录。实现 `insertAuditLog()` 来存储或发送这些条目。
- **去重**：防止重复消息投递。`checkDedup(key)` 如果 key 已经存在则返回 `true`。`insertDedup(key)` 记录新 key。`cleanupExpiredDedup()` 定期调用以清除旧条目（建议实现 TTL，如 24 小时）。
- **出站引用**：记录哪些平台消息是为哪个会话发送的，用于关联追踪。

#### 权限链接（Permission Links）

```typescript
insertPermissionLink(link: PermissionLinkInput): void;
getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
markPermissionLinkResolved(permissionRequestId: string): boolean;
```

当 Claude 请求使用某个工具的权限时，桥接会向 IM 发送一条带内联按钮的交互消息。"权限链接"将权限请求 ID 映射到 IM 消息。当用户点击按钮时，桥接查找链接以验证回调的合法性。

`markPermissionLinkResolved()` 必须是原子操作：仅当链接存在且尚未解析时返回 `true`，然后标记为已解析。这防止了快速连续点击按钮导致的重复解析。

#### 通道偏移量（Channel Offsets）

```typescript
getChannelOffset(key: string): string;
setChannelOffset(key: string, offset: string): void;
```

适配器使用偏移量跟踪轮询位置（如 Telegram 的 `update_id`）。桥接持久化这些值，以便重启后不会重复处理旧消息。`key` 的格式由适配器决定（如 `"telegram:bot123456"`）。

---

### LLMProvider

```typescript
interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

最关键的接口。它启动与 LLM 的流式对话，返回 `ReadableStream<string>` 格式的 SSE 事件流。

#### StreamChatParams

```typescript
interface StreamChatParams {
  prompt: string;                    // 用户消息文本
  sessionId: string;                 // 内部会话 ID
  sdkSessionId?: string;             // Claude Code SDK 会话 ID，用于恢复
  model?: string;                    // 使用的模型（如 'claude-sonnet-4-20250514'）
  systemPrompt?: string;             // 系统提示词覆盖
  workingDirectory?: string;         // 代码执行的工作目录
  abortController?: AbortController; // 用于取消
  permissionMode?: string;           // 权限模式设置
  provider?: BridgeApiProvider;      // API 提供商配置
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];          // 来自 IM 消息的文件附件
  onRuntimeStatusChange?: (status: string) => void;
}
```

#### 实现示例（Claude Code SDK）

```typescript
import { ClaudeCodeAgent } from '@anthropic-ai/claude-agent-sdk';

class MyLLMProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      async start(controller) {
        const agent = new ClaudeCodeAgent({
          model: params.model,
          workingDirectory: params.workingDirectory,
          // ... 其他 SDK 选项
        });

        for await (const event of agent.stream(params.prompt)) {
          // 将 SDK 事件转换为 SSE 格式
          const sseEvent = { type: event.type, data: JSON.stringify(event.data) };
          controller.enqueue(`data: ${JSON.stringify(sseEvent)}\n`);
        }
        controller.close();
      }
    });
  }
}
```

桥接期望的具体事件类型见 [SSE 流格式](#sse-流格式) 一节。

---

### PermissionGateway

```typescript
interface PermissionGateway {
  resolvePendingPermission(
    permissionRequestId: string,
    resolution: PermissionResolution
  ): boolean;
}
```

当用户在 IM 中点击"允许"或"拒绝"按钮时，桥接调用此方法将决策转发到 LLM 会话。

```typescript
interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;                  // 原因消息（用于拒绝）
  updatedPermissions?: unknown[];    // 权限更新（用于"本次会话允许"）
}
```

如果你使用 Claude Code SDK，这对应 SDK 的权限解析 API。桥接处理 IM 侧的所有 UX（内联按钮、回调验证、去重）；你的 Gateway 只需要将解析结果转发到正确的 SDK 会话。

---

### LifecycleHooks

```typescript
interface LifecycleHooks {
  onBridgeStart?(): void;
  onBridgeStop?(): void;
}
```

可选回调。适用于更新 UI 状态（如显示"桥接已激活"指示器）或抑制其他竞争的轮询机制。

---

## SSE 流格式

`LLMProvider.streamChat()` 必须返回 `ReadableStream<string>`，其中每个 chunk 是一行 SSE：

```
data: {"type":"<event_type>","data":"<payload>"}\n
```

桥接解析这些事件并据此行动：

### 事件类型

| 类型 | 负载（`data` 字段） | 桥接行为 |
|------|---------------------|----------|
| `text` | 文本内容（字符串） | 累积到响应中。如果启用了流式预览，触发预览更新。 |
| `tool_use` | JSON：`{"id","name","input"}` | 记录日志。不直接渲染到 IM。 |
| `tool_result` | JSON：`{"tool_use_id","content","is_error"}` | 记录日志。不直接渲染到 IM。 |
| `permission_request` | JSON：`{"id","tool_name","tool_input","suggestions"}` | **立即**转发到 IM，显示带"允许/拒绝"按钮的交互消息。流会阻塞直到权限被解析。 |
| `status` | 包含 SDK 会话信息的 JSON 字符串 | 捕获 `sdkSessionId` 用于会话恢复。 |
| `result` | JSON：`{"usage":{"input_tokens","output_tokens",...},"sdkSessionId",...}` | 最终事件。提取 Token 用量和 SDK 会话 ID。 |
| `error` | 错误消息字符串 | 在对话结果上设置 `hasError` 标志。 |
| `keep_alive` | （忽略） | 防止空闲超时。桥接忽略此事件。 |
| `done` | （忽略） | 流结束信号。 |

### 示例流

```
data: {"type":"text","data":"让我帮你看看。"}\n
data: {"type":"text","data":"我先检查一下文件结构。"}\n
data: {"type":"tool_use","data":"{\"id\":\"tool_1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls -la\"}}"}\n
data: {"type":"permission_request","data":"{\"id\":\"perm_1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"},\"suggestions\":[{\"type\":\"allow\",\"toolName\":\"Bash\"}]}"}\n
...（流阻塞，等待权限被解析）...
data: {"type":"tool_result","data":"{\"tool_use_id\":\"tool_1\",\"content\":\"total 42\\ndrwxr-xr-x...\"}"}\n
data: {"type":"text","data":"我在目录中找到了以下内容..."}\n
data: {"type":"result","data":"{\"usage\":{\"input_tokens\":150,\"output_tokens\":80},\"sdkSessionId\":\"sdk_abc123\"}"}\n
```

### 最小实现（Echo）

用于测试或作为起点：

```typescript
class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}
```

---

## 分步集成教程

### 第 1 步：设置项目

```bash
# 克隆仓库
git clone https://github.com/op7418/Claude-to-IM.git
cd Claude-to-IM
npm install

# 验证一切正常
npm run test
```

### 第 2 步：实现 BridgeStore

从 [`examples/mock-host.ts`](../src/lib/bridge/examples/mock-host.ts) 中的内存实现开始，逐步替换为真实的持久化。以下是一个最小的 SQLite 示例结构：

```typescript
import Database from 'better-sqlite3';
import type { BridgeStore, BridgeSession } from './src/lib/bridge/host';
import type { ChannelBinding } from './src/lib/bridge/types';

class SQLiteStore implements BridgeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
        system_prompt TEXT, provider_id TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY, channel_type TEXT, chat_id TEXT,
        session_id TEXT, sdk_session_id TEXT DEFAULT '',
        working_directory TEXT, model TEXT, mode TEXT DEFAULT 'code',
        active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
        UNIQUE(channel_type, chat_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT, role TEXT, content TEXT, usage TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT, chat_id TEXT, direction TEXT,
        message_id TEXT, summary TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS dedup (
        key TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS permission_links (
        permission_request_id TEXT PRIMARY KEY,
        channel_type TEXT, chat_id TEXT, message_id TEXT,
        tool_name TEXT, suggestions TEXT, resolved INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS channel_offsets (
        key TEXT PRIMARY KEY, offset_value TEXT
      );
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id TEXT PRIMARY KEY, lock_id TEXT,
        owner TEXT, expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outbound_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT, chat_id TEXT, session_id TEXT,
        platform_message_id TEXT, purpose TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  getSetting(key: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  // ... 实现剩余方法
  // 完整方法列表见 mock-host.ts
}
```

**关键实现注意事项：**
- `acquireSessionLock()` 必须是原子操作——使用事务或 `INSERT OR IGNORE` + 检查
- `markPermissionLinkResolved()` 必须是原子操作——使用 `UPDATE ... WHERE resolved = 0` 并检查 `changes`
- `cleanupExpiredDedup()` 应该删除超过约 24 小时的条目

### 第 3 步：实现 LLMProvider

如果你使用 Claude Code SDK：

```typescript
import { claude } from '@anthropic-ai/claude-code-sdk';
import type { LLMProvider, StreamChatParams } from './src/lib/bridge/host';

class ClaudeCodeLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      async start(controller) {
        try {
          const conversation = claude.startConversation({
            model: params.model,
            cwd: params.workingDirectory,
            systemPrompt: params.systemPrompt,
            // 如果有则恢复现有会话
            ...(params.sdkSessionId ? { sessionId: params.sdkSessionId } : {}),
          });

          for await (const event of conversation.sendMessage(params.prompt, {
            abortSignal: params.abortController?.signal,
          })) {
            // 将 SDK 事件映射为桥接 SSE 格式
            const sseData = JSON.stringify({ type: event.type, data: JSON.stringify(event) });
            controller.enqueue(`data: ${sseData}\n`);
          }
        } catch (err: any) {
          const errorEvent = JSON.stringify({ type: 'error', data: err.message });
          controller.enqueue(`data: ${errorEvent}\n`);
        } finally {
          controller.close();
        }
      }
    });
  }
}
```

具体的映射取决于你使用的 Claude Code SDK 版本。关键要求是 `permission_request` 事件必须在流期间发出（而不是之后），因为流会阻塞直到权限通过 `PermissionGateway` 被解析。

### 第 4 步：实现 PermissionGateway

```typescript
import type { PermissionGateway, PermissionResolution } from './src/lib/bridge/host';

class MyPermissionGateway implements PermissionGateway {
  // 待处理权限请求 ID 到 resolve 回调的映射
  private pending = new Map<string, (resolution: PermissionResolution) => void>();

  // 用户在 IM 中点击"允许/拒绝"时由桥接调用
  resolvePendingPermission(id: string, resolution: PermissionResolution): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    resolve(resolution);
    this.pending.delete(id);
    return true;
  }

  // 当 LLM provider 收到权限请求时由你调用
  registerPending(id: string, resolve: (resolution: PermissionResolution) => void) {
    this.pending.set(id, resolve);
  }
}
```

### 第 5 步：初始化并启动

```typescript
import { initBridgeContext } from './src/lib/bridge/context';
import * as bridgeManager from './src/lib/bridge/bridge-manager';

// 初始化
const store = new SQLiteStore('./bridge.db');
const llm = new ClaudeCodeLLM();
const permissions = new MyPermissionGateway();

initBridgeContext({
  store,
  llm,
  permissions,
  lifecycle: {
    onBridgeStart: () => console.log('桥接已启动'),
    onBridgeStop: () => console.log('桥接已停止'),
  },
});

// 配置设置（在你的数据库或设置 UI 中）
// store.setSetting('remote_bridge_enabled', 'true');
// store.setSetting('bridge_telegram_enabled', 'true');
// store.setSetting('bridge_telegram_bot_token', 'YOUR_BOT_TOKEN');
// store.setSetting('bridge_telegram_allowed_users', 'YOUR_USER_ID');

// 启动桥接
await bridgeManager.start();
console.log('桥接状态:', bridgeManager.getStatus());
```

### 第 6 步：验证

1. 向你的 Telegram/Discord/飞书 Bot 发送一条消息
2. 检查桥接是否将其路由通过 `channel-router` -> `conversation-engine` -> `delivery-layer`
3. 验证响应是否出现在 IM 中
4. 测试权限流程：触发一个需要审批的工具调用，检查内联按钮是否出现

---

## 开发新适配器

要添加对新 IM 平台（如 Slack、WhatsApp、LINE）的支持：

### 第 1 步：创建适配器文件

```typescript
// src/lib/bridge/adapters/my-platform-adapter.ts

import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getBridgeContext } from '../context';
import type { InboundMessage, OutboundMessage, SendResult } from '../types';

class MyPlatformAdapter extends BaseChannelAdapter {
  readonly channelType = 'my-platform';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiter: ((msg: InboundMessage | null) => void) | null = null;

  async start() {
    if (this.running) return;
    const { store } = getBridgeContext();
    const token = store.getSetting('bridge_my_platform_bot_token');
    if (!token) throw new Error('缺少 bot token');

    this.running = true;
    // 启动平台连接（WebSocket、长轮询、Webhook 等）
    this.startListening(token);
  }

  async stop() {
    this.running = false;
    // 清理连接
    if (this.waiter) {
      this.waiter(null);
      this.waiter = null;
    }
  }

  isRunning() { return this.running; }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise(resolve => { this.waiter = resolve; });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    // 调用平台 API 发送消息
    try {
      const result = await this.platformApi.sendMessage(message.address.chatId, message.text);
      return { ok: true, messageId: result.id };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    if (!store.getSetting('bridge_my_platform_bot_token')) {
      return '缺少 bridge_my_platform_bot_token';
    }
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const { store } = getBridgeContext();
    const allowed = store.getSetting('bridge_my_platform_allowed_users');
    if (!allowed) return false;
    return allowed.split(',').map(s => s.trim()).includes(userId);
  }

  private startListening(token: string) {
    // 平台特定：将传入事件转换为 InboundMessage 并入队
  }

  private enqueue(msg: InboundMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }
}

// 自注册——模块被导入时执行
registerAdapterFactory('my-platform', () => new MyPlatformAdapter());
```

### 第 2 步：注册适配器

在 `src/lib/bridge/adapters/index.ts` 中添加导入：

```typescript
import './telegram-adapter';
import './discord-adapter';
import './feishu-adapter';
import './my-platform-adapter';  // 添加这行
```

### 第 3 步：添加平台限制

在 `src/lib/bridge/types.ts` 中添加你平台的消息长度限制：

```typescript
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  'my-platform': 4000,  // 添加这个
};
```

### 第 4 步：添加 Markdown 渲染（可选）

如果你的平台有特定的格式要求，在 `src/lib/bridge/markdown/` 中创建渲染器。否则，桥接会回退到纯文本投递。

对于平台特定的渲染，在 `bridge-manager.ts` 的 `deliverResponse()` 方法中添加相应的分支。

### 第 5 步：测试

按照现有适配器测试的模式创建 `src/__tests__/unit/bridge-my-platform-adapter.test.ts`。

---

## 测试

### 运行测试

```bash
npm run test:unit    # 运行所有桥接单元测试
npm run typecheck    # TypeScript 类型检查
npm run test         # 以上两项
```

### 编写测试

测试使用 Node.js 内置测试运行器（`node:test`）。每个测试文件：

1. 创建宿主接口的 mock 实现
2. 通过 `initBridgeContext()` 初始化桥接上下文
3. 在 `beforeEach` 中清理 `globalThis['__bridge_context__']`

示例模式：

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore } from '../../lib/bridge/host';

function createMockStore() {
  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    // ... 用测试默认值实现所有 BridgeStore 方法
  };
}

describe('my-module', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    const store = createMockStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  it('做某件事', () => {
    // 你的测试逻辑
  });
});
```

完整的 mock store 实现见 `src/__tests__/unit/` 中的现有测试文件。

---

## 故障排查

### "Context not initialized" 错误

```
Error: [bridge] Context not initialized. Call initBridgeContext() before using bridge modules.
```

你必须在导入或使用任何调用 `getBridgeContext()` 的桥接模块之前调用 `initBridgeContext()`。确保初始化发生在应用启动的早期阶段。

### 适配器无法启动

检查：
1. `remote_bridge_enabled` 从 `getSetting()` 返回 `"true"`
2. `bridge_{adapter}_enabled` 返回 `"true"`
3. Bot Token 配置已设置且有效
4. `validateConfig()` 返回 `null`（无错误）

### 权限按钮不起作用

1. 验证 `insertPermissionLink()` 是否正确存储了链接
2. 验证 `getPermissionLink()` 是否按 `permissionRequestId` 返回存储的链接
3. 验证 `markPermissionLinkResolved()` 是否是原子操作——每个链接只返回一次 `true`
4. 检查回调消息的 `callbackData` 格式是否正确：`perm:allow:{id}` 或 `perm:deny:{id}`

### 消息重复

1. 检查 `checkDedup()` 和 `insertDedup()` 是否正常工作
2. 验证 `cleanupExpiredDedup()` 是否没有过于激进地删除条目（至少保留 24 小时）
3. 对于 Telegram：验证通道偏移量是否已持久化——`getChannelOffset()` / `setChannelOffset()` 必须在重启后仍然有效

### 流式预览不显示

1. 验证 `bridge_{adapter}_stream_enabled` 返回 `"true"`
2. 检查你的 `LLMProvider` 是否增量发出 `text` 事件（而不是在最后一次性全部发出）
3. Telegram：预览默认只在私聊中有效
4. Discord：检查 Bot 是否有编辑自己消息的权限

### 测试后进程挂起

`delivery-layer.ts` 模块有一个 `setInterval` 用于速率限制器清理，它会保持 Node.js 进程活跃。使用 `--test-timeout` 标志：

```bash
node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-*.test.ts
```

### TypeScript 错误

确保你的 `tsconfig.json` 包含 `"lib": ["ESNext"]`——代码使用了 `Array.prototype.toSorted()`，需要 ES2023+。
