# Claude Code 接入飞书：完整部署指南

> 本文档记录了如何在 macOS 上将 Claude Code CLI 通过 claude-to-im 桥接到飞书，实现手机端与 Claude 对话、恢复本地 CLI 会话等功能。

---

## 一、前置条件

- **macOS**（Linux 也支持，脚本有 supervisor 适配）
- **Node.js >= 20**
- **Claude Code CLI** 已安装（`claude` 命令可用）
  - 验证：`claude --version`
  - 常见路径：`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`、`~/.npm-global/bin/claude`
- **飞书开发者账号**（能创建自建应用）

---

## 二、项目结构

两个仓库协同工作：

```
GitHub_Proj/
  Claude-to-IM/          # 核心库：IM 桥接框架（适配器、路由、安全、消息引擎）
  Claude-to-IM-skill/    # 宿主实现：daemon 入口、配置、存储、LLM provider
```

- `Claude-to-IM` 是 npm 包，提供类型和通用逻辑
- `Claude-to-IM-skill` 依赖它（`"claude-to-im": "file:../Claude-to-IM"`），提供完整的可运行 daemon

运行时数据都在 `~/.claude-to-im/` 下：

```
~/.claude-to-im/
  config.env              # 唯一的配置文件
  data/                   # 持久化存储（sessions, bindings, permissions...）
  data/messages/          # 每个会话的消息历史
  logs/bridge.log         # 日志
  runtime/                # PID、status.json
```

---

## 三、克隆和安装

```bash
# 1. 克隆两个项目到同一父目录
cd ~/your-projects-dir
git clone https://github.com/op7418/Claude-to-IM.git
git clone https://github.com/op7418/Claude-to-IM-skill.git

# 2. 安装依赖（顺序重要：先装核心库）
cd Claude-to-IM
npm install          # 会自动触发 npm run build (prepare hook)

cd ../Claude-to-IM-skill
npm install          # 会解析 file:../Claude-to-IM 本地依赖

# 3. 构建
cd ../Claude-to-IM
npm run build

cd ../Claude-to-IM-skill
npm run build        # 输出 dist/daemon.mjs
```

验证：`ls Claude-to-IM-skill/dist/daemon.mjs` 应该存在。

---

## 四、创建飞书应用

### 4.1 创建应用并获取凭据

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)
2. 创建**自建应用**
3. 记录 **App ID** 和 **App Secret**（在「凭证与基础信息」页面）

### 4.2 添加权限（批量）

在「权限管理」中搜索并添加以下 10 个权限：

| 权限 scope | 用途 |
|---|---|
| `im:message` | 发送消息 |
| `im:message:readonly` | 读取消息（私聊） |
| `im:message.group_at_msg:readonly` | 读取群@消息 |
| `im:resource` | 下载消息中的图片/文件 |
| `cardkit:card:write` | 创建流式卡片 |
| `cardkit:card:read` | 读取卡片 |
| `im:message:update` | 实时更新消息（流式输出） |
| `im:message.reactions:read` | 读取表情回复（typing 状态） |
| `im:message.reactions:write` | 发送表情回复（typing 状态） |
| `contact:user.id:readonly` | 读取用户 ID（鉴权用） |

### 4.3 启用机器人能力

在「添加应用能力」中，启用 **机器人（Bot）**。

### 4.4 第一次发布

点击**版本管理与发布** → **创建版本** → **发布**。等管理员审批通过。

### 4.5 配置事件订阅（需先启动一次 daemon）

> **重要**：飞书要求在配置 WebSocket 长连接时，你的服务已经在运行。所以先完成第五步的配置和 `daemon.sh start`，再回来做这一步。

1. 进入「事件与回调」
2. 订阅方式选择：**使用长连接接收事件/回调**
3. 添加事件：`im.message.receive_v1`（接收消息）
4. 添加回调：`card.action.trigger`（卡片按钮回调，用于权限审批按钮）
5. **再次发布**一个新版本（飞书要求每次改事件配置都要重新发布）

---

## 五、配置 daemon

创建/编辑 `~/.claude-to-im/config.env`：

```bash
mkdir -p ~/.claude-to-im
cat > ~/.claude-to-im/config.env << 'EOF'
# ── 基础运行时 ──
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/Users/你的用户名/你的项目目录
CTI_DEFAULT_MODE=code

# ── 飞书应用凭据 ──
CTI_FEISHU_APP_ID=你的App_ID
CTI_FEISHU_APP_SECRET=你的App_Secret
CTI_FEISHU_DOMAIN=https://open.feishu.cn

# ── 群聊不需要@（可选，默认需要@机器人） ──
# CTI_FEISHU_REQUIRE_MENTION=false

# ── 自动审批工具权限（可选，跳过飞书端的权限确认弹窗） ──
# CTI_AUTO_APPROVE=true
EOF
```

### 可选：通过 OpenRouter 使用 API

如果你的 Claude Code CLI 不是直接用 Anthropic API，而是通过 OpenRouter 等中转：

```bash
# 追加到 config.env
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=你的OpenRouter_Key
ANTHROPIC_MODEL=anthropic/claude-opus-4.6
CTI_DEFAULT_MODEL=anthropic/claude-opus-4.6
API_TIMEOUT_MS=3000000
```

### 可选：代理配置

```bash
http_proxy=http://127.0.0.1:7897
https_proxy=http://127.0.0.1:7897
```

---

## 六、启动/停止/诊断

```bash
cd /path/to/Claude-to-IM-skill

# 启动
bash scripts/daemon.sh start

# 查看状态
bash scripts/daemon.sh status

# 查看日志
bash scripts/daemon.sh logs

# 停止
bash scripts/daemon.sh stop

# 重启
bash scripts/daemon.sh stop && bash scripts/daemon.sh start
```

启动成功的输出示例：

```json
{
  "running": true,
  "pid": 12345,
  "channels": ["feishu"]
}
```

日志中应看到：

```
[bridge-manager] Started adapter: feishu
[bridge-manager] Bridge started with 1 adapter(s)
[ws] ws client ready
```

---

## 七、飞书端使用

### 7.1 私聊场景

1. 在飞书中搜索你创建的机器人名字
2. 直接发消息即可对话

### 7.2 群聊场景

1. 把机器人拉进飞书群
2. 默认需要 **@机器人** 才会响应
3. 如果设置了 `CTI_FEISHU_REQUIRE_MENTION=false`，群里任何消息都会触发

### 7.3 可用命令

| 命令 | 说明 |
|---|---|
| `/new [path]` | 新建会话（可指定工作目录） |
| `/bind <session_id>` | 绑定到已有桥接会话 |
| `/list` | **发现本地 CLI 会话**（扫描 `~/.claude/projects/`） |
| `/resume <编号或ID>` | **恢复一个本地 CLI 会话** |
| `/cwd /path` | 切换工作目录 |
| `/mode plan\|code\|ask` | 切换模式 |
| `/status` | 查看当前会话状态 |
| `/sessions` | 列出桥接内部会话 |
| `/stop` | 停止当前运行中的任务 |
| `/perm allow\|deny <id>` | 响应工具权限请求 |
| `1` / `2` / `3` | 快捷权限回复（1=允许 2=允许本会话 3=拒绝） |
| `/help` | 显示帮助 |

### 7.4 恢复本地 CLI 会话（核心功能）

这是自定义开发的功能，允许从飞书手机端"接管"本地终端中的 Claude Code 对话：

```
1. 飞书发送：/list
   → 显示本地所有 CLI 会话列表（🟢=运行中 ⚪=已关闭）

2. 飞书发送：/resume 3
   → 恢复第 3 个会话，之后发消息就在该会话上下文中

3. 回到电脑，终端运行：claude --resume <uuid>
   → 能看到飞书上的完整对话
```

支持三种匹配方式：
- `/resume 3` — 编号（来自 `/list` 列表）
- `/resume abc12345` — UUID 前缀匹配
- `/resume hashed-sparking-trinket` — slug 名称匹配

---

## 八、技术架构简述

### 消息流

```
飞书 → WebSocket → feishu-adapter.consumeOne()
     → bridge-manager.handleMessage()
     → channel-router.resolve() → 找到/创建 ChannelBinding
     → conversation-engine.processMessage()
     → llm-provider.streamChat({ sdkSessionId })
     → claude CLI: query({ resume: sdkSessionId })
     → SSE 流式返回 → 飞书卡片实时更新
```

### 会话恢复原理

Claude Code CLI 把每个对话存储在 `~/.claude/projects/<编码路径>/<uuid>.jsonl`。

`/resume` 命令做的事：
1. `cli-session-scanner.ts` 扫描这些 `.jsonl` 文件（只读前20行+末尾500字节，不加载整个文件）
2. 提取元数据：sessionId, cwd, slug, firstPrompt, isOpen
3. 创建一个新的桥接内部 session，把 `sdkSessionId` 设为 CLI 会话的 UUID
4. SDK 的 `query({ resume: uuid })` 自动恢复 CLI 会话上下文

### 关键文件

| 文件 | 位置 | 作用 |
|---|---|---|
| `cli-session-scanner.ts` | skill/src/ | 扫描本地 CLI 会话 |
| `store.ts` | skill/src/ | JSON 文件存储（实现 BridgeStore 接口） |
| `llm-provider.ts` | skill/src/ | 调用 Claude CLI SDK |
| `bridge-manager.ts` | im/src/lib/bridge/ | 核心编排：命令路由、消息处理、流式预览 |
| `host.ts` | im/src/lib/bridge/ | 接口定义（BridgeStore, LLMProvider 等） |
| `conversation-engine.ts` | im/src/lib/bridge/ | LLM 流消费、消息持久化 |
| `feishu-adapter.ts` | im/src/lib/bridge/adapters/ | 飞书适配器 |
| `daemon.sh` | skill/scripts/ | daemon 管理脚本 |
| `config.env` | ~/.claude-to-im/ | 唯一配置文件 |

### 依赖注入

`main.ts` 初始化时通过 `initBridgeContext()` 注入四个接口实现：
- **BridgeStore** → `JsonFileStore`（JSON 文件持久化）
- **LLMProvider** → `SDKLLMProvider`（调用 claude CLI）
- **PermissionGateway** → `PendingPermissions`（内存中的权限请求队列）
- **LifecycleHooks** → PID 文件 + status.json 管理

---

## 九、常见问题排查

### daemon 启动失败

```bash
# 查看详细日志
bash scripts/daemon.sh logs

# 运行诊断
bash scripts/doctor.sh

# 手动前台运行（看实时输出）
cd Claude-to-IM-skill && npm run dev
```

### 飞书收不到消息

1. 确认事件订阅配置了 `im.message.receive_v1`
2. 确认配置了长连接(WebSocket)模式
3. 确认应用已发布且审批通过
4. 日志中应有 `[ws] ws client ready`

### Claude 回复没有上下文

- 检查 `sdkSessionId` 是否正确写入 binding：
  ```bash
  cat ~/.claude-to-im/data/bindings.json | python3 -m json.tool
  ```
  找到你的 chatId 对应的 binding，`sdkSessionId` 字段不应为空

### 重新构建

源码改动后需要重新构建两个项目：

```bash
cd Claude-to-IM && npm run build
cd ../Claude-to-IM-skill && npm run build
bash scripts/daemon.sh stop && bash scripts/daemon.sh start
```

---

## 十、自定义改动记录

以下是相对于上游仓库增加的自定义功能：

### 新增文件

- **`Claude-to-IM-skill/src/cli-session-scanner.ts`** — CLI 会话扫描器

### 修改文件

- **`Claude-to-IM/src/lib/bridge/host.ts`** — 添加 `CliSessionInfo` 类型和 `listCliSessions?()` 可选方法
- **`Claude-to-IM-skill/src/store.ts`** — `JsonFileStore` 实现 `listCliSessions()`
- **`Claude-to-IM/src/lib/bridge/bridge-manager.ts`** — 添加 `/list`、`/resume` 命令，增强 `/bind` 的 CLI 回退，更新帮助文本
- **`Claude-to-IM-skill/src/config.ts`** — 添加 `feishuRequireMention` 配置项

### 注意事项

- `upsertChannelBinding()` 不会读取输入的 `sdkSessionId`（硬编码为空），所以 `/resume` 在 upsert 后额外调用 `updateChannelBinding()` 来写入 sdkSessionId
- CLI 会话扫描器只读每个 `.jsonl` 文件的前 20 行和末尾 500 字节，不会加载几 MB 的完整文件
- `/list` 结果按 chatId 缓存 5 分钟，供 `/resume <编号>` 引用
