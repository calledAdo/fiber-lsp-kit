import assert from "node:assert/strict";

import { JitCheckout } from "../../../packages/client/dist/index.js";
import { Lsp, JitService, createApi } from "../../../packages/lsp-server/dist/index.js";
import { apiLspClient, demoJitTerms, demoOffering, runJitSale, runRentPeriods } from "../shared/e2e-flow.mjs";
import { createWorld, makeNode, mockRpcClient, seedCustomerHoldChannel } from "../shared/mock-node.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const world = createWorld();
const nodes = {
  hold: makeNode(world, "hold", 9227),
  payment: makeNode(world, "payment", 9327),
  merchant: makeNode(world, "merchant", 9247),
  customer: makeNode(world, "customer", 9237),
};
seedCustomerHoldChannel({
  world,
  customerRole: "customer",
  holdRole: "hold",
  amount: cfg.amounts.customerHoldCapacity,
  assetScript: cfg.assetScript,
});
const rpc = Object.fromEntries(Object.entries(nodes).map(([role, node]) => [role, mockRpcClient(node)]));
const offering = demoOffering(cfg);
const terms = demoJitTerms(cfg);
const lsp = new Lsp({
  rpc: rpc.hold,
  lspPubkey: nodes.hold.pubkey,
  addresses: [],
  supportedAssets: [offering],
  feeModes: ["prepaid"],
});
const jit = new JitService({
  rpc: rpc.hold,
  payRpc: rpc.payment,
  terms,
  supportedAssets: [offering],
  minCapacity: cfg.jit.minCapacity,
  pollIntervalMs: 0,
  readyPollAttempts: 20,
  sleep: async () => {},
});
const lspClient = apiLspClient(createApi(lsp, { jit }));
const merchantAddress = cfg.peerAddress("merchant", nodes.merchant.pubkey);
const checkout = new JitCheckout({
  rpc: rpc.merchant,
  lsp: lspClient,
  merchantPubkey: nodes.merchant.pubkey,
  merchantAddress,
  mode: "same_hash",
});

console.log("Same-hash JIT E2E (four nodes)");
const flow = await runJitSale({ cfg, terms, checkout, customerRpc: rpc.customer, merchantRpc: rpc.merchant });
assert.equal(nodes.hold.channels.some((channel) => channel.pubkey === nodes.payment.pubkey), false);
assert.equal(nodes.payment.channels.some((channel) => channel.pubkey === nodes.merchant.pubkey), true);
console.log("  ok  hold and payment nodes coordinate without a channel between them");
await runRentPeriods({ cfg, lease: flow.lease });
console.log("PASS: same-hash four-node JIT and live-capacity rent");
