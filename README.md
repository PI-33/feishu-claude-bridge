# Feishu Claude Bridge

将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 会话桥接到飞书 / Lark，在手机或桌面飞书上与 Claude Code 实时对话。

**核心特性：**

- **流式输出** — 使用 CardKit v2 流式卡片，逐字显示 Claude 回复
- **完整 Claude Code 功能** — 读写文件、执行命令、搜索代码，所有工具调用在飞书内实时展示
- **权限审批** — 危险操作（写文件、执行命令等）在飞书上弹出卡片按钮，点击批准或拒绝
- **会话管理** — 创建新会话、恢复本地 CLI 会话、切换工作目录和模式
- **群聊支持** — 每个群独立会话，@机器人 触发对话

## 工作原理

```
飞书 ──WebSocket──▶ FeishuClient ──▶ Bridge (命令路由)
                                         │
                                         ▼
                                    Conversation
                                         │
                                         ▼
                              Claude Agent SDK query()
                                         │
                                    SSE 流式响应
                                         │
                                         ▼
                              CardKit v2 实时更新卡片
```

桥接作为后台守护进程运行，通过飞书 WebSocket 长连接接收消息，调用 Claude Code CLI（通过 Agent SDK）处理，并将结果以流式卡片的形式返回飞书。

## 前置要求

- **Node.js** >= 20
- **Claude Code CLI** 已安装并登录（`claude --version` 可正常运行）
- **飞书开发者应用**（需要以下权限和配置）

### 飞书应用配置

1. 前往 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用
2. 开启 **机器人** 能力
3. 添加以下权限（Scopes）：
   - `im:message` — 发送消息
   - `im:message.receive_v1` — 接收消息
   - `im:message:readonly` — 读取消息
   - `im:resource` — 上传/下载资源
   - `im:chat:readonly` — 读取群列表
   - `im:message.reactions:write_only` — 添加表情回复（typing 指示器）
   - `cardkit:card` — CardKit v2 卡片操作
4. 在 **事件与回调** 中选择 **使用长连接接收事件**
5. 订阅事件 `im.message.receive_v1`
6. 发布应用版本

## 安装

```bash
git clone https://github.com/PI-33/feishu-claude-bridge.git
cd feishu-claude-bridge
npm install
npm run build
```

## 配置

```bash
# 复制配置模板并编辑
cp config.env.example config.env
```

编辑 `config.env`：

```bash
# 必填 —— 飞书应用凭证
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx

# 必填 —— Claude Code 默认工作目录
CTI_DEFAULT_WORKDIR=/path/to/your/project

# 可选 —— 域名（feishu 或 lark）
CTI_FEISHU_DOMAIN=feishu

# 可选 —— 默认模式（code / plan / ask）
CTI_DEFAULT_MODE=code

# 可选 —— 群聊中是否需要 @机器人 才响应
CTI_FEISHU_REQUIRE_MENTION=true

# 可选 —— 限制允许使用的用户/群 ID（逗号分隔，留空=允许所有）
# CTI_FEISHU_ALLOWED_USERS=ou_xxxx,oc_xxxx

# 可选 —— 自动批准所有工具权限（仅在可信环境启用）
# CTI_AUTO_APPROVE=true

# 可选 —— 第三方 API 提供商
# ANTHROPIC_API_KEY=your-key
# ANTHROPIC_BASE_URL=https://your-provider.com/v1
```

## 启动

### 方式一：守护进程（macOS，推荐）

> `daemon.sh` 使用 macOS `launchd` 管理进程。Linux / Windows 用户请使用方式二，或自行配置 pm2、systemd 等进程管理器。

```bash
# 启动（macOS 使用 launchd 管理，自动重启）
bash scripts/daemon.sh start

# 查看状态
bash scripts/daemon.sh status

# 查看日志
bash scripts/daemon.sh logs

# 停止
bash scripts/daemon.sh stop
```

### 方式二：前台运行（跨平台）

```bash
# 开发模式（直接运行 TypeScript）
npm run dev

# 或使用构建后的产物运行
npm start
```

启动后，在飞书中找到机器人发送任意消息即可开始对话。

## 飞书内命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/new [工作目录]` | 创建新会话（可选指定工作目录） |
| `/list` | 列出本地 Claude Code CLI 会话 |
| `/resume <编号>` | 恢复 `/list` 中的某个会话 |
| `/bind <会话ID>` | 绑定到指定的 SDK 会话 |
| `/cwd <路径>` | 切换当前会话的工作目录 |
| `/mode <code\|plan\|ask>` | 切换 Claude 模式 |
| `/status` | 显示当前会话状态 |
| `/stop` | 停止当前运行中的对话 |
| `/perm` | 查看待处理的权限请求 |

### 权限审批

当 Claude Code 请求使用工具（如写文件、执行命令）时，飞书会弹出权限卡片：

- **点击按钮** — 「允许一次」「允许本次会话」「拒绝」
- **快捷回复** — 直接发送 `1`（允许一次）、`2`（允许本次会话）、`3`（拒绝）

## 数据存储

配置文件 `config.env` 位于项目根目录。所有运行时数据保存在项目目录下的 `.bridge/`：

```
.bridge/
├── data/
│   ├── sessions.json   # 会话记录
│   ├── bindings.json   # 频道绑定
│   ├── permissions.json # 权限链接
│   └── messages/       # 消息历史（按会话ID分文件）
├── logs/
│   └── bridge.log      # 日志（自动轮转，最大 10MB）
└── runtime/
    ├── bridge.pid      # 进程 PID
    └── status.json     # 运行状态
```

## 与本地 CLI 互通

桥接创建的会话可以在终端 CLI 中恢复：

```bash
# 在飞书中使用 /status 获取 SDK Session ID
# 然后在终端恢复
claude --resume <sdk-session-id>
```

反过来，本地 CLI 会话也可以在飞书中恢复：

```bash
# 在飞书中发送 /list 查看本地会话
# 发送 /resume 1 恢复第一个会话
```

## 项目结构

```
src/
├── main.ts              # 入口：组装 AppContext、启动守护进程
├── config.ts            # 配置加载（读取 config.env）
├── types.ts             # 类型定义
├── feishu.ts            # 飞书客户端：WebSocket + REST + CardKit v2
├── bridge.ts            # 消息编排：命令路由 + 会话管理
├── conversation.ts      # 对话引擎：SSE 流式处理
├── claude-provider.ts   # Claude Agent SDK 封装
├── permissions.ts       # 权限管理（阻塞式等待飞书审批）
├── delivery.ts          # 消息发送：分块 + 限速 + 重试
├── feishu-markdown.ts   # 飞书 Markdown / 卡片构建
├── store.ts             # JSON 文件持久化
├── session-scanner.ts   # 本地 CLI 会话发现
├── validators.ts        # 输入校验
└── logger.ts            # 日志（轮转 + 脱敏）
scripts/
├── daemon.sh            # 守护进程管理（macOS launchd）
└── build.js             # esbuild 打包
```

## License

MIT
