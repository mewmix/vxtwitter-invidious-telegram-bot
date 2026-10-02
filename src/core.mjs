export const PROTOCOL = "telegram-dice-drand-v1";
export const CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const PUBLIC_KEY = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const GENESIS = 1692803367;
export const PERIOD = 3;
export const DELAY = 60;
export const MARGIN = 5;

export function parseDice(input = "1d6") {
  const match = /^([1-9]\d{0,2})?d([1-9]\d{0,6})([+-]\d{1,6})?$/i.exec(input.trim());
  if (!match) throw new Error("Use /roll, /roll d20, or /roll 2d6+3.");
  const count = Number(match[1] ?? 1), sides = Number(match[2]), modifier = Number(match[3] ?? 0);
  if (count > 100 || sides < 2 || sides > 1000000 || Math.abs(modifier) > 100000)
    throw new Error("Limits: 1–100 dice, 2–1000000 sides, modifier ±100000.");
  return { count, sides, modifier, expression: count + "d" + sides + (modifier ? (modifier > 0 ? "+" : "") + modifier : "") };
}

export function roundAtOrAfter(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < GENESIS) throw new Error("Invalid timestamp");
  return Math.ceil((timestamp - GENESIS) / PERIOD) + 1;
}
export function roundTime(round) {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("Invalid round");
  return GENESIS + (round - 1) * PERIOD;
}
export function planRound(requestedAt) {
  const round = roundAtOrAfter(requestedAt + DELAY);
  return { round, targetTime: roundTime(round), deadline: roundTime(round) - MARGIN };
}

// sha256Fn accepts UTF-8 text and returns a lowercase 64-character hex string.
export function createReceipt(requestId, requestedAt, expression, sha256Fn) {
  if (!/^[0-9a-f]{64}$/.test(requestId)) throw new Error("Invalid request ID");
  const dice = parseDice(expression), { round } = planRound(requestedAt);
  const canonical = JSON.stringify([PROTOCOL, CHAIN_HASH, requestId, requestedAt, dice.expression, round]);
  return { protocol: PROTOCOL, chainHash: CHAIN_HASH, requestId, requestedAt,
    expression: dice.expression, round, commitment: sha256Fn(canonical) };
}

// The entire accepted 32-bit range contains an equal number of values per face.
export function sampleWord(word, sides) {
  if (!Number.isInteger(word) || word < 0 || word >= 2 ** 32 ||
      !Number.isInteger(sides) || sides < 2 || sides > 1000000) throw new Error("Invalid sample");
  const limit = Math.floor(2 ** 32 / sides) * sides;
  return word < limit ? word % sides + 1 : null;
}

export function deriveDice(receipt, randomness, sha256Fn) {
  if (!/^[0-9a-f]{64}$/.test(randomness)) throw new Error("Invalid randomness");
  const spec = parseDice(receipt.expression), values = [];
  // Counter expansion domain-separates the roll from drand and from other requests.
  for (let counter = 0; values.length < spec.count && counter < 4096; counter++) {
    const hex = sha256Fn(JSON.stringify([PROTOCOL, "dice", receipt.commitment, randomness, counter]));
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid digest");
    for (let offset = 0; offset < 64 && values.length < spec.count; offset += 8) {
      const face = sampleWord(Number.parseInt(hex.slice(offset, offset + 8), 16), spec.sides);
      if (face !== null) values.push(face);
    }
  }
  if (values.length !== spec.count) throw new Error("Sampling exhausted; do not reroll");
  return { values, modifier: spec.modifier, total: values.reduce((a, b) => a + b, spec.modifier) };
}

export function validateProof(proof, sha256Fn, verifyBeaconFn) {
  const expected = createReceipt(proof.receipt.requestId, proof.receipt.requestedAt, proof.receipt.expression, sha256Fn);
  for (const key of Object.keys(expected)) {
    if (proof.receipt[key] !== expected[key]) throw new Error("Receipt mismatch: " + key);
  }
  const { targetTime, deadline } = planRound(expected.requestedAt);
  // This time comes from Telegram's acknowledgement; the verifier must compare the
  // original group message to establish its authenticity and actual publication.
  if (!Number.isSafeInteger(proof.announcedAt) || proof.announcedAt < expected.requestedAt ||
      proof.announcedAt > deadline || proof.announcedAt >= targetTime)
    throw new Error("Commitment was not announced in time");
  if (!verifyBeaconFn(proof.beacon, expected.round)) throw new Error("Invalid drand signature");
  const result = deriveDice(expected, proof.beacon.randomness, sha256Fn);
  if (JSON.stringify(proof.result) !== JSON.stringify(result)) throw new Error("Result mismatch");
  return result;
}
