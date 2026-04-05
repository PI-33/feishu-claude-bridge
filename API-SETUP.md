# API 配置指南

本项目通过环境变量将 API 配置透传给 Claude Code CLI 子进程。**项目本身不做任何 API 路由**——只要 Claude CLI 支持的配置方式，这里都能用。

## 配置方式

编辑 `~/.claude-to-im/config.env`，根据你的 API 来源选择对应方案。

---

### 方案一：Anthropic 官方 API

直接使用 Anthropic 官方 API Key，最简单。

```bash
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxx
```

不需要设置 `ANTHROPIC_BASE_URL`，Claude CLI 默认连接 `https://api.anthropic.com`。

如果你在中国大陆等需要代理的网络环境：

```bash
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxx
http_proxy=http://127.0.0.1:7897
https_proxy=http://127.0.0.1:7897
```

---

### 方案二：OpenRouter

通过 [OpenRouter](https://openrouter.ai/) 调用 Claude 模型。

```bash
# ── OpenRouter API ──
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-v1-xxxxxxxxxxxxxxxx

# ── 模型覆盖（OpenRouter 的模型名带 provider 前缀）──
ANTHROPIC_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_SMALL_FAST_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4
ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-haiku-4

# ── 推荐设置 ──
API_TIMEOUT_MS=3000000
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

**为什么需要覆盖所有模型变量？** Claude CLI 内部会根据任务类型选择不同模型（fast 用于补全、sonnet 用于一般任务、opus 用于复杂任务）。OpenRouter 的模型名格式是 `provider/model`，和 Anthropic 原生模型名不同，所以需要全部覆盖。

**代理**：OpenRouter 本身不需要科学上网，但如果你的网络环境有限制，加上 proxy 变量即可。

---

### 方案三：其他兼容代理

自建转发、CC Switch、或任何 Claude API 兼容的代理服务。

```bash
ANTHROPIC_BASE_URL=https://your-proxy.example.com/v1
ANTHROPIC_API_KEY=your-proxy-key
# 或者用 auth token（取决于你的代理服务）
# ANTHROPIC_AUTH_TOKEN=your-token
```

如果代理使用标准 Anthropic 模型名（`claude-sonnet-4-20250514` 等），不需要覆盖模型变量。如果代理有自己的模型名格式，像 OpenRouter 一样覆盖即可。

---

## 完整 config.env 示例（OpenRouter）

```bash
# ── 代理（按需配置，不需要则删除）──
http_proxy=http://127.0.0.1:7897
https_proxy=http://127.0.0.1:7897

# ── OpenRouter API ──
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-v1-xxxxxxxxxxxxxxxx
API_TIMEOUT_MS=3000000
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# ── 模型 ──
ANTHROPIC_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_SMALL_FAST_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4
ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4
ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-haiku-4

# ── 飞书 ──
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CTI_FEISHU_DOMAIN=feishu
CTI_FEISHU_REQUIRE_MENTION=true

# ── 工作目录和模式 ──
CTI_DEFAULT_WORKDIR=/path/to/your/project
CTI_DEFAULT_MODE=code

# ── 权限（可选）──
# CTI_AUTO_APPROVE=true
# CTI_FEISHU_ALLOWED_USERS=ou_xxxx,oc_xxxx
```

设置权限：

```bash
chmod 600 ~/.claude-to-im/config.env
```

---

## 环境变量传递原理

理解这个有助于排查问题。

```
~/.claude-to-im/config.env
        │
        │  daemon.sh start 时 source 到 shell 环境
        ▼
   shell 环境变量
        │
        │  build_env_dict() 写入 launchd plist
        ▼
   launchd 环境变量
        │
        │  Node.js 继承 → process.env
        ▼
   buildSubprocessEnv() 全量透传（只剔除 CLAUDECODE）
        │
        ▼
   Claude CLI 子进程
```

launchd plist 中会转发以下变量：
- **通配转发**：所有 `CTI_*` 前缀、所有 `ANTHROPIC_*` 前缀
- **硬编码转发**：`http_proxy` `https_proxy` `HTTP_PROXY` `HTTPS_PROXY` `no_proxy` `NO_PROXY` `ALL_PROXY` `API_TIMEOUT_MS` `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 以及各 `ANTHROPIC_*_MODEL` 变量

如果你需要转发其他自定义变量，编辑 `scripts/daemon.sh` 中 `build_env_dict()` 的 for 循环。

---

## 验证 API 配置

启动后检查日志：

```bash
bash scripts/daemon.sh logs 30
```

正常应该看到：
```
[INFO] [feishu-bridge] CLI preflight OK: /path/to/claude (2.x.x)
[INFO] [feishu] Started (botOpenId: ou_xxx)
```

如果看到以下错误：

| 日志 | 问题 | 解决 |
|------|------|------|
| `not logged in` | CLI 没有认证，也没有 API Key | 检查 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 是否在 config.env 中 |
| `unauthorized` / `invalid api key` | API Key 无效 | 检查 key 是否正确、是否过期、OpenRouter 余额是否充足 |
| `process exited with code 1` + stderr 为空 | 环境变量没传到子进程 | 检查 daemon.sh 的 `build_env_dict` 是否包含你需要的变量 |
| `ECONNREFUSED` / `ETIMEDOUT` | 网络不通 | 检查代理配置、`ANTHROPIC_BASE_URL` 是否可达 |

### 手动验证变量是否传到了 launchd

```bash
# 查看 launchd plist 内容
cat ~/Library/LaunchAgents/com.feishu-claude-bridge.daemon.plist

# 搜索特定变量
grep -A1 'ANTHROPIC_BASE_URL' ~/Library/LaunchAgents/com.feishu-claude-bridge.daemon.plist
```

### 前台模式验证（跳过 launchd）

前台模式直接继承终端环境，不经过 launchd，可以排除 plist 转发问题：

```bash
source ~/.claude-to-im/config.env
npm run dev
```
