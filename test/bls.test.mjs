import test from "node:test";
import assert from "node:assert/strict";
import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";

// Published RFC9380 fixture from drand/drand-client/test/beacon-verification.test.ts.
// This fixture uses a test network public key, never substituted into production.
test("G1 verification matches the independent drand RFC9380 fixture", () => {
  const signature = "95c93585c513ebbcb4777ff15599b3140e5ec0295faa0e483f3deadd88fa6d43f0d3703e3a4ce106e8fd6c6987f32126";
  const key = "81d320f220ee9c79e60e19dedc838c31e3ab919b15481e9feb52f643628c4f6a13fdc52129493875a818109d767272ca0541cbcdcea9335f2870d781b39b845ba8cbd44fdfe4967781cf72ca5917fc9398bcf97ca0548ed5a709016c4b1ff0f3";
  const options = { DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_" };
  const message = round => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(round), false);
    return sha256(bytes);
  };
  assert.equal(bls12_381.verifyShortSignature(signature, message(38), key, options), true);
  assert.equal(bls12_381.verifyShortSignature(signature, message(55), key, options), false);
});
