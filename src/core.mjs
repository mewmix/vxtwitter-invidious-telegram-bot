export const PROTOCOL = "telegram-dice-drand-v1";
export const FAST_PROTOCOL = "telegram-dice-fast-v2";
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

function sampleBelow(word, modulus) {
  if (!Number.isInteger(word) || word < 0 || word >= 2 ** 32 ||
      !Number.isSafeInteger(modulus) || modulus < 1 || modulus > 10000000) throw new Error("Invalid weighted sample");
  const limit = Math.floor(2 ** 32 / modulus) * modulus;
  return word < limit ? word % modulus : null;
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

export function secretCommitment(secret, sequence, sha256Fn) {
  if (!/^[0-9a-f]{64}$/.test(secret) || !Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Invalid committed secret");
  return sha256Fn(JSON.stringify([FAST_PROTOCOL, "secret", sequence, secret]));
}

function cleanName(value, max = 80) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > max || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid name");
  return name;
}

export function wheelKey(name) {
  return cleanName(name).toLocaleLowerCase("en-US");
}

export function parseWheelSpec(input) {
  const parts = String(input ?? "").split("|").map(part => part.trim()).filter(Boolean);
  if (parts.length < 3) throw new Error("Use: /wheel create Otters Luck | Lucky:20 | Unlucky:80");
  const name = cleanName(parts[0]);
  const options = parts.slice(1).map(part => {
    const split = part.lastIndexOf(":");
    if (split < 1) throw new Error("Each wheel option must be Label:weight");
    const label = cleanName(part.slice(0, split), 64);
    const weightText = part.slice(split + 1).trim();
    if (!/^\d{1,7}$/.test(weightText)) throw new Error("Wheel weights must be positive integers");
    const weight = Number(weightText);
    if (weight < 1 || weight > 1000000) throw new Error("Wheel weights must be 1–1000000");
    return { label, weight };
  });
  if (options.length < 2 || options.length > 32) throw new Error("A wheel needs 2–32 outcomes");
  const seen = new Set();
  for (const option of options) {
    const key = option.label.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error("Wheel outcome labels must be unique");
    seen.add(key);
  }
  const totalWeight = options.reduce((sum, option) => sum + option.weight, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight > 10000000) throw new Error("Wheel total weight is too large");
  return { name, options, totalWeight };
}

export function wheelConfigHash(wheel, sha256Fn) {
  if (!wheel || !Number.isSafeInteger(wheel.version) || wheel.version < 1) throw new Error("Invalid wheel version");
  const parsed = parseWheelSpec([wheel.name, ...wheel.options.map(option => `${option.label}:${option.weight}`)].join(" | "));
  return sha256Fn(JSON.stringify([FAST_PROTOCOL, "wheel-config", parsed.name, wheel.version,
    parsed.options.map(option => [option.label, option.weight])]));
}

function fastSeed(proof, sha256Fn) {
  const actionHash = proof.action.type === "dice"
    ? sha256Fn(JSON.stringify([FAST_PROTOCOL, "dice-action", parseDice(proof.action.expression).expression]))
    : wheelConfigHash(proof.action.wheel, sha256Fn);
  const beaconPart = proof.beacon
    ? [CHAIN_HASH, proof.beacon.round, proof.beacon.randomness]
    : null;
  return sha256Fn(JSON.stringify([FAST_PROTOCOL, "seed", proof.requestId, proof.requestedAt,
    proof.sequence, proof.commitment, proof.secret, beaconPart, actionHash]));
}

function deriveFastDice(proof, seed, sha256Fn) {
  const spec = parseDice(proof.action.expression), values = [];
  for (let counter = 0; values.length < spec.count && counter < 4096; counter++) {
    const hex = sha256Fn(JSON.stringify([FAST_PROTOCOL, "dice", seed, counter]));
    for (let offset = 0; offset < 64 && values.length < spec.count; offset += 8) {
      const face = sampleWord(Number.parseInt(hex.slice(offset, offset + 8), 16), spec.sides);
      if (face !== null) values.push(face);
    }
  }
  if (values.length !== spec.count) throw new Error("Sampling exhausted; do not reroll");
  return { type: "dice", expression: spec.expression, values, modifier: spec.modifier,
    total: values.reduce((a, b) => a + b, spec.modifier) };
}

function deriveFastWheel(proof, seed, sha256Fn) {
  const wheel = proof.action.wheel;
  const parsed = parseWheelSpec([wheel.name, ...wheel.options.map(option => `${option.label}:${option.weight}`)].join(" | "));
  let ticket = null;
  for (let counter = 0; ticket === null && counter < 4096; counter++) {
    const hex = sha256Fn(JSON.stringify([FAST_PROTOCOL, "wheel", seed, counter]));
    for (let offset = 0; offset < 64 && ticket === null; offset += 8)
      ticket = sampleBelow(Number.parseInt(hex.slice(offset, offset + 8), 16), parsed.totalWeight);
  }
  if (ticket === null) throw new Error("Sampling exhausted; do not respin");
  let cursor = 0, selected = parsed.options[parsed.options.length - 1];
  for (const option of parsed.options) {
    cursor += option.weight;
    if (ticket < cursor) { selected = option; break; }
  }
  return { type: "wheel", name: parsed.name, version: wheel.version, outcome: selected.label,
    weight: selected.weight, totalWeight: parsed.totalWeight, ticket };
}

export function deriveFastResult(proof, sha256Fn) {
  const seed = fastSeed(proof, sha256Fn);
  return proof.action.type === "dice"
    ? deriveFastDice(proof, seed, sha256Fn)
    : deriveFastWheel(proof, seed, sha256Fn);
}

export function createFastProof(input, sha256Fn) {
  if (!/^[0-9a-f]{64}$/.test(input.requestId) || !Number.isSafeInteger(input.requestedAt))
    throw new Error("Invalid fast request");
  if (!/^[0-9a-f]{64}$/.test(input.nextCommitment)) throw new Error("Invalid next commitment");
  const commitment = secretCommitment(input.secret, input.sequence, sha256Fn);
  if (commitment !== input.commitment) throw new Error("Secret does not match published commitment");
  if (!input.action || !["dice", "wheel"].includes(input.action.type)) throw new Error("Invalid fast action");
  if (input.action.type === "dice") parseDice(input.action.expression);
  else wheelConfigHash(input.action.wheel, sha256Fn);
  const proof = {
    protocol: FAST_PROTOCOL,
    chainHash: CHAIN_HASH,
    requestId: input.requestId,
    requestedAt: input.requestedAt,
    sequence: input.sequence,
    commitment,
    secret: input.secret,
    nextCommitment: input.nextCommitment,
    commitmentAnnouncedAt: Number.isSafeInteger(input.commitmentAnnouncedAt) ? input.commitmentAnnouncedAt : null,
    precommittedBeforeRequest: Boolean(input.precommittedBeforeRequest),
    beacon: input.beacon ?? null,
    action: input.action,
  };
  return { ...proof, result: deriveFastResult(proof, sha256Fn) };
}

export function validateFastProof(proof, sha256Fn, verifyBeaconFn) {
  if (proof.protocol !== FAST_PROTOCOL || proof.chainHash !== CHAIN_HASH) throw new Error("Wrong fast protocol or chain");
  if (!/^[0-9a-f]{64}$/.test(proof.requestId) || !/^[0-9a-f]{64}$/.test(proof.nextCommitment))
    throw new Error("Malformed fast proof");
  if (secretCommitment(proof.secret, proof.sequence, sha256Fn) !== proof.commitment)
    throw new Error("Committed secret mismatch");
  if (proof.precommittedBeforeRequest && (!Number.isSafeInteger(proof.commitmentAnnouncedAt) ||
      proof.commitmentAnnouncedAt >= proof.requestedAt))
    throw new Error("Precommitment timing mismatch");
  if (proof.beacon && !verifyBeaconFn(proof.beacon, proof.beacon.round)) throw new Error("Invalid drand signature");
  const expected = deriveFastResult(proof, sha256Fn);
  if (JSON.stringify(expected) !== JSON.stringify(proof.result)) throw new Error("Result mismatch");
  return expected;
}
