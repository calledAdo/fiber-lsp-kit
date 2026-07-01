/**
 * node:http server that mounts the LSPS-Fiber REST API beside a running FNN node.
 *
 * Env:
 *   PORT            (default 8080)
 *   FIBER_RPC_URL   (default http://127.0.0.1:8227) — the LSP's own FNN node
 *   LSP_PUBKEY, LSP_ADDR — announced identity (falls back to node_info at startup)
 *
 * The offering (assets, capacities, fee schedule) is configured in makeDefaultLsp() below; edit it to
 * match your node's liquidity. This entrypoint is deliberately thin — all logic lives in Lsp/api.
 */
import { createServer } from "node:http";
import { FiberChannelRpcClient, udtAsset, CKB, type AssetOffering } from "@fiberlsp/protocol";
import { Lsp } from "./lsp.js";
import { createApi } from "./api.js";

const PORT = Number(process.env.PORT ?? 8080);
const FIBER_RPC_URL = process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";

// RUSD on CKB testnet (the same token RouteKit validated against).
const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const CKB_SHANNONS = 100_000_000n;

function defaultOfferings(): AssetOffering[] {
  return [
    {
      asset: CKB,
      min_capacity: (100n * CKB_SHANNONS).toString(),
      max_capacity: (100_000n * CKB_SHANNONS).toString(),
      fee_schedule: { base_fee: (10n * CKB_SHANNONS).toString(), proportional_bps: 100 }, // 10 CKB + 1%
    },
    {
      asset: RUSD,
      min_capacity: "1000000", // depends on RUSD decimals; tune per token
      max_capacity: "100000000000",
      fee_schedule: { base_fee: (10n * CKB_SHANNONS).toString(), proportional_bps: 0 }, // flat 10 CKB
    },
  ];
}

async function main() {
  const rpc = new FiberChannelRpcClient({ rpcUrl: FIBER_RPC_URL });

  let lspPubkey = process.env.LSP_PUBKEY ?? "";
  let addresses = process.env.LSP_ADDR ? [process.env.LSP_ADDR] : [];
  try {
    const info = await rpc.nodeInfo();
    lspPubkey ||= info.node_id ?? info.public_key ?? "";
    if (addresses.length === 0 && info.addresses) addresses = info.addresses;
  } catch {
    console.warn(`[lsp] could not reach FNN at ${FIBER_RPC_URL}; identity will be from env only`);
  }

  const lsp = new Lsp({
    rpc,
    lspPubkey,
    addresses,
    supportedAssets: defaultOfferings(),
    feeModes: ["prepaid", "from_capacity"],
    operator: "fiber-lsp-kit reference server",
  });
  const handle = createApi(lsp);

  const server = createServer((reqMsg, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (reqMsg.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    reqMsg.on("data", (c) => chunks.push(c as Buffer));
    reqMsg.on("end", async () => {
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "bad_json", message: "invalid JSON body" } }));
          return;
        }
      }
      const url = reqMsg.url ?? "/";
      const path = url.split("?")[0] ?? "/";
      const { status, body: out } = await handle(reqMsg.method ?? "GET", path, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });

  server.listen(PORT, () => {
    console.log(`[lsp] LSPS-Fiber server on http://127.0.0.1:${PORT}  (FNN: ${FIBER_RPC_URL})`);
    console.log(`[lsp] pubkey: ${lspPubkey || "(unknown)"}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
