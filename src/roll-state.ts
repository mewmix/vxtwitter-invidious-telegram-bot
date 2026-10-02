import { createFastProof, deriveDice, planRound } from "./core.mjs";
import { fetchBeacon, fetchLatestBeacon, sha256Text } from "./beacon.mjs";
import { gameCall, internal, MAX_ATTEMPTS, proofUrl, RETENTION_MS, stub, telegram } from "./shared";
import type { Beacon, Env, FastRecord, PendingEntropy, RecordState, SlowRecord, State } from "./shared";

function fastResultText(env: Env, record: FastRecord) {
  const proof = record.proof!;
  const result = proof.result as ({ type: "dice"; expression: string; values: number[]; modifier: number; total: number } |
    { type: "wheel"; name: string; version: number; outcome: string; weight: number; totalWeight: number; ticket: number });
  const drand = proof.beacon ? "drand #" + proof.beacon.round : "Worker commitment only (drand timeout)";
  const timing = proof.precommittedBeforeRequest ? "precommitted before request" : "bootstrap commitment";
  let first: string;
  if (result.type === "dice") {
    first = "🎲 " + result.expression + " → [" + result.values.join(", ") + "]" +
      (result.modifier ? " " + (result.modifier > 0 ? "+" : "") + result.modifier : "") + " = " + result.total;
  } else {
    const pct = result.weight * 100 / result.totalWeight;
    first = "🎡 " + result.name + " → " + result.outcome +
      "\nOdds: " + (Number.isInteger(pct) ? pct : Number(pct.toFixed(2))) + "%";
  }
  return first + "\nEntropy: " + timing + " + " + drand +
    "\nSequence: " + proof.sequence + "\nNext commitment: " + proof.nextCommitment +
    "\nProof: " + proofUrl(env, record.requestId);
}

// One Durable Object per original Telegram message. It persists both the fast and
// delayed state machines so webhook retries and Worker restarts never redraw.
export class DiceRoll {
  constructor(private ctx: State, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const record = await this.ctx.storage.get<RecordState>("roll");
      if (!record) return Response.json({ error: "Not found or expired" }, { status: 404 });
      if (record.mode === "fast") return Response.json({ status: record.stage,
        ...(record.proof ? { proof: record.proof } : {}), ...(record.failure ? { failure: record.failure } : {}) },
        { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      return Response.json({ status: record.stage, receipt: record.receipt,
        announcedAt: record.announcedAt, announcementId: record.announcementId,
        ...(record.proof ? { proof: record.proof } : {}), ...(record.failure ? { failure: record.failure } : {}) },
        { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    const input = await request.json() as RecordState;
    const admitted = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<RecordState>("roll")) return true;
      if (input.mode !== "fast" && Date.now() / 1000 > planRound(input.receipt.requestedAt).deadline) return false;
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
    if (record.mode === "fast") return this.fastAlarm(record);
    return this.delayedAlarm(record);
  }

  private async fastAlarm(record: FastRecord): Promise<void> {
    try {
      if (record.stage === "fast-allocate") {
        let allocationResponse = await gameCall(this.env, record.chatId, { op: "allocate", requestId: record.requestId });
        if (allocationResponse.status === 428) {
          const bootstrap = await allocationResponse.json() as { commitment: string; sequence: number };
          const ack = await telegram<{ message_id: number; date: number }>(this.env, "sendMessage", {
            chat_id: record.chatId, message_thread_id: record.threadId,
            reply_parameters: { message_id: record.messageId, allow_sending_without_reply: true },
            text: "🔐 Fast RNG initialized for this chat.\nSequence: " + bootstrap.sequence +
              "\nCommitment: " + bootstrap.commitment +
              "\nThe first roll is a bootstrap roll because this commitment did not exist before its request.",
            link_preview_options: { is_disabled: true },
          });
          const bootstrapAck = await gameCall(this.env, record.chatId, { op: "bootstrapAck",
            commitment: bootstrap.commitment, announcedAt: ack.date });
          if (!bootstrapAck.ok) throw new Error("Bootstrap acknowledgement failed");
          allocationResponse = await gameCall(this.env, record.chatId, { op: "allocate", requestId: record.requestId });
        }
        if (allocationResponse.status === 409) {
          record.busyAttempts++;
          if (record.busyAttempts > 80) throw new Error("Previous roll did not finish publishing");
          await this.ctx.storage.transaction(async tx => {
            await tx.put("roll", record);
            await tx.setAlarm(Date.now() + 250);
          });
          return;
        }
        if (!allocationResponse.ok) throw new Error("Entropy allocation failed");
        const allocation = await allocationResponse.json() as PendingEntropy;
        let beacon: Beacon | null = null;
        try { beacon = await fetchLatestBeacon(1200); } catch { /* committed Worker entropy remains usable */ }
        record.proof = createFastProof({
          requestId: record.requestId, requestedAt: record.requestedAt,
          sequence: allocation.sequence, secret: allocation.secret, commitment: allocation.commitment,
          nextCommitment: allocation.nextCommitment, commitmentAnnouncedAt: allocation.commitmentAnnouncedAt,
          precommittedBeforeRequest: Number.isSafeInteger(allocation.commitmentAnnouncedAt) &&
            allocation.commitmentAnnouncedAt! < record.requestedAt,
          beacon, action: record.action,
        }, sha256Text);
        record.stage = "fast-deliver";
        record.attempts = 0;
        await this.ctx.storage.put("roll", record);
      }

      const ack = await telegram<{ message_id: number; date: number }>(this.env, "sendMessage", {
        chat_id: record.chatId, message_thread_id: record.threadId,
        reply_parameters: { message_id: record.messageId, allow_sending_without_reply: true },
        text: fastResultText(this.env, record), link_preview_options: { is_disabled: true },
      });
      const chainAck = await gameCall(this.env, record.chatId, { op: "ack", requestId: record.requestId,
        nextCommitment: record.proof!.nextCommitment, announcedAt: ack.date });
      if (!chainAck.ok) throw new Error("Next commitment acknowledgement failed");
      record.stage = "done";
      await this.ctx.storage.transaction(async tx => {
        await tx.put("roll", record);
        await tx.setAlarm(record.createdAt + RETENTION_MS);
      });
    } catch (error) {
      record.attempts++;
      if (record.attempts >= MAX_ATTEMPTS) {
        await this.fail(record, "Fast roll could not finish; any allocated commitment was not redrawn automatically.");
        return;
      }
      await this.ctx.storage.transaction(async tx => {
        await tx.put("roll", record);
        await tx.setAlarm(Date.now() + Math.min(5000, 250 * 2 ** record.attempts));
      });
      console.error("Fast roll retry", error);
    }
  }

  private async delayedAlarm(record: SlowRecord): Promise<void> {
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
          text: "🎲 Committed delayed proof: " + record.receipt.expression +
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
        record.proof = { receipt: record.receipt, announcedAt: record.announcedAt!,
          announcementId: record.announcementId!, beacon, result };
        record.stage = "deliver";
        record.attempts = 0;
        await this.ctx.storage.put("roll", record);
      }
      const result = record.proof!.result;
      await telegram(this.env, "sendMessage", {
        chat_id: record.chatId, message_thread_id: record.threadId,
        reply_parameters: { message_id: record.announcementId, allow_sending_without_reply: true },
        text: "🎲 " + record.receipt.expression + " → [" + result.values.join(", ") + "]" +
          (result.modifier ? " " + (result.modifier > 0 ? "+" : "") + result.modifier : "") + " = " + result.total +
          "\nVerified future drand round: " + record.receipt.round +
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
      if (record.attempts >= MAX_ATTEMPTS || (record.stage === "announce" && Date.now() / 1000 > deadline)) {
        await this.fail(record, record.proof ? "Result calculated and proof retained; Telegram delivery failed."
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
    try {
      await telegram(this.env, "sendMessage", { chat_id: record.chatId, message_thread_id: record.threadId,
        text: failure + "\n" + proofUrl(this.env, record.mode === "fast" ? record.requestId : record.receipt.requestId) });
    } catch { /* Durable record already stores the failure. */ }
  }
}

