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
export async function fetchBeacon(round) {
  for (const relay of RELAYS) {
    try {
      const response = await fetch(relay + "/" + CHAIN_HASH + "/public/" + round, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) continue;
      const body = await response.json();
      const beacon = { round: body.round, signature: body.signature, randomness: body.randomness };
      if (verifyBeacon(beacon, round)) return beacon;
    } catch { /* Try another relay, for the same pinned chain and round only. */ }
  }
  throw new Error("No valid beacon available");
}
