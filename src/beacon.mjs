import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { CHAIN_HASH, PUBLIC_KEY } from "./core.mjs";

export function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
export function sha256Text(text) {
  return hex(sha256(new TextEncoder().encode(text)));
}
function decode(value, bytes) {
  if (typeof value !== "string" || !new RegExp("^[0-9a-f]{" + (bytes * 2) + "}$").test(value))
    throw new Error("Invalid hex encoding");
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}
export function verifyBeacon(beacon, expectedRound) {
  try {
    if (!Number.isSafeInteger(expectedRound) || expectedRound < 1 || beacon.round !== expectedRound) return false;
    const signature = decode(beacon.signature, 48);
    if (hex(sha256(signature)) !== beacon.randomness) return false;
    const roundBytes = new Uint8Array(8);
    new DataView(roundBytes.buffer).setBigUint64(0, BigInt(expectedRound), false);
    // quicknet signs SHA256(uint64-BE(round)), with signatures on G1 and keys on G2.
    return bls12_381.verifyShortSignature(signature, sha256(roundBytes), decode(PUBLIC_KEY, 96), {
      DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
    });
  } catch {
    return false;
  }
}
const RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"];

async function relayBeacon(relay, path, timeoutMs) {
  const response = await fetch(relay + "/" + CHAIN_HASH + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("drand relay failed");
  const body = await response.json();
  const beacon = { round: body.round, signature: body.signature, randomness: body.randomness };
  if (!verifyBeacon(beacon, beacon.round)) throw new Error("drand verification failed");
  return beacon;
}

export async function fetchBeacon(round) {
  for (const relay of RELAYS) {
    try {
      const beacon = await relayBeacon(relay, "/public/" + round, 4000);
      if (beacon.round === round) return beacon;
    } catch { /* Try another relay, for the same pinned chain and round only. */ }
  }
  throw new Error("No valid beacon available");
}

// Fast gameplay path: query relays in parallel and use the first locally verified
// quicknet response. Callers may fall back to the already-precommitted Worker
// secret when drand is temporarily unavailable; the proof records that explicitly.
export async function fetchLatestBeacon(timeoutMs = 1200) {
  const attempts = RELAYS.map(relay => relayBeacon(relay, "/public/latest", timeoutMs));
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error("No recent valid beacon available");
  }
}
