# Feishu Claude Bridge

在飞书中与 Claude Code 对话 —— 手机端远程控制你的 AI 编程代理，还可以发现并恢复本地 CLI 会话。

[English](#english) | [中文](#中文)

---

## 中文

### 它能做什么

- 在飞书私聊/群聊中与 Claude Code 对话
- 用 `/list` 发现本地 Claude Code CLI 会话
- 用 `/resume` 恢复任意 CLI 会话，继续之前的对话
- 回到电脑后用 `claude --resume <id>` 看到飞书上的完整对话
- 流式输出（飞书卡片实时更新）
- 工具权限审批（1/2/3 快捷回复）

### 快速开始

#### 1. 前置条件

- macOS / Linux
- Node.js >= 20
- Claude Code CLI 已安装（`claude --version` 能用）

#### 2. 克隆和安装

```bash
git clone https://github.com/你的用户名/feishu-claude-bridge.git
cd feishu-claude-bridge

# 安装依赖（顺序重要）
cd Claude-to-IM && npm install && cd ..
cd Claude-to-IM-skill && npm install && cd ..
```

#### 3. 创建飞书应用

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)，创建**自建应用**
2. 记录 **App ID** 和 **App Secret**
3. 「权限管理」添加权限：

| 权限 | 用途 |
|---|---|
| `im:message` | 发送消息 |
| `im:message:readonly` | 读取消息 |
| `im:message.group_at_msg:readonly` | 读取群消息 |
| `im:resource` | 下载文件 |
| `cardkit:card:write` | 流式卡片 |
| `cardkit:card:read` | 读取卡片 |
| `im:message:update` | 更新消息 |
| `im:message.reactions:read` | 表情回复 |
| `im:message.reactions:write` | 发送表情 |
| `contact:user.id:readonly` | 用户鉴权 |

4. 启用**机器人**能力
5. **发布**应用并等待管理员审批

#### 4. 配置

```bash
mkdir -p ~/.claude-to-im
cat > ~/.claude-to-im/config.env << 'EOF'
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/path/to/your/project
CTI_DEFAULT_MODE=code

CTI_FEISHU_APP_ID=你的App_ID
CTI_FEISHU_APP_SECRET=你的App_Secret
CTI_FEISHU_DOMAIN=https://open.feishu.cn

# 可选：群聊无需@机器人
# CTI_FEISHU_REQUIRE_MENTION=false

# 可选：自动审批工具权限
# CTI_AUTO_APPROVE=true
EOF
```

<details>
<summary>可选：通过 OpenRouter 使用 API</summary>

```bash
# 追加到 config.env
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=你的OpenRouter_Key
CTI_DEFAULT_MODEL=anthropic/claude-opus-4.6
ANTHROPIC_MODEL=anthropic/claude-opus-4.6
API_TIMEOUT_MS=3000000
```
</details>

#### 5. 启动

```bash
cd Claude-to-IM-skill
bash scripts/daemon.sh start
```

#### 6. 配置飞书事件（启动后）

> daemon 必须先运行，飞书才能验证 WebSocket 连接。

1. 回到飞书开发者后台 →「事件与回调」
2. 订阅方式：**长连接**
3. 添加事件：`im.message.receive_v1`
4. 添加回调：`card.action.trigger`
5. **再次发布**一个新版本

#### 7. 使用

在飞书找到你的机器人，开始聊天！

### 可用命令

| 命令 | 说明 |
|---|---|
| `/list` | 发现本地 CLI 会话 |
| `/resume <编号>` | 恢复 CLI 会话 |
| `/new [path]` | 新建会话 |
| `/cwd /path` | 切换工作目录 |
| `/mode plan\|code\|ask` | 切换模式 |
| `/status` | 当前状态 |
| `/stop` | 停止运行中的任务 |
| `1` / `2` / `3` | 快捷权限回复 |
| `/help` | 查看所有命令 |

### 恢复 CLI 会话

这是本项目的核心功能：

```
飞书发送: /list           → 看到本地所有 CLI 会话
飞书发送: /resume 3       → 恢复第3个会话
飞书发消息                 → 在该会话上下文中对话
回到电脑: claude --resume <uuid>  → 看到飞书上的对话
```

### 常用操作

```bash
# 查看状态
bash scripts/daemon.sh status

# 查看日志
bash scripts/daemon.sh logs

# 重启
bash scripts/daemon.sh stop && bash scripts/daemon.sh start
```

### 项目结构

```
feishu-claude-bridge/
  Claude-to-IM/            # 核心库：IM 桥接框架
  Claude-to-IM-skill/      # 宿主实现：daemon + 配置 + 存储
```

详细技术文档见 [references/feishu-bridge-setup.md](Claude-to-IM-skill/references/feishu-bridge-setup.md)

---

## English

### What It Does

- Chat with Claude Code from Feishu (private or group chats)
- Discover local Claude Code CLI sessions with `/list`
- Resume any CLI session with `/resume` and continue the conversation
- Back on your computer, run `claude --resume <id>` to see the full Feishu conversation
- Streaming output (Feishu cards update in real-time)
- Tool permission approval (quick reply with 1/2/3)

### Quick Start

#### 1. Prerequisites

- macOS / Linux
- Node.js >= 20
- Claude Code CLI installed (`claude --version` works)

#### 2. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/feishu-claude-bridge.git
cd feishu-claude-bridge

cd Claude-to-IM && npm install && cd ..
cd Claude-to-IM-skill && npm install && cd ..
```

#### 3. Create Feishu App

1. Go to [Feishu Developer Console](https://open.feishu.cn/app), create a **Custom App**
2. Note the **App ID** and **App Secret**
3. Add permissions: `im:message`, `im:message:readonly`, `im:message.group_at_msg:readonly`, `im:resource`, `cardkit:card:write`, `cardkit:card:read`, `im:message:update`, `im:message.reactions:read`, `im:message.reactions:write`, `contact:user.id:readonly`
4. Enable **Bot** capability
5. **Publish** and wait for admin approval

#### 4. Configure

```bash
mkdir -p ~/.claude-to-im
cat > ~/.claude-to-im/config.env << 'EOF'
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/path/to/your/project
CTI_DEFAULT_MODE=code

CTI_FEISHU_APP_ID=your_app_id
CTI_FEISHU_APP_SECRET=your_app_secret
CTI_FEISHU_DOMAIN=https://open.feishu.cn
EOF
```

#### 5. Start

```bash
cd Claude-to-IM-skill
bash scripts/daemon.sh start
```

#### 6. Configure Feishu Events (after starting)

1. Feishu Developer Console → Events & Callbacks
2. Subscription mode: **Long Connection (WebSocket)**
3. Add event: `im.message.receive_v1`
4. Add callback: `card.action.trigger`
5. **Publish** a new version

#### 7. Use

Find your bot in Feishu and start chatting!

---

## Credits

Based on [Claude-to-IM](https://github.com/op7418/Claude-to-IM) and [Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) by [op7418](https://github.com/op7418), with added CLI session discovery and resume features.

## License

MIT
