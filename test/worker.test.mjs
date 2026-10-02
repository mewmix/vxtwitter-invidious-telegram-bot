import test from "node:test";
import assert from "node:assert/strict";
import worker, { DiceRoll, ChatGate, GameState } from "../src/index.ts";
import { createReceipt, planRound, deriveDice } from "../src/core.mjs";
import { sha256Text } from "../src/beacon.mjs";

class MemoryStorage {
  values = new Map();
  nextAlarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(at) { this.nextAlarm = at; }
  async deleteAll() { this.values.clear(); }
  async delete(key) { return this.values.delete(key); }
  async transaction(fn) { return fn(this); }
}
const dummyNamespace = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
const env = { TELEGRAM_TOKEN: "test", TELEGRAM_WEBHOOK_SECRET: "secret",
  BOT_USERNAME: "dice_bot", PUBLIC_BASE_URL: "https://dice.test", GAME: dummyNamespace };
const inputRequest = record => new Request("https://internal/", {
  method: "POST", body: JSON.stringify(record),
});
function setup(t) {
  const dateNow = Date.now, originalFetch = globalThis.fetch;
  let now = 1760000000000;
  Date.now = () => now;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/bot"));
    calls.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 100 + calls.length, date: Math.floor(now / 1000) } });
  };
  t.after(() => { Date.now = dateNow; globalThis.fetch = originalFetch; });
  const store = new MemoryStorage(), roll = new DiceRoll({ storage: store }, env);
  const receipt = createReceipt("a".repeat(64), Math.floor(now / 1000), "2d6+3", sha256Text);
  const record = { mode: "delayed", receipt, chatId: -100123, messageId: 7, stage: "announce", createdAt: now, attempts: 0 };
  return { store, roll, record, calls, setTime: value => { now = value; } };
}

test("GameState bootstraps, allocates idempotently, then rotates only after acknowledgement", async () => {
  const store = new MemoryStorage(), game = new GameState({ storage: store });
  let response = await game.fetch(inputRequest({ op: "bootstrap" }));
  const bootstrap = await response.json();
  assert.equal(bootstrap.sequence, 1);
  assert.match(bootstrap.commitment, /^[0-9a-f]{64}$/);
  response = await game.fetch(inputRequest({ op: "allocate", requestId: "a".repeat(64) }));
  assert.equal(response.status, 428);
  assert.equal((await game.fetch(inputRequest({ op: "bootstrapAck", commitment: bootstrap.commitment, announcedAt: 100 }))).status, 200);
  const first = await (await game.fetch(inputRequest({ op: "allocate", requestId: "a".repeat(64) }))).json();
  const duplicate = await (await game.fetch(inputRequest({ op: "allocate", requestId: "a".repeat(64) }))).json();
  assert.deepEqual(duplicate, first);
  assert.equal((await game.fetch(inputRequest({ op: "allocate", requestId: "b".repeat(64) }))).status, 409);
  assert.equal((await game.fetch(inputRequest({ op: "ack", requestId: first.requestId,
    nextCommitment: first.nextCommitment, announcedAt: 110 }))).status, 200);
  const second = await (await game.fetch(inputRequest({ op: "allocate", requestId: "b".repeat(64) }))).json();
  assert.equal(second.sequence, 2);
  assert.equal(second.commitment, first.nextCommitment);
  assert.equal(second.commitmentAnnouncedAt, 110);
});

test("GameState versions named weighted wheels and preserves exact weights", async () => {
  const game = new GameState({ storage: new MemoryStorage() });
  let response = await game.fetch(inputRequest({ op: "wheelSave", mode: "create",
    spec: "Otters Luck | Lucky:20 | Unlucky:80" }));
  const first = (await response.json()).wheel;
  assert.equal(first.version, 1);
  assert.equal(first.totalWeight, 100);
  assert.equal((await game.fetch(inputRequest({ op: "wheelSave", mode: "create",
    spec: "Otters Luck | Lucky:50 | Unlucky:50" }))).status, 409);
  response = await game.fetch(inputRequest({ op: "wheelSave", mode: "set",
    spec: "Otters Luck | Lucky:35 | Unlucky:65" }));
  const second = (await response.json()).wheel;
  assert.equal(second.version, 2);
  assert.deepEqual(second.options, [{ label: "Lucky", weight: 35 }, { label: "Unlucky", weight: 65 }]);
  const fetched = await (await game.fetch(inputRequest({ op: "wheelGet", name: "otters luck" }))).json();
  assert.equal(fetched.wheel.version, 2);
});

test("duplicate delayed admission retains the original receipt and announcement", async t => {
  const { store, roll, record, calls } = setup(t);
  assert.equal((await roll.fetch(inputRequest(record))).status, 200);
  await roll.alarm();
  assert.equal((await store.get("roll")).stage, "wait");
  await roll.fetch(inputRequest({ ...record, receipt: { ...record.receipt, expression: "99d20" } }));
  assert.equal((await store.get("roll")).receipt.expression, "2d6+3");
  await roll.alarm();
  assert.equal(calls.length, 1);
});

test("late delayed acknowledgement fails closed without selecting another round", async t => {
  const { store, roll, record, setTime } = setup(t);
  await roll.fetch(inputRequest(record));
  globalThis.fetch = async () => Response.json({ ok: true, result: {
    message_id: 99, date: planRound(record.receipt.requestedAt).targetTime,
  } });
  await roll.alarm();
  const saved = await store.get("roll");
  assert.equal(saved.stage, "failed");
  assert.equal(saved.receipt.round, record.receipt.round);
  assert.equal(saved.proof, undefined);
  setTime(record.createdAt + 1000);
  await roll.alarm();
  assert.equal((await store.get("roll")).stage, "failed");
});

test("transient delayed delivery failures retain an already calculated proof", async t => {
  const { store, roll, record, setTime } = setup(t);
  const proof = { receipt: record.receipt, announcedAt: record.receipt.requestedAt,
    announcementId: 42, beacon: { round: record.receipt.round, randomness: "0".repeat(64), signature: "fixture" },
    result: deriveDice(record.receipt, "0".repeat(64), sha256Text) };
  await store.put("roll", { ...record, stage: "deliver", proof });
  globalThis.fetch = async () => { throw new Error("Network outage"); };
  await roll.alarm();
  assert.equal((await store.get("roll")).stage, "deliver");
  assert.deepEqual((await store.get("roll")).proof, proof);
  globalThis.fetch = async () => Response.json({ ok: true, result: {} });
  await roll.alarm();
  assert.equal((await store.get("roll")).stage, "done");
  setTime(record.createdAt + 30 * 86400000);
  await roll.alarm();
  assert.equal(await store.get("roll"), undefined);
});

test("chat budget counts distinct requests", async () => {
  const store = new MemoryStorage(), gate = new ChatGate({ storage: store });
  for (let i = 0; i < 30; i++) assert.equal((await gate.fetch(inputRequest({ id: String(i) }))).status, 200);
  assert.equal((await gate.fetch(inputRequest({ id: "0" }))).status, 200);
  assert.equal((await gate.fetch(inputRequest({ id: "31" }))).status, 429);
});

test("webhook rejects forged updates and ignores unrelated traffic", async t => {
  const { calls } = setup(t);
  const request = (text, secret = "secret") => new Request("https://dice.test/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 1, message: {
      message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: -123 }, from: { id: 1 }, text,
    } }),
  });
  const localEnv = { ...env, ROLLS: dummyNamespace, CHAT_GATE: dummyNamespace };
  assert.equal((await worker.fetch(request("/roll", "wrong"), localEnv)).status, 403);
  assert.equal((await worker.fetch(request("https://x.com/user/status/123"), localEnv)).status, 200);
  assert.equal((await worker.fetch(request("/roll@other_bot 2d6"), localEnv)).status, 200);
  assert.equal(calls.length, 0);
});
