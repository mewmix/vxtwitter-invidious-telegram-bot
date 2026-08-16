#!/usr/bin/env node
// Registers (or updates) the Telegram webhook for the deployed Worker.
// Idempotent: safe to re-run after every deploy.
//
// Usage:
//   npm run set-webhook -- https://<worker>.workers.dev
//   WORKER_URL=https://<worker>.workers.dev npm run set-webhook
//
// Credentials are read from local files (gitignored), or env overrides:
//   telegram-token            -> TELEGRAM_TOKEN
//   telegram-webhook-secret   -> TELEGRAM_WEBHOOK_SECRET
// The secret must match the Worker's TELEGRAM_WEBHOOK_SECRET.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readCredential(envValue, fileName) {
  if (envValue) return envValue.trim();
  try {
    return (await readFile(join(repoRoot, fileName), "utf8")).trim();
  } catch {
    return null;
  }
}

const workerUrl = (process.argv[2] ?? process.env.WORKER_URL ?? "").replace(
  /\/$/,
  "");
const token = await readCredential(process.env.TELEGRAM_TOKEN, "telegram-token");
const webhookSecret = await readCredential(
  process.env.TELEGRAM_WEBHOOK_SECRET,
  "telegram-webhook-secret",
);

if (!workerUrl || !token || !webhookSecret) {
  console.error(
    "Missing: provide the worker URL as an argument (or WORKER_URL), " +
      "and put the bot token in telegram-token and the webhook secret in " +
      "telegram-webhook-secret (or set TELEGRAM_TOKEN/TELEGRAM_WEBHOOK_SECRET).",
  );
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, body) {
  const response = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`${method} failed: ${payload.description}`);
  }
  return payload.result;
}

const result = await call("setWebhook", {
  url: `${workerUrl}/webhook`,
  secret_token: webhookSecret,
  allowed_updates: ["message"],
});
console.log(`setWebhook ok: ${JSON.stringify(result)}`);

const info = await call("getWebhookInfo", {});
console.log(`getWebhookInfo: ${JSON.stringify(info, null, 2)}`);
if (info.last_error_message) {
  console.error(`Warning: webhook last error: ${info.last_error_message}`);
  process.exit(1);
}
