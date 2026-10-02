#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { FAST_PROTOCOL, validateFastProof, validateProof } from "../src/core.mjs";
import { sha256Text, verifyBeacon } from "../src/beacon.mjs";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    commitment: { type: "string" }, expression: { type: "string" },
    "requested-at": { type: "string" }, "announced-at": { type: "string" },
    "chat-id": { type: "string" }, "message-id": { type: "string" },
  },
});
try {
  if (positionals.length !== 1) throw new Error("Usage: npm run verify -- URL_OR_FILE [--commitment HEX] [--chat-id ID --message-id ID]");
  const source = positionals[0];
  let payload;
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Proof download failed");
    payload = await response.json();
  } else {
    payload = JSON.parse(await readFile(source, "utf8"));
  }
  const proof = payload.proof ?? payload;
  if (options["chat-id"] || options["message-id"]) {
    const chat = Number(options["chat-id"]), message = Number(options["message-id"]);
    if (!options["chat-id"] || !options["message-id"] ||
        !Number.isSafeInteger(chat) || !Number.isSafeInteger(message)) throw new Error("Invalid message identifiers");
    const id = sha256Text(JSON.stringify(["telegram-dice-request-v1", chat, message]));
    const proofId = proof.protocol === FAST_PROTOCOL ? proof.requestId : proof.receipt?.requestId;
    if (proofId !== id) throw new Error("Proof belongs to another Telegram request");
  }

  if (proof.protocol === FAST_PROTOCOL) {
    if (options.commitment && proof.commitment !== options.commitment)
      throw new Error("Fast proof does not match the previously published commitment");
    if (options["requested-at"] && proof.requestedAt !== Number(options["requested-at"]))
      throw new Error("Fast proof request time mismatch");
    if (options.expression && (proof.action.type !== "dice" || proof.action.expression !== options.expression))
      throw new Error("Fast proof expression mismatch");
    const result = validateFastProof(proof, sha256Text, verifyBeacon);
    console.log(JSON.stringify({ verified: true, mode: "fast", drandVerified: Boolean(proof.beacon),
      precommittedBeforeRequest: proof.precommittedBeforeRequest, sequence: proof.sequence, result }, null, 2));
    if (!options.commitment)
      console.error("Cryptography verified, but prior publication was not checked. Supply --commitment from the previous Telegram message.");
  } else {
    if (!["commitment", "expression", "requested-at", "announced-at"].every(key => options[key]))
      throw new Error("Delayed proofs require --commitment, --expression, --requested-at, and --announced-at");
    if (proof.receipt.commitment !== options.commitment || proof.receipt.expression !== options.expression ||
        proof.receipt.requestedAt !== Number(options["requested-at"]) || proof.announcedAt !== Number(options["announced-at"]))
      throw new Error("Proof does not match the original group messages");
    const result = validateProof(proof, sha256Text, verifyBeacon);
    console.log(JSON.stringify({ verified: true, mode: "future-drand", round: proof.receipt.round, ...result }, null, 2));
  }
  if (!options["chat-id"])
    console.error("Telegram request identity was not checked; supply --chat-id and --message-id to check it.");
} catch (error) {
  console.error("Verification failed: " + error.message);
  process.exitCode = 1;
}
