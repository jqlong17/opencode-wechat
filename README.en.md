# opencode-wechat

`opencode-wechat` forwards WeChat ClawBot messages to OpenCode and sends OpenCode replies back to WeChat.

## Screenshots

<p align="center">
  <img src="docs/images/01-wechat-chat.jpg" alt="WeChat conversation" width="32%" />
  <img src="docs/images/02-terminal-output.png" alt="Terminal QR and runtime logs" width="32%" />
  <img src="docs/images/03-clawbot-plugin.jpg" alt="WeChat ClawBot plugin page" width="32%" />
</p>

## Quick Start (Recommended)

First clone the repository to your local machine, then run:

```bash
cd opencode-wechat
bun install
bun run build
npm link
```

After `npm link`, you can use the `opencode-wechat` command globally:

```bash
opencode-wechat setup  # QR login
opencode-wechat start  # Start bridge
```

## Quick Start (Run from Source)

If you prefer not to build, you can run TypeScript source directly (requires Bun):

```bash
cd opencode-wechat
bun install
bun opencode-wechat.ts setup
bun opencode-wechat.ts start
```

Or use Node to run the built version (no Bun needed, only Node.js):

```bash
cd opencode-wechat
npm install
npm run build
node cli.mjs setup
node cli.mjs start
```

## Requirements

- Node.js >= 18
- Bun >= 1.0 (for building or running from source)
- OpenCode CLI available in PATH (`opencode`)
- WeChat iOS with ClawBot enabled

## Usage

Keep the process running after starting, then chat with your ClawBot contact in WeChat.

### Commands

- `opencode-wechat setup` or `node cli.mjs setup` - QR login
- `opencode-wechat start` or `node cli.mjs start` - Start bridge
- `opencode-wechat help` or `node cli.mjs help` - Show help

## Log Files

Log directory: `~/.opencode/channels/wechat/logs`

- Timing log: `~/.opencode/channels/wechat/logs/timing.log.jsonl`
- Conversation log: `~/.opencode/channels/wechat/logs/chat.log.jsonl`

### Quick view

```bash
cat ~/.opencode/channels/wechat/logs/timing.log.jsonl
cat ~/.opencode/channels/wechat/logs/chat.log.jsonl
```

### Time fields

- `ts_ms`: Unix timestamp in milliseconds
- `time_bj`: Beijing time

### Retention

- Both log files keep only the latest 24 hours.

## Common Environment Variables

- `OPENCODE_BIN`: OpenCode binary path (default: `opencode`)
- `OPENCODE_MODEL`: passed to `opencode run --model`
- `OPENCODE_AGENT`: passed to `opencode run --agent`
- `OPENCODE_WORKDIR`: passed to `opencode run --dir`
- `WECHAT_BASE_URL`: WeChat ilink API base URL
- `WECHAT_BOT_TYPE`: QR login bot type (default: `3`)
- `WECHAT_QR_MODE`: QR rendering mode (`small` or `ansi`)
- `OPENCODE_WECHAT_RUNTIME`: runtime (`node` or `bun`, default: `node`)

## Chinese Documentation

Chinese version: `README.md`
