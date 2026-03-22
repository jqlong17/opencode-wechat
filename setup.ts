#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = process.env.WECHAT_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
const BOT_TYPE = process.env.WECHAT_BOT_TYPE?.trim() || "3";
const DATA_DIR = path.join(process.env.HOME || "~", ".opencode", "channels", "wechat");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
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

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(url, {
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

function saveAccount(account: AccountData): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), "utf-8");
  try {
    fs.chmodSync(ACCOUNT_FILE, 0o600);
  } catch {
  }
}

async function confirmReloginIfNeeded(): Promise<boolean> {
  if (!fs.existsSync(ACCOUNT_FILE)) return true;
  try {
    const current = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as AccountData;
    console.log(`Existing account: ${current.accountId}`);
    console.log(`Saved at: ${current.savedAt}`);
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Re-login and overwrite credentials? (y/N) ", resolve);
    });
    rl.close();
    return answer.trim().toLowerCase() === "y";
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const proceed = await confirmReloginIfNeeded();
  if (!proceed) {
    console.log("Keeping current credentials.");
    process.exit(0);
  }

  console.log("Requesting WeChat login QR code...");
  const qrResp = await fetchQRCode(DEFAULT_BASE_URL);
  console.log(`QR URL: ${qrResp.qrcode_img_content}`);

  try {
    const qrterm = await import("qrcode-terminal");
    const small = useSmallQrMode();
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrResp.qrcode_img_content, { small }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log("QR rendering failed in terminal. Open the QR URL above in a browser.");
  }

  console.log("Scan with WeChat and confirm on your phone...");
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(DEFAULT_BASE_URL, qrResp.qrcode);

    if (status.status === "wait") {
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (status.status === "scaned") {
      if (!scannedPrinted) {
        scannedPrinted = true;
        console.log("\nQR scanned, waiting for confirmation...");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (status.status === "expired") {
      console.error("\nQR expired. Run setup again.");
      process.exit(1);
    }

    if (!status.ilink_bot_id || !status.bot_token) {
      console.error("\nLogin confirmed but bot info is missing.");
      process.exit(1);
    }

    const account: AccountData = {
      token: status.bot_token,
      baseUrl: status.baseurl || DEFAULT_BASE_URL,
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id,
      savedAt: new Date().toISOString(),
    };

    saveAccount(account);

    console.log("\nLogin successful.");
    console.log(`Account ID: ${account.accountId}`);
    console.log(`User ID: ${account.userId || ""}`);
    console.log(`Credentials: ${ACCOUNT_FILE}`);
    console.log("\nNext: opencode-wechat start");
    process.exit(0);
  }

  console.error("\nLogin timeout. Run setup again.");
  process.exit(1);
}

main().catch((err) => {
  console.error(`setup error: ${String(err)}`);
  process.exit(1);
});
