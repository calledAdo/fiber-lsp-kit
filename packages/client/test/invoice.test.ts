import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { InvoiceService, ReceiveNotReadyError } from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/**
 * A scripted receiver node. `inbound` is the remote_balance of a ready RUSD channel (0 = no inbound yet);
 * mutate it via the returned handle to simulate an LSP delivering inbound. `invoiceStatuses` is replayed
 * one per get_invoice call so a test can walk Open → Paid.
 */
function receiverNode(init: { inbound: bigint; invoiceStatuses?: string[] }) {
  const state = { inbound: init.inbound };
  const statuses = init.invoiceStatuses ?? ["Paid"];
  let getCalls = 0;
  const calls: string[] = [];

  const fetchImpl = async (_url: string, i: { body?: string }) => {
    const { id, method } = JSON.parse(i.body ?? "{}");
    calls.push(method);
    let result: unknown = null;
    if (method === "list_channels") {
      result = {
        channels:
          state.inbound > 0n
            ? [
                {
                  channel_id: "0xc",
                  pubkey: "0xpeer",
                  funding_udt_type_script: RUSD_SCRIPT,
                  state: { state_name: "ChannelReady" },
                  local_balance: "0x0",
                  remote_balance: "0x" + state.inbound.toString(16), // receiver's inbound
                  enabled: true,
                },
              ]
            : [],
      };
    } else if (method === "new_invoice") {
      result = { invoice_address: "fibt1qreceive", invoice: { data: { payment_hash: "0xph" } } };
    } else if (method === "get_invoice") {
      result = { status: statuses[Math.min(getCalls++, statuses.length - 1)] };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };

  return {
    svc: new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl }) }),
    state,
    calls,
  };
}

test("checkReceiveReadiness sums inbound and reports the shortfall", async () => {
  const { svc } = receiverNode({ inbound: 300n });
  const r = await svc.checkReceiveReadiness(RUSD, "500");
  assert.equal(r.inbound, "300");
  assert.equal(r.canReceive, false);
  assert.equal(r.shortfall, "200");

  const ok = await svc.checkReceiveReadiness(RUSD, "250");
  assert.equal(ok.canReceive, true);
  assert.equal(ok.shortfall, "0");
});

test("receive throws when inbound is short and no provisioner is given", async () => {
  const { svc } = receiverNode({ inbound: 0n });
  await assert.rejects(
    () => svc.receive({ asset: RUSD, amount: "500" }),
    (e) => e instanceof ReceiveNotReadyError && e.readiness.shortfall === "500",
  );
});

test("receive provisions inbound just-in-time, then issues the invoice", async () => {
  const node = receiverNode({ inbound: 0n });
  const issued = await node.svc.receive({
    asset: RUSD,
    amount: "500",
    description: "order #42",
    // Simulate buying inbound from an LSP: the delivered channel now shows remote_balance.
    ensureInbound: async (readiness) => {
      assert.equal(readiness.shortfall, "500");
      node.state.inbound = 500n;
    },
  });
  assert.equal(issued.invoice, "fibt1qreceive");
  assert.equal(issued.paymentHash, "0xph");
  assert.equal(issued.amount, "500");
  // ensureInbound → re-check → issue: two readiness reads then the invoice.
  assert.deepEqual(node.calls, ["list_channels", "list_channels", "new_invoice"]);
});

test("waitForPayment polls until the invoice is Paid", async () => {
  const { svc } = receiverNode({ inbound: 500n, invoiceStatuses: ["Open", "Received", "Paid"] });
  const seen: string[] = [];
  const outcome = await svc.waitForPayment("0xph", {
    intervalMs: 0,
    sleep: async () => {},
    onUpdate: (s) => seen.push(s),
  });
  assert.equal(outcome.paid, true);
  assert.equal(outcome.status, "Paid");
  assert.deepEqual(seen, ["Open", "Received", "Paid"]);
});

test("issuing a UDT invoice from a bare-hex asset fails with a clear error", async () => {
  const { svc } = receiverNode({ inbound: 500n });
  const bareHexAsset = { kind: "UDT" as const, scriptHex: "0xabc", symbol: "RUSD" };
  await assert.rejects(() => svc.issue({ asset: bareHexAsset, amount: "500" }), /udtAsset/);
});
