import test from "node:test";
import assert from "node:assert/strict";
import { parseDice, roundAtOrAfter, roundTime, GENESIS, planRound, sampleWord,
  createReceipt, deriveDice, validateProof } from "../src/core.mjs";
import { sha256Text, verifyBeacon } from "../src/beacon.mjs";

test("strict dice parsing rejects unsupported expressions and out-of-range dice", () => {
  assert.deepEqual(parseDice("2d6+3"), { count: 2, sides: 6, modifier: 3, expression: "2d6+3" });
  assert.equal(parseDice("D20-0").expression, "1d20");
  for (const bad of ["0d6", "101d6", "1d1", "1d1000001", "2d6+100001", "1d6;evil", "2d6+3 more", "1e2d6"])
    assert.throws(() => parseDice(bad));
});
test("round selection is fixed to the request time, including exact boundaries", () => {
  assert.equal(roundAtOrAfter(GENESIS), 1);
  assert.equal(roundAtOrAfter(GENESIS + 1), 2);
  assert.equal(roundAtOrAfter(GENESIS + 3), 2);
  for (let offset = 0; offset < 300; offset++) {
    const timestamp = GENESIS + 10000 + offset;
    const plan = planRound(timestamp);
    assert.ok(plan.targetTime >= timestamp + 60);
    assert.ok(plan.targetTime < timestamp + 63);
    assert.equal(plan.targetTime, roundTime(plan.round));
    assert.equal(plan.deadline, plan.targetTime - 5);
  }
});
test("rejection sampling discards the biased tail instead of mapping it to faces", () => {
  assert.equal(sampleWord(4294967291, 6), 6);
  for (let word = 4294967292; word < 4294967296; word++)
    assert.equal(sampleWord(word, 6), null);
  assert.equal(sampleWord(0, 6), 1);
  assert.equal(sampleWord(4294967295, 256), 256);
  assert.throws(() => sampleWord(-1, 6));
});
test("commitments bind request identity, time, and expression", () => {
  const id = "a".repeat(64), date = GENESIS + 10000;
  const base = createReceipt(id, date, "2d6+3", sha256Text);
  assert.equal(createReceipt(id, date, "2D6+3", sha256Text).commitment, base.commitment);
  for (const changed of [
    createReceipt("b".repeat(64), date, "2d6+3", sha256Text),
    createReceipt(id, date + 1, "2d6+3", sha256Text),
    createReceipt(id, date, "2d20+3", sha256Text),
  ]) assert.notEqual(changed.commitment, base.commitment);
});
test("counter expansion consumes new blocks after rejection and never silently rerolls", () => {
  const receipt = createReceipt("a".repeat(64), GENESIS + 10000, "10d6-3", sha256Text);
  let calls = 0;
  const result = deriveDice(receipt, "0".repeat(64), () => ++calls === 1 ? "f".repeat(64) : "0".repeat(64));
  assert.equal(calls, 3);
  assert.deepEqual(result.values, Array(10).fill(1));
  assert.equal(result.total, 7);
  assert.throws(() => deriveDice(receipt, "0".repeat(64), () => "f".repeat(64)), /exhausted/);
});
test("proof validation rejects late publication and forged results", () => {
  const receipt = createReceipt("a".repeat(64), GENESIS + 10000, "2d6+3", sha256Text);
  const randomness = "0".repeat(64);
  const proof = { receipt, announcedAt: receipt.requestedAt + 1,
    beacon: { round: receipt.round, randomness, signature: "test-double" },
    result: deriveDice(receipt, randomness, sha256Text) };
  // Signature acceptance is isolated here; the real BLS implementation has its own fixture.
  assert.deepEqual(validateProof(proof, sha256Text, () => true), proof.result);
  assert.throws(() => validateProof({ ...proof, announcedAt: roundTime(receipt.round) }, sha256Text, () => true));
  assert.throws(() => validateProof({ ...proof, result: { ...proof.result, total: 999 } }, sha256Text, () => true));
  assert.throws(() => validateProof(proof, sha256Text, () => false));
  assert.deepEqual(deriveDice(receipt, randomness, sha256Text), proof.result);
});
test("production quicknet verifier fails closed on malformed or unsigned beacons", () => {
  assert.equal(verifyBeacon({ round: 1, signature: "00", randomness: "0".repeat(64) }, 1), false);
  assert.equal(verifyBeacon({ round: 2, signature: "0".repeat(96), randomness: "0".repeat(64) }, 1), false);
});
