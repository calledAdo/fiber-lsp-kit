/**
 * node:http server that mounts the LSPS-Fiber REST API beside a running FNN node.
 *
 * Env:
 *   PORT            (default 8080)
 *   FIBER_RPC_URL   (default http://127.0.0.1:8227) — the LSP's own FNN node
 *   LSP_PUBKEY, LSP_ADDR — announced identity (falls back to node_info at startup)
 *
 *   MERCHANT_FIBER_RPC_URL — a merchant's own FNN node. When set, the server also mounts the merchant
 *                            invoice-webhook API (`/merchant/v1/*`), issuing/watching invoices on THAT
 *                            node and POSTing `invoice.*` webhooks on settlement. Unset ⇒ API disabled.
 *   WATCH_STORE_PATH        — persist invoice watches (survives restart); unset ⇒ in-memory.
 *   WATCH_POLL_ATTEMPTS / WATCH_POLL_INTERVAL_MS — per-watch settlement poll budget.
 *
 *   LINKED_JIT_VK_PATH — Groth16 verification key for single-node linked JIT. When set, JIT channels are
 *                        offered at `/lsp/v1/jit/*`.
 *   JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 — test-only linked proof mode that reveals the merchant secret.
 *   JIT_STORE_PATH    — persist JIT orders + revealed preimages (survives restart); unset ⇒ in-memory.
 *   JIT_FEE_BPS / JIT_FEE_BASE / JIT_MIN_PAYMENT / JIT_MAX_EXPIRY — pricing (defaults below).
 *
 * The offering (assets, capacities, fee schedule) is configured in makeDefaultLsp() below; edit it to
 * match your node's liquidity. This entrypoint is deliberately thin — all logic lives in Lsp/api.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { FiberChannelRpcClient, udtAsset, CKB, type AssetOffering } from "@fiberlsp/protocol";
import { Lsp, makeInvoiceFeeVerifier } from "./lsp.js";
import { createApi } from "./api.js";
import { FileOrderStore } from "./orderStore.js";
import { InvoiceWebhookService } from "./invoiceWebhooks.js";
import { createMerchantApi } from "./merchantApi.js";
import { FileWatchStore } from "./watchStore.js";
import { JitService } from "./jit.js";
import { FileJitStore } from "./jitStore.js";
import {
  compositeLinkageVerifier,
  createGroth16DualSha256Verifier,
  exposedSecretVerifier,
} from "@fiberlsp/protocol";

const PORT = Number(process.env.PORT ?? 8080);
const FIBER_RPC_URL = process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";

// RUSD on CKB testnet (Fiber's reference stablecoin UDT).
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
      // min_capacity must be >= the CLIENT node's UDT auto_accept_amount floor, or its FNN node will
      // silently refuse to auto-accept the channel (verified live: is_udt_type_auto_accept requires
      // funding_amount >= auto_accept_amount). Testnet RUSD auto_accept_amount is 10 RUSD (1e9, 8 decimals).
      min_capacity: "1000000000", // 10 RUSD
      max_capacity: "100000000000",
      // Activation fee (CKB, one-time): opens the channel + covers the first-period runway.
      fee_schedule: { base_fee: (10n * CKB_SHANNONS).toString(), proportional_bps: 0 }, // flat 10 CKB
      // Streaming lease is the default for RUSD: after activation, rent streams in RUSD out of revenue.
      stream: { rate_bps_per_period: 5, period_seconds: 86_400, grace_periods: 2 }, // 0.05%/day, 2-day grace
    },
  ];
}

async function main() {
  const rpc = new FiberChannelRpcClient({ rpcUrl: FIBER_RPC_URL });

  let lspPubkey = process.env.LSP_PUBKEY ?? "";
  let addresses = process.env.LSP_ADDR ? [process.env.LSP_ADDR] : [];
  try {
    const info = await rpc.nodeInfo();
    lspPubkey ||= info.pubkey ?? info.node_id ?? info.public_key ?? "";
    if (addresses.length === 0 && info.addresses) addresses = info.addresses;
  } catch {
    console.warn(`[lsp] could not reach FNN at ${FIBER_RPC_URL}; identity will be from env only`);
  }

  // ORDER_STORE_PATH persists orders across restarts; unset ⇒ in-memory (default).
  const store = process.env.ORDER_STORE_PATH
    ? new FileOrderStore(process.env.ORDER_STORE_PATH)
    : undefined;

  // By default a prepaid order is only provisioned once its CKB fee invoice actually settled
  // (get_invoice → "Paid"). LSP_TRUST_SETTLE=1 bypasses this for the zero-capital flagship flow, whose
  // client has no Fiber outbound and pays the fee out-of-band in CKB (see spec §4).
  const trustSettle = process.env.LSP_TRUST_SETTLE === "1";

  const lsp = new Lsp({
    rpc,
    lspPubkey,
    addresses,
    supportedAssets: defaultOfferings(),
    feeModes: ["prepaid", "from_capacity"],
    operator: "fiber-lsp-kit reference server",
    ...(store ? { store } : {}),
    ...(trustSettle ? {} : { verifyFeePaid: makeInvoiceFeeVerifier(rpc) }),
    // On-chain funding confirmation can take a while on testnet; allow tuning the ready-poll window.
    ...(process.env.READY_POLL_ATTEMPTS ? { readyPollAttempts: Number(process.env.READY_POLL_ATTEMPTS) } : {}),
    ...(process.env.READY_POLL_INTERVAL_MS ? { readyPollIntervalMs: Number(process.env.READY_POLL_INTERVAL_MS) } : {}),
  });
  let jit: JitService | undefined;
  const verifiers = [];
  const vkPath = process.env.LINKED_JIT_VK_PATH;
  if (vkPath) {
    try {
      const vk = JSON.parse(readFileSync(vkPath, "utf8"));
      const snarkjs = (await import("snarkjs" as string)) as {
        groth16: { verify: (vk: unknown, pub: string[], proof: unknown) => Promise<boolean> };
      };
      verifiers.push(
        createGroth16DualSha256Verifier({
          verificationKey: vk,
          verifyGroth16: (v, pub, proof) => snarkjs.groth16.verify(v, pub, proof),
        }),
      );
    } catch (e) {
      console.warn(`[jit] could not load Groth16 vk from ${vkPath}: ${e}`);
    }
  }
  if (process.env.JIT_ALLOW_UNSAFE_EXPOSED_SECRET === "1") {
    console.warn("[jit] enabling unsafe exposed-secret linkage verifier; use only for local tests");
    verifiers.push(exposedSecretVerifier);
  }
  if (verifiers.length > 0) {
    jit = new JitService({
      rpc,
      terms: {
        fee_bps: Number(process.env.JIT_FEE_BPS ?? 100), // 1% of the payment, deducted from the forward
        fee_base: process.env.JIT_FEE_BASE ?? "0",
        min_payment: process.env.JIT_MIN_PAYMENT ?? "10000000", // 0.1 RUSD
        max_expiry_seconds: Number(process.env.JIT_MAX_EXPIRY ?? 3600),
      },
      supportedAssets: defaultOfferings(),
      linkageVerifier: compositeLinkageVerifier(verifiers),
      // Match the RUSD offering's min_capacity: an acceptor auto-accepts UDT channels only at/above its
      // auto_accept_amount (10 RUSD on testnet), so small JIT payments still open a 10-RUSD channel.
      minCapacity: process.env.JIT_MIN_CAPACITY ?? "1000000000",
      ...(process.env.JIT_STORE_PATH ? { store: new FileJitStore(process.env.JIT_STORE_PATH) } : {}),
      ...(process.env.READY_POLL_ATTEMPTS ? { readyPollAttempts: Number(process.env.READY_POLL_ATTEMPTS) } : {}),
      // The ready-poll budget is attempts × interval. FNN retries a failed funding tx for many minutes on
      // its own, so give the JIT open the same generous window as the purchase flow (default would be 2 s).
      ...(process.env.READY_POLL_INTERVAL_MS ? { pollIntervalMs: Number(process.env.READY_POLL_INTERVAL_MS) } : {}),
    });
  } else {
    console.warn("[jit] disabled: set LINKED_JIT_VK_PATH or JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1");
  }
  const handle = createApi(lsp, { ...(jit ? { jit } : {}) });

  // Optional merchant invoice-webhook API, mounted only when a merchant node is configured. It watches
  // that node's invoices (which may be a different node than the LSP's) and POSTs invoice.* webhooks.
  const merchantRpcUrl = process.env.MERCHANT_FIBER_RPC_URL;
  let merchantHandle: ReturnType<typeof createMerchantApi> | undefined;
  if (merchantRpcUrl) {
    const merchant = new InvoiceWebhookService({
      rpc: new FiberChannelRpcClient({ rpcUrl: merchantRpcUrl }),
      ...(process.env.WATCH_STORE_PATH ? { store: new FileWatchStore(process.env.WATCH_STORE_PATH) } : {}),
      ...(process.env.WATCH_POLL_ATTEMPTS ? { pollAttempts: Number(process.env.WATCH_POLL_ATTEMPTS) } : {}),
      ...(process.env.WATCH_POLL_INTERVAL_MS ? { pollIntervalMs: Number(process.env.WATCH_POLL_INTERVAL_MS) } : {}),
    });
    merchant.resume(); // re-attach any watches left pending by a previous run
    merchantHandle = createMerchantApi(merchant);
  }

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
      const method = reqMsg.method ?? "GET";
      const route =
        merchantHandle && path.startsWith("/merchant/") ? merchantHandle : handle;
      const { status, body: out } = await route(method, path, body, reqMsg.headers);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });

  server.listen(PORT, () => {
    console.log(`[lsp] LSPS-Fiber server on http://127.0.0.1:${PORT}  (FNN: ${FIBER_RPC_URL})`);
    console.log(`[lsp] pubkey: ${lspPubkey || "(unknown)"}`);
    if (merchantHandle) {
      console.log(`[merchant] invoice-webhook API on /merchant/v1/*  (FNN: ${merchantRpcUrl})`);
    }
    if (jit) {
      console.log(`[jit] single-node JIT on /lsp/v1/jit/*  (node: ${FIBER_RPC_URL})`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
