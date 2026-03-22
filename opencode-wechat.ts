#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_BASE_URL = process.env.WECHAT_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
const BOT_TYPE = process.env.WECHAT_BOT_TYPE?.trim() || "3";
const DATA_DIR = path.join(process.env.HOME || "~", ".opencode", "channels", "wechat");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SYNC_BUF_FILE = path.join(DATA_DIR, "sync_buf.txt");
const LOG_DIR = path.join(DATA_DIR, "logs");
const TIMING_LOG_FILE = path.join(LOG_DIR, "timing.log.jsonl");
const CHAT_LOG_FILE = path.join(LOG_DIR, "chat.log.jsonl");

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const OPENCODE_TIMEOUT_MS = 300_000;
const WECHAT_REPLY_CHUNK_SIZE = 1200;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOG_PRUNE_INTERVAL_MS = 60_000;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

type BridgeState = {
  senderSessions: Record<string, string>;
  contextTokens: Record<string, string>;
  savedAt: string;
};

type TextItem = {
  text?: string;
};

type ImageItem = {
  cdn_url?: string;
  file_name?: string;
};

type RefMessage = {
  title?: string;
};

type MessageItem = {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: { text?: string };
  ref_msg?: RefMessage;
};

type WeixinMessage = {
  from_user_id?: string;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
};

type GetUpdatesResp = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
};

type QRCodeResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

type QRStatusResponse = {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
};

type OpencodeRunResult = {
  sessionId: string;
  reply: string;
  elapsedMs: number;
  firstTextMs?: number;
};

function log(message: string): void {
  process.stderr.write(`[opencode-wechat] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[opencode-wechat] ERROR: ${message}\n`);
}

function isUtf8Locale(): boolean {
  const raw = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return /utf-?8/i.test(raw);
}

function useSmallQrMode(): boolean {
  const mode = process.env.WECHAT_QR_MODE?.trim().toLowerCase();
  if (mode === "small") return true;
  if (mode === "ansi") return false;
  return isUtf8Locale();
}

const beijingFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const pruneAt = new Map<string, number>();

function beijingTime(tsMs: number): string {
  const parts = beijingFormatter.formatToParts(new Date(tsMs));
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function pruneLogFile(filePath: string, nowMs: number): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  if (lines.length === 0) return;
  const cutoff = nowMs - LOG_RETENTION_MS;
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { ts_ms?: number };
      if (typeof row.ts_ms !== "number") continue;
      if (row.ts_ms < cutoff) continue;
      kept.push(line);
    } catch {
    }
  }
  const output = kept.length ? `${kept.join("\n")}\n` : "";
  fs.writeFileSync(filePath, output, "utf-8");
}

function pruneLogFileIfNeeded(filePath: string, nowMs: number): void {
  const last = pruneAt.get(filePath) || 0;
  if (nowMs - last < LOG_PRUNE_INTERVAL_MS) return;
  pruneLogFile(filePath, nowMs);
  pruneAt.set(filePath, nowMs);
}

function appendJsonLog(filePath: string, tsMs: number, payload: Record<string, unknown>): void {
  ensureDataDir();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  pruneLogFileIfNeeded(filePath, Date.now());
  const row = {
    ts_ms: tsMs,
    time_bj: beijingTime(tsMs),
    ...payload,
  };
  fs.appendFileSync(filePath, JSON.stringify(row) + "\n", "utf-8");
}

function appendTimingLog(payload: Record<string, unknown>): void {
  appendJsonLog(TIMING_LOG_FILE, Date.now(), payload);
}

function appendChatLog(tsMs: number, payload: Record<string, unknown>): void {
  appendJsonLog(CHAT_LOG_FILE, tsMs, payload);
}

function pruneLogsNow(): void {
  const nowMs = Date.now();
  pruneLogFile(TIMING_LOG_FILE, nowMs);
  pruneAt.set(TIMING_LOG_FILE, nowMs);
  pruneLogFile(CHAT_LOG_FILE, nowMs);
  pruneAt.set(CHAT_LOG_FILE, nowMs);
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) return null;
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as AccountData;
  } catch {
    return null;
  }
}

function saveCredentials(data: AccountData): void {
  ensureDataDir();
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(ACCOUNT_FILE, 0o600);
  } catch {
  }
}

function loadState(): BridgeState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        senderSessions: {},
        contextTokens: {},
        savedAt: new Date().toISOString(),
      };
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Partial<BridgeState>;
    return {
      senderSessions: raw.senderSessions || {},
      contextTokens: raw.contextTokens || {},
      savedAt: raw.savedAt || new Date().toISOString(),
    };
  } catch {
    return {
      senderSessions: {},
      contextTokens: {},
      savedAt: new Date().toISOString(),
    };
  }
}

function saveState(state: BridgeState): void {
  ensureDataDir();
  const payload: BridgeState = {
    senderSessions: state.senderSessions,
    contextTokens: state.contextTokens,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function doQRLogin(baseUrl: string): Promise<AccountData | null> {
  log("requesting WeChat login QR code");
  const qrResp = await fetchQRCode(baseUrl);
  log(`qr url: ${qrResp.qrcode_img_content}`);

  try {
    const qrterm = await import("qrcode-terminal");
    const small = useSmallQrMode();
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrResp.qrcode_img_content, { small }, (qr: string) => {
        process.stderr.write(qr + "\n");
        resolve();
      });
    });
  } catch {
    log("qr rendering failed in terminal, open qr url manually");
  }

  log("waiting for scan and confirmation");

  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    if (status.status === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (status.status === "scaned") {
      if (!scannedPrinted) {
        scannedPrinted = true;
        log("qr scanned, waiting for confirmation");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (status.status === "expired") {
      logError("qr expired");
      return null;
    }

    if (!status.ilink_bot_id || !status.bot_token) {
      logError("login confirmed but bot fields are missing");
      return null;
    }

    const account: AccountData = {
      token: status.bot_token,
      baseUrl: status.baseurl || baseUrl,
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id,
      savedAt: new Date().toISOString(),
    };
    saveCredentials(account);
    log("wechat login successful");
    return account;
  }

  logError("login timeout");
  return null;
}

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";

  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg?.title;
      if (!ref) return text;
      return `[quote: ${ref}]\n${text}`;
    }

    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }

    if (item.type === MSG_ITEM_IMAGE) {
      const file = item.image_item?.file_name || "unknown";
      const url = item.image_item?.cdn_url;
      return url ? `[image] file=${file} url=${url}` : `[image] file=${file}`;
    }
  }

  return "";
}

async function getUpdates(baseUrl: string, token: string, getUpdatesBuf: string): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: "0.1.0" },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `opencode-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: "0.1.0" },
    }),
    token,
    timeoutMs: 15_000,
  });
}

function splitText(input: string, maxLen: number): string[] {
  if (!input.trim()) return ["(empty response)"];
  if (input.length <= maxLen) return [input];
  const chunks: string[] = [];
  let start = 0;
  while (start < input.length) {
    const next = start + maxLen;
    chunks.push(input.slice(start, next));
    start = next;
  }
  return chunks;
}

function buildPrompt(senderId: string, text: string): string {
  return [
    "You are replying to a WeChat user through OpenCode.",
    "Return plain text only, no markdown.",
    "Be concise and natural.",
    `Sender: ${senderId}`,
    "User message:",
    text,
  ].join("\n");
}

function parseEventLine(line: string): Record<string, unknown> | null {
  const input = line.trim();
  if (!input) return null;
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runOpencodePrompt(params: {
  senderId: string;
  text: string;
  sessionId?: string;
}): Promise<OpencodeRunResult> {
  const startedAt = Date.now();
  const opencodeBin = process.env.OPENCODE_BIN?.trim() || "opencode";
  const args: string[] = ["run", "--format", "json"];

  if (params.sessionId) {
    args.push("--session", params.sessionId);
  }
  if (process.env.OPENCODE_MODEL?.trim()) {
    args.push("--model", process.env.OPENCODE_MODEL.trim());
  }
  if (process.env.OPENCODE_AGENT?.trim()) {
    args.push("--agent", process.env.OPENCODE_AGENT.trim());
  }
  if (process.env.OPENCODE_WORKDIR?.trim()) {
    args.push("--dir", process.env.OPENCODE_WORKDIR.trim());
  }

  const prompt = buildPrompt(params.senderId, params.text);

  const child = spawn(opencodeBin, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: string[] = [];
  const seenPartIds = new Set<string>();
  const errors: string[] = [];
  let observedSessionId = params.sessionId || "";
  let firstTextAt: number | undefined;
  let stderr = "";
  let killedByTimeout = false;

  const timeout = setTimeout(() => {
    killedByTimeout = true;
    child.kill("SIGTERM");
  }, OPENCODE_TIMEOUT_MS);

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    const event = parseEventLine(line);
    if (!event) return;

    if (typeof event.sessionID === "string" && event.sessionID) {
      observedSessionId = event.sessionID;
    }

    if (event.type === "text") {
      const part = event.part as { id?: string; text?: string } | undefined;
      if (!part?.text) return;
      if (part.id && seenPartIds.has(part.id)) return;
      if (part.id) seenPartIds.add(part.id);
      const text = part.text.trim();
      if (text && firstTextAt === undefined) firstTextAt = Date.now();
      if (text) chunks.push(text);
      return;
    }

    if (event.type === "error") {
      const err = event.error as { data?: { message?: string } } | undefined;
      const message = err?.data?.message;
      if (message) errors.push(String(message));
    }
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  child.stdin.write(prompt);
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  clearTimeout(timeout);
  stdoutLines.close();

  const reply = chunks.join("\n\n").trim();
  const elapsedMs = Date.now() - startedAt;
  const firstTextMs = firstTextAt ? firstTextAt - startedAt : undefined;
  if (reply && observedSessionId) {
    return {
      sessionId: observedSessionId,
      reply,
      elapsedMs,
      firstTextMs,
    };
  }

  if (killedByTimeout) {
    throw new Error(`opencode run timed out after ${OPENCODE_TIMEOUT_MS}ms`);
  }

  if (errors.length > 0) {
    throw new Error(`opencode error: ${errors.join(" | ")}`);
  }

  if (exitCode !== 0) {
    throw new Error(`opencode exited with code ${exitCode}: ${stderr.trim()}`);
  }

  if (!observedSessionId) {
    throw new Error("opencode did not return a session id");
  }

  return {
    sessionId: observedSessionId,
    reply: "I received your message but did not produce a text response.",
    elapsedMs,
    firstTextMs,
  };
}

async function sendReplyChunks(
  account: AccountData,
  senderId: string,
  contextToken: string,
  text: string,
): Promise<{ chunkCount: number; elapsedMs: number }> {
  const startedAt = Date.now();
  const parts = splitText(text, WECHAT_REPLY_CHUNK_SIZE);
  for (const part of parts) {
    await sendTextMessage(account.baseUrl, account.token, senderId, part, contextToken);
  }
  return {
    chunkCount: parts.length,
    elapsedMs: Date.now() - startedAt,
  };
}

async function handleInboundMessage(
  account: AccountData,
  state: BridgeState,
  msg: WeixinMessage,
): Promise<void> {
  const reqId = `wx-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const startedAt = Date.now();
  const senderId = msg.from_user_id;
  if (!senderId) return;

  const text = extractTextFromMessage(msg);
  if (!text) return;

  appendChatLog(startedAt, {
    req_id: reqId,
    direction: "inbound",
    sender_id: senderId,
    content: text,
  });

  if (msg.context_token) {
    state.contextTokens[senderId] = msg.context_token;
    saveState(state);
  }

  const contextToken = state.contextTokens[senderId];
  if (!contextToken) {
    logError(`no context token for ${senderId}, skipping message`);
    return;
  }

  log(`inbound from ${senderId}: ${text.slice(0, 80)}`);

  let result: OpencodeRunResult;
  try {
    result = await runOpencodePrompt({
      senderId,
      text,
      sessionId: state.senderSessions[senderId],
    });
  } catch (err) {
    const totalMs = Date.now() - startedAt;
    appendTimingLog({
      req_id: reqId,
      sender_id: senderId,
      status: "opencode_failed",
      total_ms: totalMs,
      error: String(err),
    });
    throw err;
  }

  state.senderSessions[senderId] = result.sessionId;
  saveState(state);

  appendChatLog(Date.now(), {
    req_id: reqId,
    direction: "outbound",
    sender_id: senderId,
    session_id: result.sessionId,
    content: result.reply,
  });

  const sendStat = await sendReplyChunks(account, senderId, contextToken, result.reply);
  const totalMs = Date.now() - startedAt;

  appendTimingLog({
    req_id: reqId,
    sender_id: senderId,
    session_id: result.sessionId,
    status: "ok",
    total_ms: totalMs,
    opencode_ms: result.elapsedMs,
    first_text_ms: result.firstTextMs,
    send_ms: sendStat.elapsedMs,
    chunks: sendStat.chunkCount,
    inbound_chars: text.length,
    outbound_chars: result.reply.length,
  });

  log(
    `reply sent to ${senderId} total=${totalMs}ms opencode=${result.elapsedMs}ms first=${String(result.firstTextMs)}ms send=${sendStat.elapsedMs}ms chunks=${sendStat.chunkCount}`,
  );
}

async function startPolling(account: AccountData): Promise<never> {
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;
  const state = loadState();

  ensureDataDir();
  if (fs.existsSync(SYNC_BUF_FILE)) {
    try {
      getUpdatesBuf = fs.readFileSync(SYNC_BUF_FILE, "utf-8");
      log(`restored sync buffer (${getUpdatesBuf.length} bytes)`);
    } catch {
    }
  }

  log("polling WeChat messages");

  while (true) {
    try {
      const resp = await getUpdates(account.baseUrl, account.token, getUpdatesBuf);

      const hasApiError =
        (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (hasApiError) {
        consecutiveFailures += 1;
        logError(
          `getUpdates failed: ret=${String(resp.ret)} errcode=${String(resp.errcode)} errmsg=${resp.errmsg || ""}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAY_MS));
        } else {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        fs.writeFileSync(SYNC_BUF_FILE, getUpdatesBuf, "utf-8");
      }

      for (const msg of resp.msgs || []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        try {
          await handleInboundMessage(account, state, msg);
        } catch (err) {
          logError(`failed to process inbound message: ${String(err)}`);
        }
      }
    } catch (err) {
      consecutiveFailures += 1;
      logError(`poll error: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAY_MS));
      } else {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
}

async function main(): Promise<void> {
  let account = loadCredentials();

  if (!account) {
    log("credentials not found, starting QR login");
    account = await doQRLogin(DEFAULT_BASE_URL);
    if (!account) {
      logError("login failed");
      process.exit(1);
    }
  }

  log(`logged in as account ${account.accountId}`);
  pruneLogsNow();
  await startPolling(account);
}

main().catch((err) => {
  logError(`fatal: ${String(err)}`);
  process.exit(1);
});
