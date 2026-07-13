import { JitCheckout } from "../../../packages/client/dist/index.js";
import { startMerchantServer } from "../shared/merchant-server.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
await startMerchantServer(cfg, ({ rpc, lsp, merchantPubkey, merchantAddress }) => new JitCheckout({
  rpc,
  lsp,
  merchantPubkey,
  merchantAddress,
  mode: "same_hash",
}));
