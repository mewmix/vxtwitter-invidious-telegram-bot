import { parseWheelSpec, secretCommitment, wheelKey } from "./core.mjs";
import { sha256Text } from "./beacon.mjs";
import type { PendingEntropy, State, Wheel } from "./shared.ts";

interface EntropyState {
  sequence: number;
  secret: string;
  commitment: string;
  announced: boolean;
  announcedAt?: number;
}
function bytesHex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function randomSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesHex(bytes);
}

// Per-chat state for the instant protocol. The current secret can be allocated only
// if its commitment has already been acknowledged by Telegram. Allocation is
// idempotent for a request ID and only one unpublished next commitment may exist.
export class GameState {
  constructor(private ctx: State) {}
  private async bootstrap() {
    let entropy = await this.ctx.storage.get<EntropyState>("entropy");
    if (!entropy) {
      const sequence = 1, secret = randomSecret();
      entropy = { sequence, secret, commitment: secretCommitment(secret, sequence, sha256Text), announced: false };
      await this.ctx.storage.put("entropy", entropy);
    }
    return entropy;
  }
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, any>;
    switch (body.op) {
      case "bootstrap": {
        const entropy = await this.bootstrap();
        return Response.json({ sequence: entropy.sequence, commitment: entropy.commitment,
          announced: entropy.announced, announcedAt: entropy.announcedAt });
      }
      case "bootstrapAck": {
        const entropy = await this.ctx.storage.get<EntropyState>("entropy");
        if (!entropy || entropy.commitment !== body.commitment || !Number.isSafeInteger(body.announcedAt))
          return Response.json({ error: "Bootstrap state mismatch" }, { status: 409 });
        entropy.announced = true;
        entropy.announcedAt = body.announcedAt;
        await this.ctx.storage.put("entropy", entropy);
        return Response.json({ ok: true });
      }
      case "status": {
        const entropy = await this.ctx.storage.get<EntropyState>("entropy");
        const pending = await this.ctx.storage.get<PendingEntropy>("pending");
        return Response.json({ entropy: entropy ? { sequence: entropy.sequence, commitment: entropy.commitment,
          announced: entropy.announced, announcedAt: entropy.announcedAt } : null,
          pending: pending ? { requestId: pending.requestId, sequence: pending.sequence } : null });
      }
      case "verboseGet":
        return Response.json({ verbose: await this.ctx.storage.get<boolean>("verbose") ?? false });
      case "verboseSet": {
        if (typeof body.verbose !== "boolean") return Response.json({ error: "Invalid verbose value" }, { status: 400 });
        await this.ctx.storage.put("verbose", body.verbose);
        return Response.json({ verbose: body.verbose });
      }
      case "reset": {
        const sequence = ((await this.ctx.storage.get<EntropyState>("entropy"))?.sequence ?? 0) + 1;
        const secret = randomSecret();
        const entropy: EntropyState = { sequence, secret, commitment: secretCommitment(secret, sequence, sha256Text), announced: false };
        await this.ctx.storage.transaction(async tx => {
          await tx.put("entropy", entropy);
          await tx.delete("pending");
        });
        return Response.json({ sequence, commitment: entropy.commitment });
      }
      case "allocate": {
        const pending = await this.ctx.storage.get<PendingEntropy>("pending");
        if (pending) {
          if (pending.requestId === body.requestId) return Response.json(pending);
          return Response.json({ error: "Previous result is still publishing" }, { status: 409 });
        }
        const entropy = await this.bootstrap();
        if ((!entropy.announced || !Number.isSafeInteger(entropy.announcedAt)) && body.allowUnannounced !== true)
          return Response.json({ bootstrap: true, sequence: entropy.sequence, commitment: entropy.commitment }, { status: 428 });
        const nextSequence = entropy.sequence + 1, nextSecret = randomSecret();
        const nextCommitment = secretCommitment(nextSecret, nextSequence, sha256Text);
        const allocation: PendingEntropy = {
          requestId: body.requestId, sequence: entropy.sequence, secret: entropy.secret,
          commitment: entropy.commitment, commitmentAnnouncedAt: entropy.announcedAt,
          nextSequence, nextSecret, nextCommitment,
        };
        await this.ctx.storage.put("pending", allocation);
        return Response.json(allocation);
      }
      case "ack": {
        const pending = await this.ctx.storage.get<PendingEntropy>("pending");
        if (!pending || pending.requestId !== body.requestId || pending.nextCommitment !== body.nextCommitment ||
            !Number.isSafeInteger(body.announcedAt))
          return Response.json({ error: "Allocation acknowledgement mismatch" }, { status: 409 });
        const entropy: EntropyState = { sequence: pending.nextSequence, secret: pending.nextSecret,
          commitment: pending.nextCommitment, announced: body.published !== false,
          ...(body.published !== false ? { announcedAt: body.announcedAt } : {}) };
        await this.ctx.storage.transaction(async tx => {
          await tx.put("entropy", entropy);
          await tx.delete("pending");
        });
        return Response.json({ ok: true });
      }
      case "wheelList": {
        const wheels = await this.ctx.storage.get<Record<string, Wheel>>("wheels") ?? {};
        return Response.json({ wheels: Object.values(wheels).sort((a, b) => a.name.localeCompare(b.name)) });
      }
      case "wheelGet": {
        const wheels = await this.ctx.storage.get<Record<string, Wheel>>("wheels") ?? {};
        const wheel = wheels[wheelKey(body.name)];
        return wheel ? Response.json({ wheel }) : Response.json({ error: "Wheel not found" }, { status: 404 });
      }
      case "wheelSave": {
        const parsed = parseWheelSpec(body.spec);
        const key = wheelKey(parsed.name);
        const result = await this.ctx.storage.transaction(async tx => {
          const wheels = await tx.get<Record<string, Wheel>>("wheels") ?? {};
          const existing = wheels[key];
          if (body.mode === "create" && existing) return { error: "Wheel already exists", status: 409 };
          if (body.mode === "set" && !existing) return { error: "Wheel not found", status: 404 };
          const wheel: Wheel = { name: parsed.name, key, version: (existing?.version ?? 0) + 1,
            options: parsed.options, totalWeight: parsed.totalWeight };
          wheels[key] = wheel;
          await tx.put("wheels", wheels);
          return { wheel, status: 200 };
        });
        return result.error ? Response.json({ error: result.error }, { status: result.status }) : Response.json({ wheel: result.wheel });
      }
      case "wheelDelete": {
        const key = wheelKey(body.name);
        const result = await this.ctx.storage.transaction(async tx => {
          const wheels = await tx.get<Record<string, Wheel>>("wheels") ?? {};
          if (!wheels[key]) return false;
          delete wheels[key];
          await tx.put("wheels", wheels);
          return true;
        });
        return Response.json({ deleted: result }, { status: result ? 200 : 404 });
      }
      default:
        return Response.json({ error: "Unknown game operation" }, { status: 400 });
    }
  }
}
