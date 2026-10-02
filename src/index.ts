import { createReceipt, parseDice, planRound, PROTOCOL, FAST_PROTOCOL, wheelConfigHash } from "./core.mjs";
import { sha256Text } from "./beacon.mjs";
import { gameCall, internal, stub, telegram } from "./shared";
import type { Env, Message, State, Wheel } from "./shared";
export { GameState } from "./game-state";
export { DiceRoll } from "./roll-state";

const HELP = [
  "🎲 Fast dice: /roll, /roll d20, /roll 2d6+3",
  "🎡 Wheel: /wheel spin Otters Luck",
  "Create: /wheel create Otters Luck | Lucky:20 | Unlucky:80",
  "Change odds: /wheel set Otters Luck | Lucky:35 | Unlucky:65",
  "Other: /wheel list, /wheel show NAME, /wheel delete NAME",
  "🔐 /entropy status; /entropy reset is admin-only.",
  "🧪 /rollproof 2d6+3 keeps the older ~60s future-drand proof mode.",
  "Fast rolls reveal a previously committed Worker secret and mix in a verified recent drand beacon when one is reachable quickly.",
].join("\n");

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function command(text: string, username: string): { name: string; argument: string } | null {
  const match = /^\/(roll|dice|rollproof|wheel|entropy|help|start)(?:@([A-Za-z0-9_]+))?(?:\s+(.+))?$/i.exec(text.trim());
  if (match) {
    if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return null;
    return { name: match[1].toLowerCase(), argument: match[3]?.trim() ?? "" };
  }
  const trigger = new RegExp("^(?:@?" + escapeRegExp(username) + "|wheelbot)\\s+spin\\s+(.+?)(?:\\s+wheel)?$", "i");
  const natural = trigger.exec(text.trim());
  return natural ? { name: "wheel", argument: "spin " + natural[1].trim() } : null;
}
async function isAdmin(env: Env, msg: Message) {
  if (msg.chat.id > 0) return true;
  if (!Number.isSafeInteger(msg.from?.id)) return false;
  const member = await telegram<{ status: string }>(env, "getChatMember", { chat_id: msg.chat.id, user_id: msg.from!.id });
  return member.status === "creator" || member.status === "administrator";
}
function wheelText(wheel: Wheel) {
  return wheel.name + " v" + wheel.version + "\n" + wheel.options.map(option => {
    const pct = option.weight * 100 / wheel.totalWeight;
    return "• " + option.label + ": " + (Number.isInteger(pct) ? pct : Number(pct.toFixed(2))) + "% (" + option.weight + ")";
  }).join("\n");
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
      if (entries.length >= 30) return false;
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

async function sendBootstrap(env: Env, msg: Message, prefix = "🔐 Fast RNG ready.") {
  const response = await gameCall(env, msg.chat.id, { op: "bootstrap" });
  if (!response.ok) throw new Error("Entropy bootstrap failed");
  const state = await response.json() as { sequence: number; commitment: string; announced: boolean };
  if (state.announced) return state;
  const ack = await telegram<{ message_id: number; date: number }>(env, "sendMessage", {
    chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
    text: prefix + "\nSequence: " + state.sequence + "\nNext commitment: " + state.commitment,
    link_preview_options: { is_disabled: true },
  });
  const confirmed = await gameCall(env, msg.chat.id, { op: "bootstrapAck", commitment: state.commitment, announcedAt: ack.date });
  if (!confirmed.ok) throw new Error("Entropy bootstrap acknowledgement failed");
  return { ...state, announced: true };
}

async function handleWheel(env: Env, msg: Message, argument: string, requestId: string) {
  const trimmed = argument.trim();
  const split = /^(create|set|difficulty|spin|show|list|delete)\b\s*(.*)$/i.exec(trimmed);
  const sub = split?.[1].toLowerCase() ?? "spin";
  const rest = split ? split[2].trim() : trimmed;
  if (sub === "list") {
    const response = await gameCall(env, msg.chat.id, { op: "wheelList" });
    const { wheels } = await response.json() as { wheels: Wheel[] };
    await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: wheels.length ? "🎡 Wheels\n" + wheels.map(w => "• " + w.name + " (v" + w.version + ")").join("\n") : "No wheels yet." });
    return;
  }
  if (sub === "show") {
    const response = await gameCall(env, msg.chat.id, { op: "wheelGet", name: rest });
    if (!response.ok) throw new Error("Wheel not found");
    const { wheel } = await response.json() as { wheel: Wheel };
    await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🎡 " + wheelText(wheel) });
    return;
  }
  if (sub === "create" || sub === "set" || sub === "difficulty") {
    if (!await isAdmin(env, msg)) throw new Error("Only a group admin can change wheels");
    const response = await gameCall(env, msg.chat.id, { op: "wheelSave", mode: sub === "create" ? "create" : "set", spec: rest });
    const data = await response.json() as { wheel?: Wheel; error?: string };
    if (!response.ok || !data.wheel) throw new Error(data.error ?? "Wheel update failed");
    await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
      text: "🎡 Saved\n" + wheelText(data.wheel) + "\nConfig: " + wheelConfigHash(data.wheel, sha256Text) });
    return;
  }
  if (sub === "delete") {
    if (!await isAdmin(env, msg)) throw new Error("Only a group admin can delete wheels");
    const response = await gameCall(env, msg.chat.id, { op: "wheelDelete", name: rest });
    if (!response.ok) throw new Error("Wheel not found");
    await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🎡 Deleted " + rest });
    return;
  }
  if (sub !== "spin" || !rest) throw new Error("Use /wheel spin NAME or /wheel create NAME | A:20 | B:80");
  const response = await gameCall(env, msg.chat.id, { op: "wheelGet", name: rest.replace(/\s+wheel$/i, "") });
  const data = await response.json() as { wheel?: Wheel; error?: string };
  if (!response.ok || !data.wheel) throw new Error(data.error ?? "Wheel not found");
  const roll = await stub(env.ROLLS, requestId).fetch(internal("POST", {
    mode: "fast", requestId, requestedAt: msg.date, chatId: msg.chat.id, messageId: msg.message_id,
    threadId: msg.message_thread_id, stage: "fast-allocate", createdAt: Date.now(), attempts: 0, busyAttempts: 0,
    action: { type: "wheel", wheel: data.wheel },
  }));
  if (!roll.ok && roll.status !== 409) throw new Error("Wheel spin admission failed");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({ ok: true, protocols: [FAST_PROTOCOL, PROTOCOL] });
    const match = /^\/proof\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === "GET" && match) return stub(env.ROLLS, match[1]).fetch(internal("GET"));
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("Not found", { status: 404 });
    if (!env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
      return new Response("Forbidden", { status: 403 });
    if (!env.TELEGRAM_TOKEN || !env.BOT_USERNAME || !env.PUBLIC_BASE_URL || !env.GAME)
      return new Response("Bot configuration incomplete", { status: 503 });
    if (Number(request.headers.get("content-length") ?? 0) > 65536) return new Response("Too large", { status: 413 });
    let update: { update_id: number; message?: Message };
    try {
      const body = await request.text();
      if (body.length > 65536) return new Response("Too large", { status: 413 });
      update = JSON.parse(body);
      if (!update || !Number.isSafeInteger(update.update_id)) throw new Error();
    } catch { return new Response("Invalid update", { status: 400 }); }
    const msg = update.message;
    if (typeof msg?.text !== "string" || !msg.text) return Response.json({ ok: true });
    if (!Number.isSafeInteger(msg.message_id) || !Number.isSafeInteger(msg.chat?.id) || !Number.isSafeInteger(msg.date))
      return new Response("Invalid message", { status: 400 });
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

      if (cmd.name === "help") {
        await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: HELP });
        return Response.json({ ok: true });
      }
      if (cmd.name === "start") {
        const state = await sendBootstrap(env, msg, "🔐 Fast RNG initialized.");
        await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
          text: HELP + "\n\nCurrent commitment: " + state.commitment });
        return Response.json({ ok: true });
      }
      if (cmd.name === "entropy") {
        const action = cmd.argument.trim().toLowerCase() || "status";
        if (action === "status") {
          const response = await gameCall(env, msg.chat.id, { op: "status" });
          const data = await response.json() as any;
          await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
            text: data.entropy ? "🔐 Sequence: " + data.entropy.sequence + "\nCommitment: " + data.entropy.commitment +
              "\nPublished: " + Boolean(data.entropy.announced) + (data.pending ? "\nPending roll: " + data.pending.requestId : "")
              : "Fast RNG is not initialized. Use /start." });
          return Response.json({ ok: true });
        }
        if (action === "reset") {
          if (!await isAdmin(env, msg)) throw new Error("Only a group admin can reset entropy");
          const response = await gameCall(env, msg.chat.id, { op: "reset" });
          const state = await response.json() as { sequence: number; commitment: string };
          const ack = await telegram<{ message_id: number; date: number }>(env, "sendMessage", {
            chat_id: msg.chat.id, message_thread_id: msg.message_thread_id,
            text: "⚠️ Entropy chain reset by an admin.\nSequence: " + state.sequence + "\nNew commitment: " + state.commitment,
          });
          const confirmed = await gameCall(env, msg.chat.id, { op: "bootstrapAck", commitment: state.commitment, announcedAt: ack.date });
          if (!confirmed.ok) throw new Error("Reset acknowledgement failed");
          return Response.json({ ok: true });
        }
        throw new Error("Use /entropy status or /entropy reset");
      }
      if (cmd.name === "wheel") {
        await handleWheel(env, msg, cmd.argument, id);
        return Response.json({ ok: true });
      }
      if (cmd.name === "rollproof") {
        const dice = parseDice(cmd.argument || "1d6");
        if (Date.now() / 1000 > planRound(msg.date).deadline) return Response.json({ ok: true, expired: true });
        const receipt = createReceipt(id, msg.date, dice.expression, sha256Text);
        const response = await stub(env.ROLLS, id).fetch(internal("POST", {
          mode: "delayed", receipt, chatId: msg.chat.id, messageId: msg.message_id,
          threadId: msg.message_thread_id, stage: "announce", createdAt: Date.now(), attempts: 0,
        }));
        if (!response.ok && response.status !== 409) throw new Error("Delayed roll admission failed");
        return Response.json({ ok: true });
      }
      const dice = parseDice(cmd.argument || "1d6");
      const response = await stub(env.ROLLS, id).fetch(internal("POST", {
        mode: "fast", requestId: id, requestedAt: msg.date, chatId: msg.chat.id, messageId: msg.message_id,
        threadId: msg.message_thread_id, stage: "fast-allocate", createdAt: Date.now(), attempts: 0, busyAttempts: 0,
        action: { type: "dice", expression: dice.expression },
      }));
      if (!response.ok && response.status !== 409) throw new Error("Fast roll admission failed");
      return Response.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      console.error("Telegram update processing failed", error);
      try { await telegram(env, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "⚠️ " + message }); }
      catch { /* Return retryable status if Telegram is also unavailable. */ }
      return Response.json({ ok: false }, { status: 503 });
    }
  },
};
