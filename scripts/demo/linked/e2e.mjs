import { readFileSync } from "node:fs";

import { JitCheckout } from "../../../packages/client/dist/index.js";
import { Lsp, JitService, createApi } from "../../../packages/lsp-server/dist/index.js";
import {
  createGroth16DualSha256Verifier,
  verifyGroth16Bn254,
} from "../../../packages/protocol/dist/index.js";
import { makeLinkedProver } from "../../../packages/prover-linked/dist/index.js";
import { ensureArtifacts } from "../shared/artifacts.mjs";
import {
  apiLspClient,
  demoJitTerms,
  demoOffering,
  runJitSale,
  runRegularSale,
  runRentPeriods,
} from "../shared/e2e-flow.mjs";
import { createWorld, makeNode, mockPreimageSource, mockRpcClient, seedCustomerHoldChannel } from "../shared/mock-node.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const lspArtifacts = await ensureArtifacts("lsp", cfg);
const merchantArtifacts = await ensureArtifacts("merchant", cfg);
const verificationKey = JSON.parse(readFileSync(lspArtifacts.vk, "utf8"));
const verifier = createGroth16DualSha256Verifier({
  verificationKey,
  verifyGroth16: (key, input, proof) => verifyGroth16Bn254(key, input, proof),
});
const prover = makeLinkedProver({ zkeyPath: merchantArtifacts.zkey, wasmPath: merchantArtifacts.wasm });

const world = createWorld();
const nodes = {
  lsp: makeNode(world, "lsp", 9127),
  merchant: makeNode(world, "merchant", 9147),
  customer: makeNode(world, "customer", 9137),
};
seedCustomerHoldChannel({
  world,
  customerRole: "customer",
  holdRole: "lsp",
  amount: cfg.e2eFixtures.customerHoldCapacity,
  assetScript: cfg.assetScript,
});
const rpc = Object.fromEntries(Object.entries(nodes).map(([role, node]) => [role, mockRpcClient(node)]));
const offering = demoOffering(cfg);
const terms = demoJitTerms(cfg);
const lsp = new Lsp({
  rpc: rpc.lsp,
  lspPubkey: nodes.lsp.pubkey,
  addresses: [],
  supportedAssets: [offering],
  feeModes: ["prepaid"],
});
const jit = new JitService({
  rpc: rpc.lsp,
  preimageSource: mockPreimageSource(nodes.lsp),
  linkageVerifier: verifier,
  terms,
  supportedAssets: [offering],
  minCapacity: cfg.jit.minCapacity,
  pollIntervalMs: 0,
  readyPollAttempts: 20,
  sleep: async () => {},
});
const lspClient = apiLspClient(createApi(lsp, { jit }));
const checkout = new JitCheckout({
  rpc: rpc.merchant,
  lsp: lspClient,
  merchantPubkey: nodes.merchant.pubkey,
  merchantAddress: `/ip4/127.0.0.1/tcp/${nodes.merchant.port}`,
  mode: "linked",
  proveLinkage: (holdHash, merchantPaymentHash, secret) => prover(holdHash, merchantPaymentHash, secret),
});

console.log("Linked JIT E2E (three nodes, Groth16 linkage)");
const flow = await runJitSale({ cfg, terms, checkout, customerRpc: rpc.customer, merchantRpc: rpc.merchant });
await runRegularSale({ cfg, customerRpc: rpc.customer, merchantRpc: rpc.merchant });
await runRentPeriods({ cfg, lease: flow.lease });
console.log("PASS: linked JIT checkout, repeat routed payment, and channel-bound live-capacity rent");
