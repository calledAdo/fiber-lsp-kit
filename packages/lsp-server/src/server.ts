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
 *   JIT is offered at `/lsp/v1/jit/*` as soon as either mode below is available. Both can run side by side;
 *   the merchant picks per order and the LSP advertises what it serves in `LspInfo.jit.modes`.
 *
 *   `linked`    (one node, merchant proves)
 *   LINKED_JIT_VK_PATH — Groth16 verification key. Set it to serve `linked`.
 *   JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 — test-only linked proof mode that reveals the merchant secret.
 *                        Startup fails if this is set together with LINKED_JIT_VK_PATH (no silent downgrade).
 *
 *   `same_hash` (two nodes, no proof)
 *   JIT_PAY_FIBER_RPC_URL — a SECOND FNN node the LSP controls, which opens the JIT channel and pays the
 *                        merchant leg while FIBER_RPC_URL holds the customer payment. It needs on-chain funds
 *                        (it is the channel funder) and nothing else. Because the hold and the payment live on
 *                        different nodes, both legs can carry the same hash: no proving key, no circuit, no
 *                        ceremony. Startup refuses if it resolves to the same node as FIBER_RPC_URL.
 *
 *   JIT_STORE_PATH    — persist JIT orders + revealed preimages (survives restart); unset ⇒ in-memory.
 *   JIT_FEE_BPS / JIT_FEE_BASE / JIT_MIN_PAYMENT / JIT_MAX_EXPIRY — pricing (defaults below).
 *
 * The offering (assets, capacities, fee schedule) is configured in makeDefaultLsp() below; edit it to
 * match your node's liquidity. This entrypoint is deliberately thin — it just constructs the service bricks
 * (Lsp identity/liquidity, PrepaidService, JitService, InvoiceWebhookService) and lets createApi compose them.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { udtAsset, CKB, type AssetOffering, type LinkageVerifier } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { Lsp } from "./lsp.js";
import { PrepaidService, makeInvoiceFeeVerifier } from "./prepaid.js";
import { createApi } from "./api.js";
import { FileOrderStore } from "./orderStore.js";
import { InvoiceWebhookService } from "./invoiceWebhooks.js";
import { createMerchantApi } from "./merchantApi.js";
import { FileWatchStore } from "./watchStore.js";
import { JitService } from "./jit.js";
import { FileJitStore } from "./jitStore.js";
import { selectLinkageVerifiers } from "./linkageConfig.js";
import {
  compositeLinkageVerifier,
  createGroth16DualSha256Verifier,
  exposedSecretVerifier,
  verifyGroth16Bn254,
  type Groth16Proof,
  type Groth16VerificationKey,
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

/** The operator's view of a JIT order, line by line — enabled with JIT_LOG=1. */
function logJitEvent({ event, order }: { event: string; order: { jit_order_id: string; request: { mode?: string }; channel_outpoint?: string; failure_reason?: string } }): void {
  if (event === "payment_held") return; // the "opening" line already reports the hold; avoid a duplicate
  const id = order.jit_order_id.slice(0, 8);
  const line =
    event === "created"
      ? order.request.mode === "linked"
        ? `linkage proof VERIFIED ✓ — accepted (linked, secret never revealed)`
        : `accepted (same_hash — two nodes, no proof)`
      : event === "opening"
        ? `customer payment held → opening a channel to the merchant…`
        : event === "forwarding"
          ? `channel open (${order.channel_outpoint ?? "?"}) → forwarding the merchant leg…`
          : event === "settled"
            ? `SETTLED ✓ — merchant paid, then the customer's hold released`
            : event === "refunded"
              ? `refunded — ${order.failure_reason ?? ""}`
              : event;
  console.log(`[jit] ${id}… ${line}`);
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
  // (get_invoice → "Paid"). LSP_TRUST_SETTLE=1 bypasses that check entirely.
  //
  // Note the prepaid purchase path is trusted by construction either way: nothing atomically links the
  // client's fee payment to the LSP actually opening a channel, so verifying the fee only proves the client
  // paid — it gives the client no recourse. JIT is the default precisely because it has no such gap. Prepaid
  // stays available for a client that wants inbound provisioned ahead of any customer.
  const trustSettle = process.env.LSP_TRUST_SETTLE === "1";
  if (trustSettle) {
    console.warn(
      "[lsp] WARNING: LSP_TRUST_SETTLE=1 — provisioning without verifying the fee actually settled. The " +
        "prepaid path already asks the client to pay before the channel exists; this removes even the fee " +
        "check. Use it only for local demos.",
    );
  }

  const lsp = new Lsp({
    rpc,
    lspPubkey,
    addresses,
    supportedAssets: defaultOfferings(),
    feeModes: ["prepaid", "from_capacity"],
    operator: "fiber-lsp-kit reference server",
  });
  const prepaid = new PrepaidService({
    rpc,
    lspPubkey,
    supportedAssets: defaultOfferings(),
    feeModes: ["prepaid", "from_capacity"],
    ...(store ? { store } : {}),
    ...(trustSettle ? {} : { verifyFeePaid: makeInvoiceFeeVerifier(rpc) }),
    // On-chain funding confirmation can take a while on testnet; allow tuning the ready-poll window.
    ...(process.env.READY_POLL_ATTEMPTS ? { readyPollAttempts: Number(process.env.READY_POLL_ATTEMPTS) } : {}),
    ...(process.env.READY_POLL_INTERVAL_MS ? { readyPollIntervalMs: Number(process.env.READY_POLL_INTERVAL_MS) } : {}),
  });
  let jit: JitService | undefined;
  // Resolve the Groth16 verifier (all IO here); the pure selectLinkageVerifiers() decides what actually runs.
  let groth16: LinkageVerifier | undefined;
  const vkPath = process.env.LINKED_JIT_VK_PATH;
  if (vkPath) {
    try {
      const vk = JSON.parse(readFileSync(vkPath, "utf8"));
      groth16 = createGroth16DualSha256Verifier({
        verificationKey: vk,
        verifyGroth16: (v, pub, proof) =>
          verifyGroth16Bn254(v as Groth16VerificationKey, pub, proof as Groth16Proof),
      });
    } catch (e) {
      console.warn(`[jit] could not load Groth16 vk from ${vkPath}: ${e}`);
    }
  }
  const verifiers = selectLinkageVerifiers({
    groth16,
    allowExposedSecret: process.env.JIT_ALLOW_UNSAFE_EXPOSED_SECRET === "1",
    exposedSecret: exposedSecretVerifier,
  });

  // The second node enables `same_hash`. Prove it really is a second node before trusting the mode: if both
  // URLs resolve to one FNN process, that node would be asked to hold and pay the same hash — exactly the
  // collision `same_hash` claims to have escaped — and the JIT flow would strand a held customer payment.
  const payRpcUrl = process.env.JIT_PAY_FIBER_RPC_URL;
  let payRpc: FiberChannelRpcClient | undefined;
  if (payRpcUrl) {
    const candidate = new FiberChannelRpcClient({ rpcUrl: payRpcUrl });
    const payInfo = await candidate.nodeInfo();
    const payId = payInfo.node_id ?? payInfo.pubkey ?? payInfo.public_key ?? "";
    if (!payId) throw new Error(`[jit] JIT_PAY_FIBER_RPC_URL (${payRpcUrl}) returned no node identity`);
    if (lspPubkey && payId.toLowerCase() === lspPubkey.toLowerCase()) {
      throw new Error(
        `[jit] refusing to start: JIT_PAY_FIBER_RPC_URL (${payRpcUrl}) is the same node as FIBER_RPC_URL ` +
          `(${FIBER_RPC_URL}). same_hash mode requires a distinct paying node — one node cannot hold and pay ` +
          `the same payment hash.`,
      );
    }
    payRpc = candidate;
    console.log(`[jit] paying node: ${payRpcUrl} (${payId.slice(0, 20)}…) — same_hash available`);
  }

  if (verifiers.length > 0 || payRpc) {
    jit = new JitService({
      rpc,
      ...(payRpc ? { payRpc } : {}),
      // JIT is the default provisioning path, so the one-time channel-activation cost is charged here rather
      // than prepaid. The three parts pay for different things:
      //   fee_base — the on-chain open + eventual close, and the risk the merchant makes one sale and leaves.
      //              This is the activation fee, netted from the first sale instead of paid up front.
      //   fee_bps  — the forwarding value of each payment.
      //   rent     — the ongoing cost of locked capital (streaming lease, out of revenue).
      // A JIT open locks >= the acceptor's auto_accept_amount (10 RUSD) plus a CKB cell reserve, so fee_base
      // must cover it and min_payment must exceed fee_base or the merchant nets nothing.
      terms: {
        fee_bps: Number(process.env.JIT_FEE_BPS ?? 100), // 1% of the payment, deducted from the forward
        fee_base: process.env.JIT_FEE_BASE ?? "50000000", // 0.5 RUSD — one open + close
        min_payment: process.env.JIT_MIN_PAYMENT ?? "500000000", // 5 RUSD — must comfortably exceed fee_base
        max_expiry_seconds: Number(process.env.JIT_MAX_EXPIRY ?? 3600),
      },
      supportedAssets: defaultOfferings(),
      ...(verifiers.length > 0 ? { linkageVerifier: compositeLinkageVerifier(verifiers) } : {}),
      // JIT_LOG=1 narrates each order's lifecycle to stdout — the operator's view of a JIT sale.
      ...(process.env.JIT_LOG === "1" ? { onEvent: logJitEvent } : {}),
      // Match the RUSD offering's min_capacity: an acceptor auto-accepts UDT channels only at/above its
      // auto_accept_amount (10 RUSD on testnet), so small JIT payments still open a 10-RUSD channel.
      minCapacity: process.env.JIT_MIN_CAPACITY ?? "1000000000",
      ...(process.env.JIT_STORE_PATH ? { store: new FileJitStore(process.env.JIT_STORE_PATH) } : {}),
      ...(process.env.READY_POLL_ATTEMPTS ? { readyPollAttempts: Number(process.env.READY_POLL_ATTEMPTS) } : {}),
      // The ready-poll budget is attempts × interval. FNN retries a failed funding tx for many minutes on
      // its own, so give the JIT open the same generous window as the purchase flow (default would be 2 s).
      ...(process.env.READY_POLL_INTERVAL_MS ? { pollIntervalMs: Number(process.env.READY_POLL_INTERVAL_MS) } : {}),
    });
    if (!process.env.JIT_STORE_PATH) {
      // JIT holds customer funds while it opens/forwards. resume() only recovers orders it can still read,
      // so with the in-memory store a crash loses every in-flight order — a held customer payment then waits
      // out the hold-invoice expiry for its auto-refund instead of resuming. Safe for funds, bad for uptime.
      console.warn(
        "[jit] WARNING: no JIT_STORE_PATH set — using an in-memory store. In-flight JIT orders will NOT " +
          "survive a restart (resume() has nothing to re-drive); a held payment then relies on the hold " +
          "expiry to auto-refund. Set JIT_STORE_PATH to a file for crash recovery in production.",
      );
    }
  } else {
    console.warn(
      "[jit] disabled: set JIT_PAY_FIBER_RPC_URL (same_hash), or LINKED_JIT_VK_PATH / " +
        "JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 (linked)",
    );
  }
  jit?.resume(); // re-drive any JIT order left in flight by a previous run (settle a mid-forward crash)
  const handle = createApi(lsp, { prepaid, ...(jit ? { jit } : {}) });

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
      console.log(`[jit] JIT on /lsp/v1/jit/*  modes: [${jit.modes.join(", ")}]  (hold: ${FIBER_RPC_URL})`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
