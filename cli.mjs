#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "dist");

function getBunPath() {
  try {
    return execSync("which bun", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function runScript(script, args = []) {
  const scriptPath = resolve(DIST_DIR, script);
  if (!existsSync(scriptPath)) {
    console.error(`Error: ${scriptPath} not found. Run: npm run build`);
    process.exit(1);
  }

  const preferred = process.env.OPENCODE_WECHAT_RUNTIME?.trim().toLowerCase() || "node";
  const runtime = preferred === "bun" ? getBunPath() || process.execPath : process.execPath;
  const result = spawnSync(runtime, [scriptPath, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      LANG: process.env.LANG || "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    },
  });
  process.exit(result.status ?? 1);
}

function help() {
  console.log(`
OpenCode WeChat Bridge

Usage: opencode-wechat <command>

Commands:
  setup   WeChat QR login
  start   Start WeChat <-> OpenCode bridge
  help    Show this help

Environment variables:
  OPENCODE_BIN       OpenCode binary path (default: opencode)
  OPENCODE_MODEL     OpenCode model, e.g. anthropic/claude-sonnet-4
  OPENCODE_AGENT     OpenCode agent name
  OPENCODE_WORKDIR   Working directory for OpenCode runs
  WECHAT_BASE_URL    ilink API base URL
  WECHAT_BOT_TYPE    bot_type for QR login (default: 3)
  WECHAT_QR_MODE     QR render mode: small | ansi
  OPENCODE_WECHAT_RUNTIME  runtime for scripts: node | bun (default: node)
`);
}

const command = process.argv[2];

switch (command) {
  case "setup":
    runScript("setup.js");
    break;
  case "start":
    runScript("opencode-wechat.js");
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    help();
    process.exit(command ? 1 : 0);
}
