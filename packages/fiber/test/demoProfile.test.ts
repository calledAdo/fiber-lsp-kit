import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCompleteProfile } from "../../../scripts/demo/shared/config.mjs";

const required = ["hold.rpc", "payment.rpc", "merchant.rpc", "merchant.p2p", "customer.rpc"];
const mockNodes = {
  hold: { rpc: "http://127.0.0.1:9227", port: 9227 },
  payment: { rpc: "http://127.0.0.1:9327", port: 9327 },
  merchant: { rpc: "http://127.0.0.1:9247", p2p: "/ip4/127.0.0.1/tcp/9247", port: 9247 },
  customer: { rpc: "http://127.0.0.1:9237", port: 9237 },
};

function liveNodes() {
  return {
    hold: { rpc: "http://hold" },
    payment: { rpc: "http://payment" },
    merchant: { rpc: "http://merchant", p2p: "/ip4/merchant/tcp/8228" },
    customer: { rpc: "http://customer" },
  };
}

test("complete configured nodes resolve to one live profile", () => {
  const configuredNodes = liveNodes();
  const result = resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields: required });

  assert.equal(result.profile, "live");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.nodes, configuredNodes);
  assert.notEqual(result.nodes, configuredNodes, "the resolver must not return mutable config input");
});

test("one missing field discards every supplied live endpoint", () => {
  const configuredNodes = liveNodes();
  configuredNodes.payment.rpc = "";
  const result = resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields: required });

  assert.equal(result.profile, "mock");
  assert.deepEqual(result.missing, ["payment.rpc"]);
  assert.deepEqual(result.nodes, mockNodes);
  assert.notEqual(result.nodes.hold.rpc, configuredNodes.hold.rpc);
  assert.notEqual(result.nodes.merchant.rpc, configuredNodes.merchant.rpc);
});

test("the resolver reports every missing field in definition order", () => {
  const configuredNodes = liveNodes();
  configuredNodes.hold.rpc = "  ";
  configuredNodes.merchant.p2p = "";
  configuredNodes.customer.rpc = "";

  const result = resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields: required });
  assert.deepEqual(result.missing, ["hold.rpc", "merchant.p2p", "customer.rpc"]);
  assert.equal(result.profile, "mock");
});

test("resolved profiles are deep clones and cannot mutate either source", () => {
  const configuredNodes = liveNodes();
  const live = resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields: required });
  live.nodes.hold.rpc = "changed";
  assert.equal(configuredNodes.hold.rpc, "http://hold");

  configuredNodes.payment.rpc = "";
  const mock = resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields: required });
  mock.nodes.hold.rpc = "changed";
  assert.equal(mockNodes.hold.rpc, "http://127.0.0.1:9227");
});
