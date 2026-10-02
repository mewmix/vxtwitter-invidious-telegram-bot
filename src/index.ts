import { createReceipt, parseDice, planRound, deriveDice, PROTOCOL } from "./core.mjs";
import { fetchBeacon, sha256Text } from "./beacon.mjs";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (txn: Storage) => Promise<T>): Promise<T>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAll(): Promise<void>;
  delete(key: string): Promise<boolean>;
}
interface State { storage: Storage }
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Env {
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BOT_USERNAME: string;
  PUBLIC_BASE_URL: string;
  ALLOWED_CHAT_IDS?: string;
  ROLLS: Namespace;
  CHAT_GATE: Namespace;
}
interface Message {
  message_id: number;
  date: number;
  chat: { id: number };
  text?: string;
  message_thread_id?: number;
}
type Receipt = ReturnType<typeof createReceipt>;
interface RecordState {
  receipt: Receipt;
  chatId: number;
  messageId: number;
  threadId?: number;
  stage: "announce" | "wait" | "deliver" | "done" | "failed";
  createdAt: number;
  attempts: number;
  announcementId?: number;
  announcedAt?: number;
  failure?: string;
  proof?: {
    receipt: Receipt;
    announcedAt: number;
    announcementId: number;
    beacon: { round: number; randomness: string; signature: string };
    result: ReturnType<typeof deriveDice>;
  };
}

const RETENTION_MS = 30 * 86400 * 1000;
const MAX_ATTEMPTS = 12;
const HELP = "Verifiable dice: /roll (1d6), /roll d20, /roll 2d6+3.\n" +
  "I announce a fixed future drand round, then post the result about a minute after your request. " +
  "The proof URL contains the signed beacon and reproducible dice calculation. " +
  "Keep the commitment message to verify it was published before the beacon.";

async function telegram<T>(env: Env, method: string, body: object): Promise<T> {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  const payload = await response.json() as { ok: boolean; result: T; description?: string };
  if (!response.ok || !payload.ok) throw new Error("Telegram API failed");
  return payload.result;
}
function stub(namespace: Namespace, name: string) {
  return namespace.get(namespace.idFromName(name));
}
function internal(method: string, data?: object) {
  return new Request("https://internal/", {
    method, ...(data ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } } : {}),
  });
}
function proofUrl(env: Env, id: string) {
  return env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/proof/" + id;
}
function command(text: string, username: string): { name: string; argument: string } | null {
  const match = /^\/(roll|dice|help|start)(?:@([A-Za-z0-9_]+))?(?:\s+(.+))?$/i.exec(text.trim());
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), argument: match[3]?.trim() ?? "" };
}

// One Durable Object per chat: a bounded one-minute request budget. Duplicate
// requests already admitted in the current window do not consume the budget.
export class ChatGate {
  constructor(private ctx: State) {}
  async fetch(request: Request): Promise<Response> {
    const { id } = await request.json() as { id: string };
    const allowed = await this.ctx.storage.transaction(async tx => {
      const now = Date.now();
      const entries = (await tx.get<{ id: string; at: number }[]>("entries") ?? [])
        .filter(entry => now - entry.at < 60000);
      if (entries.some(entry => entry.id === id)) return true;
      if (entries.length >= 12) return false;
      entries.push({ id, at: now });
      await tx.put("entries", entries);
      await tx.setAlarm(now + 60000);
      return true;
    });
    return Response.json({ allowed }, { status: allowed ? 200 : 429 });
  }
  async alarm() {
    await this.ctx.storage.transaction(async tx => {
      const entries = (await tx.get<{ id: string; at: number }[]>("entries") ?? [])
        .filter(entry => Date.now() - entry.at < 60000);
      if (!entries.length) await tx.delete("entries");
      else {
        await tx.put("entries", entries);
        await tx.setAlarm(Math.max(...entries.map(entry => entry.at)) + 60000);
      }
    });
  }
}

// One Durable Object per original Telegram message. Persist before acknowledging
// the webhook. Alarms serialize delivery and survive Worker restarts.
export class DiceRoll {
  constructor(private ctx: State, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const record = await this.ctx.storage.get<RecordState>("roll");
      if (!record) return Response.json({ error: "Not found or expired" }, { status: 404 });
      return Response.json({
        status: record.stage, receipt: record.receipt,
        announcedAt: record.announcedAt, announcementId: record.announcementId,
        ...(record.proof ? { proof: record.proof } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
      }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    const input = await request.json() as RecordState;
    const admitted = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<RecordState>("roll")) return true;
      if (Date.now() / 1000 > planRound(input.receipt.requestedAt).deadline) return false;
      await tx.put("roll", input);
      await tx.setAlarm(Date.now());
      return true;
    });
    return Response.json({ ok: admitted }, { status: admitted ? 200 : 409 });
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<RecordState>("roll");
    if (!record) return;
    if (record.stage === "done" || record.stage === "failed") {
      if (Date.now() >= record.createdAt + RETENTION_MS) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(record.createdAt + RETENTION_MS);
      return;
    }
    const { targetTime, deadline } = planRound(record.receipt.requestedAt);
    try {
      if (record.stage === "announce") {
        if (Date.now() / 1000 > deadline) {
          await this.fail(record, "Commitment deadline missed; no roll produced.");
          return;
        }
        const ack = await telegram<{ message_id: number; date: number }>(this.env, "sendMessage", {
          chat_id: record.chatId, message_thread_id: record.threadId,
          reply_parameters: { message_id: record.messageId, allow_sending_without_reply: true },
          text: "🎲 Committed: " + record.receipt.expression +
            "\nRequest: " + record.receipt.requestId +
            "\nRequested at: " + record.receipt.requestedAt +
            "\ndrand quicknet round: " + record.receipt.round +
            "\nAvailable at: " + new Date(targetTime * 1000).toISOString() +
            "\nCommitment: " + record.receipt.commitment +
            "\nProof: " + proofUrl(this.env, record.receipt.requestId),
          link_preview_options: { is_disabled: true },
        });
        if (!Number.isSafeInteger(ack.date) || ack.date < record.receipt.requestedAt || ack.date > deadline) {
          await this.fail(record, "Telegram acknowledged the commitment too late; no roll produced.");
          return;
        }
        record.announcementId = ack.message_id;
        record.announcedAt = ack.date;
        record.stage = "wait";
        record.attempts = 0;
        await this.ctx.storage.transaction(async tx => {
          await tx.put("roll", record);
          await tx.setAlarm(Math.max(Date.now() + 100, targetTime * 1000 + 1000));
        });
        return;
      }

      if (record.stage === "wait") {
        if (Date.now() < targetTime * 1000) {
          await this.ctx.storage.setAlarm(targetTime * 1000 + 1000);
          return;
        }
        const beacon = await fetchBeacon(record.receipt.round);
        const result = deriveDice(record.receipt, beacon.randomness, sha256Text);
        record.proof = {
          receipt: record.receipt, announcedAt: record.announcedAt!,
          announcementId: record.announcementId!, beacon, result,
        };
        record.stage = "deliver";
        record.attempts = 0;
        // Store the proof before contacting Telegram. A delivery retry never draws again.
        await this.ctx.storage.put("roll", record);
      }

      const result = record.proof!.result;
      await telegram(this.env, "sendMessage", {
        chat_id: record.chatId, message_thread_id: record.threadId,
        reply_parameters: { message_id: record.announcementId, allow_sending_without_reply: true },
        text: "🎲 " + record.receipt.expression + " → [" + result.values.join(", ") +
          "]" + (result.modifier ? " " + (result.modifier > 0 ? "+" : "") + result.modifier : "") +
          " = " + result.total +
          "\nVerified drand round: " + record.receipt.round +
          "\nProof: " + proofUrl(this.env, record.receipt.requestId),
        link_preview_options: { is_disabled: true },
      });
      record.stage = "done";
      await this.ctx.storage.transaction(async tx => {
        await tx.put("roll", record);
        await tx.setAlarm(record.createdAt + RETENTION_MS);
      });
    } catch {
      record.attempts++;
      if (record.attempts >= MAX_ATTEMPTS ||
          (record.stage === "announce" && Date.now() / 1000 > deadline)) {
        await this.fail(record, record.proof
          ? "Result calculated and proof retained; Telegram delivery failed."
          : "Roll could not finish; the committed round was never changed.");
        return;
      }
      const next = Date.now() + Math.min(60000, 2000 * 2 ** record.attempts);
      await this.ctx.storage.transaction(async tx => {
        await tx.put("roll", record);
        await tx.setAlarm(next);
      });
    }
  }

  private async fail(record: RecordState, failure: string) {
    record.stage = "failed";
    record.failure = failure;
    await this.ctx.storage.transaction(async tx => {
      await tx.put("roll", record);
      await tx.setAlarm(record.createdAt + RETENTION_MS);
    });
    // Error notification is best effort. Failure is always visible at the proof URL.
    try {
      await telegram(this.env, "sendMessage", {
        chat_id: record.chatId, message_thread_id: record.threadId,
        text: failure + "\n" + proofUrl(this.env, record.receipt.requestId),
      });
    } catch { /* Durable record already stores the failure. */ }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({ ok: true, protocol: PROTOCOL });
    const match = /^\/proof\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === "GET" && match)
      return stub(env.ROLLS, match[1]).fetch(internal("GET"));
    if (request.method !== "POST" || url.pathname !== "/webhook")
      return new Response("Not found", { status: 404 });
    if (!env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
      return new Response("Forbidden", { status: 403 });
    if (!env.TELEGRAM_TOKEN || !env.BOT_USERNAME || !env.PUBLIC_BASE_URL)
      return new Response("Bot configuration incomplete", { status: 503 });
    if (Number(request.headers.get("content-length") ?? 0) > 65536)
      return new Response("Too large", { status: 413 });
    let update: { update_id: number; message?: Message };
    try {
      const body = await request.text();
      if (body.length > 65536) return new Response("Too large", { status: 413 });
      update = JSON.parse(body);
      if (!update || !Number.isSafeInteger(update.update_id)) throw new Error();
    } catch { return new Response("Invalid update", { status: 400 }); }
    const msg = update.message;
    if (typeof msg?.text !== "string" || !msg.text) return Response.json({ ok: true });
    if (!Number.isSafeInteger(msg.message_id) || !Number.isSafeInteger(msg.chat?.id) ||
        !Number.isSafeInteger(msg.date)) return new Response("Invalid message", { status: 400 });
    if (env.ALLOWED_CHAT_IDS && !env.ALLOWED_CHAT_IDS.split(",").map(x => x.trim()).includes(String(msg.chat.id)))
      return Response.json({ ok: true });
    const cmd = command(msg.text, env.BOT_USERNAME);
    if (!cmd) return Response.json({ ok: true });
    try {
      const id = sha256Text(JSON.stringify(["telegram-dice-request-v1", msg.chat.id, msg.message_id]));
      if (msg.date > Math.floor(Date.now() / 1000) + 5 || Date.now() / 1000 - msg.date > 120)
        return Response.json({ ok: true, expired: true });
      const gate = await stub(env.CHAT_GATE, String(msg.chat.id)).fetch(internal("POST", { id }));
      if (gate.status === 429) return Response.json({ ok: true, rateLimited: true });
      if (!gate.ok) throw new Error("Gate failed");
      if (cmd.name === "help" || cmd.name === "start") {
        await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: HELP });
        return Response.json({ ok: true });
      }
      let dice;
      try { dice = parseDice(cmd.argument || "1d6"); }
      catch (error) {
        await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: (error as Error).message });
        return Response.json({ ok: true });
      }
      // The request ID above binds to the original message, never to a retry update ID.
      if (msg.date > Math.floor(Date.now() / 1000) + 5 || Date.now() / 1000 > planRound(msg.date).deadline)
        return Response.json({ ok: true, expired: true });
      const receipt = createReceipt(id, msg.date, dice.expression, sha256Text);
      const response = await stub(env.ROLLS, id).fetch(internal("POST", {
        receipt, chatId: msg.chat.id, messageId: msg.message_id,
        threadId: msg.message_thread_id, stage: "announce", createdAt: Date.now(), attempts: 0,
      }));
      if (!response.ok && response.status !== 409) throw new Error("Roll admission failed");
      return Response.json({ ok: true });
    } catch {
      console.error("Telegram update processing failed");
      return Response.json({ ok: false }, { status: 503 });
    }
  },
};
