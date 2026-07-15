import { JitCheckout } from "../../../packages/client/dist/index.js";
import { makeLinkedProver } from "../../../packages/prover-linked/dist/index.js";
import { ensureArtifacts } from "../shared/artifacts.mjs";
import { demoConsole } from "../shared/console.mjs";
import { startMerchantServer } from "../shared/merchant-server.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const artifacts = await ensureArtifacts("merchant", cfg);
const prover = makeLinkedProver({ zkeyPath: artifacts.zkey, wasmPath: artifacts.wasm });
await startMerchantServer(cfg, ({ rpc, lsp, merchantPubkey, merchantAddress }) => new JitCheckout({
  rpc,
  lsp,
  merchantPubkey,
  merchantAddress,
  mode: "linked",
  proveLinkage: async (holdHash, merchantPaymentHash, secret) => {
    const started = Date.now();
    const proof = await prover(holdHash, merchantPaymentHash, secret);
    demoConsole.ok("Linkage proof built", `${((Date.now() - started) / 1000).toFixed(1)}s`);
    return proof;
  },
}));
