import assert from "node:assert/strict";
import test from "node:test";

import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { MemoryChallengeStore, SignedFiberInvoiceVerifier } from "../src/index.js";

const PUBKEY = "0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283";
const NOW = 1_750_000_000_000;

function verifierFixture(overrides: {
  currency?: string;
  signature?: string;
  payee?: string;
  description?: string;
  timestamp?: string;
  expiry?: string;
  challengeTtlMs?: number;
} = {}) {
  let challengeNow = NOW;
  const challenges = new MemoryChallengeStore({
    now: () => challengeNow,
    ttlMs: overrides.challengeTtlMs,
  });
  let challenge = "";
  const fetchImpl: FetchLike = async (_url, init) => {
    const { id, method } = JSON.parse(String(init.body));
    assert.equal(method, "parse_invoice");
    return {
      json: async () => ({
        jsonrpc: "2.0",
        id,
        result: {
          invoice: {
            currency: overrides.currency ?? "Fibt",
            signature: overrides.signature === undefined ? "010203" : overrides.signature,
            data: {
              timestamp: overrides.timestamp ?? `0x${NOW.toString(16)}`,
              payment_hash: "0xhash",
              attrs: [
                { payee_public_key: overrides.payee ?? PUBKEY },
                { description: overrides.description ?? challenge },
                { expiry_time: overrides.expiry ?? "0x258" },
              ],
            },
          },
        },
      }),
    };
  };
  const verifier = new SignedFiberInvoiceVerifier({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl }),
    challenges,
    expectedCurrency: "Fibt",
    now: () => NOW,
  });
  return {
    challenges,
    verifier,
    setChallenge(value: string) {
      challenge = value;
    },
    setChallengeNow(value: number) {
      challengeNow = value;
    },
  };
}

async function liveProof(fixture: ReturnType<typeof verifierFixture>) {
  const challenge = await fixture.challenges.issue(PUBKEY);
  fixture.setChallenge(challenge);
  return { invoice: "fibt1proof", pubkey: PUBKEY };
}

test("SignedFiberInvoiceVerifier accepts a live signed challenge once", async () => {
  const fixture = verifierFixture();
  const proof = await liveProof(fixture);

  assert.deepEqual(await fixture.verifier.verify(proof), { pubkey: PUBKEY, verifiedAt: NOW });
  await assert.rejects(() => fixture.verifier.verify(proof), /challenge/i);
});

test("SignedFiberInvoiceVerifier rejects a payee that differs from the claimed pubkey", async () => {
  const fixture = verifierFixture({ payee: "02bb" });
  const proof = await liveProof(fixture);
  await assert.rejects(() => fixture.verifier.verify(proof), /payee/i);
});

test("SignedFiberInvoiceVerifier rejects unknown, missing-signature, expired, and wrong-network proofs", async (t) => {
  await t.test("unknown challenge", async () => {
    const fixture = verifierFixture({ description: "not-issued" });
    await assert.rejects(() => fixture.verifier.verify({ invoice: "fibt1proof", pubkey: PUBKEY }), /challenge/i);
  });
  await t.test("stale challenge", async () => {
    const fixture = verifierFixture({ challengeTtlMs: 50 });
    const proof = await liveProof(fixture);
    fixture.setChallengeNow(NOW + 51);
    await assert.rejects(() => fixture.verifier.verify(proof), /challenge/i);
  });
  await t.test("missing signature", async () => {
    const fixture = verifierFixture({ signature: "" });
    const proof = await liveProof(fixture);
    await assert.rejects(() => fixture.verifier.verify(proof), /signature/i);
  });
  await t.test("expired invoice", async () => {
    const fixture = verifierFixture({ timestamp: `0x${(NOW - 61_000).toString(16)}`, expiry: "0x3c" });
    const proof = await liveProof(fixture);
    await assert.rejects(() => fixture.verifier.verify(proof), /expired/i);
  });
  await t.test("wrong currency", async () => {
    const fixture = verifierFixture({ currency: "Fibb" });
    const proof = await liveProof(fixture);
    await assert.rejects(() => fixture.verifier.verify(proof), /currency/i);
  });
});

test("SignedFiberInvoiceVerifier rejects malformed proof values", async () => {
  const fixture = verifierFixture();
  await assert.rejects(() => fixture.verifier.verify({}), /proof/i);
  await assert.rejects(() => fixture.verifier.verify(null), /proof/i);
});
