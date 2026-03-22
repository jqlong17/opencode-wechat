# opencode-wechat

`opencode-wechat` 用于把微信 ClawBot 消息转发给 OpenCode，并把 OpenCode 回复再发回微信。

## 截图

<p align="center">
  <img src="docs/images/01-wechat-chat.jpg" alt="微信对话效果" width="32%" />
  <img src="docs/images/02-terminal-output.png" alt="终端扫码与运行日志" width="32%" />
  <img src="docs/images/03-clawbot-plugin.jpg" alt="微信 ClawBot 插件页面" width="32%" />
</p>

## 快速开始（推荐方式）

先克隆仓库到本地，然后执行：

```bash
cd opencode-wechat
bun install
bun run build
npm link
```

之后就可以全局使用 `opencode-wechat` 命令：

```bash
opencode-wechat setup  # 微信扫码登录
opencode-wechat start  # 启动桥接
```

## 快速开始（直接运行源码）

如果不想构建，也可以直接运行 TypeScript 源码（需要 Bun）：

```bash
cd opencode-wechat
bun install
bun opencode-wechat.ts setup
bun opencode-wechat.ts start
```

或者直接使用 Node 运行构建后的版本（无需 Bun，只需 Node.js）：

```bash
cd opencode-wechat
npm install
npm run build
node cli.mjs setup
node cli.mjs start
```

## 依赖

- Node.js >= 18
- Bun >= 1.0（用于构建或直接运行源码）
- OpenCode CLI（命令为 `opencode`，且在 PATH 中可用）
- 微信 iOS + ClawBot 能力

## 使用

启动后保持进程运行，然后在微信 ClawBot 对话里发消息即可。

### 常用命令

- `opencode-wechat setup` 或 `node cli.mjs setup` - 微信扫码登录
- `opencode-wechat start` 或 `node cli.mjs start` - 启动桥接
- `opencode-wechat help` 或 `node cli.mjs help` - 显示帮助

## 日志查看

日志目录：`~/.opencode/channels/wechat/logs`

- 耗时日志：`~/.opencode/channels/wechat/logs/timing.log.jsonl`
- 对话日志：`~/.opencode/channels/wechat/logs/chat.log.jsonl`

### 快速查看

```bash
cat ~/.opencode/channels/wechat/logs/timing.log.jsonl
cat ~/.opencode/channels/wechat/logs/chat.log.jsonl
```

### 字段说明

- `ts_ms`：Unix 毫秒时间戳
- `time_bj`：北京时间

### 保留策略

- 两类日志都只保留最近 24 小时的数据。

## 常用环境变量

- `OPENCODE_BIN`：OpenCode 可执行文件路径（默认 `opencode`）
- `OPENCODE_MODEL`：传给 `opencode run --model`
- `OPENCODE_AGENT`：传给 `opencode run --agent`
- `OPENCODE_WORKDIR`：传给 `opencode run --dir`
- `WECHAT_BASE_URL`：微信 ilink API 地址
- `WECHAT_BOT_TYPE`：扫码登录 bot_type（默认 `3`）
- `WECHAT_QR_MODE`：二维码显示模式（`small` 或 `ansi`）
- `OPENCODE_WECHAT_RUNTIME`：运行时（`node` 或 `bun`，默认 `node`）

## 英文文档

英文版见：`README.en.md`
