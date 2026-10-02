import { createFastProof, createReceipt, deriveDice } from "./core.mjs";

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (txn: Storage) => Promise<T>): Promise<T>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAll(): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export interface State { storage: Storage }
export interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BOT_USERNAME: string;
  PUBLIC_BASE_URL: string;
  ALLOWED_CHAT_IDS?: string;
  ROLLS: Namespace;
  CHAT_GATE: Namespace;
  GAME: Namespace;
}
export interface Message {
  message_id: number;
  date: number;
  chat: { id: number; type?: string };
  from?: { id: number };
  text?: string;
  message_thread_id?: number;
}
export type Receipt = ReturnType<typeof createReceipt>;
export type Beacon = { round: number; randomness: string; signature: string };
export type Wheel = { name: string; key: string; version: number; options: { label: string; weight: number }[]; totalWeight: number };

export interface SlowRecord {
  mode?: "delayed";
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
  proof?: { receipt: Receipt; announcedAt: number; announcementId: number; beacon: Beacon; result: ReturnType<typeof deriveDice> };
}
export interface FastRecord {
  mode: "fast";
  requestId: string;
  requestedAt: number;
  chatId: number;
  messageId: number;
  threadId?: number;
  stage: "fast-allocate" | "fast-deliver" | "done" | "failed";
  createdAt: number;
  attempts: number;
  busyAttempts: number;
  action: { type: "dice"; expression: string } | { type: "wheel"; wheel: Wheel };
  failure?: string;
  proof?: ReturnType<typeof createFastProof>;
}
export type RecordState = SlowRecord | FastRecord;
export interface PendingEntropy {
  requestId: string;
  sequence: number;
  secret: string;
  commitment: string;
  commitmentAnnouncedAt?: number;
  nextSequence: number;
  nextSecret: string;
  nextCommitment: string;
}

export const RETENTION_MS = 30 * 86400 * 1000;
export const MAX_ATTEMPTS = 12;

export async function telegram<T>(env: Env, method: string, body: object): Promise<T> {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  const payload = await response.json() as { ok: boolean; result: T; description?: string };
  if (!response.ok || !payload.ok) throw new Error("Telegram API failed");
  return payload.result;
}
export function stub(namespace: Namespace, name: string) {
  return namespace.get(namespace.idFromName(name));
}
export function internal(method: string, data?: object) {
  return new Request("https://internal/", {
    method, ...(data ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } } : {}),
  });
}
export function proofUrl(env: Env, id: string) {
  return env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/proof/" + id;
}
export async function gameCall(env: Env, chatId: number, data: object) {
  return stub(env.GAME, String(chatId)).fetch(internal("POST", data));
}
