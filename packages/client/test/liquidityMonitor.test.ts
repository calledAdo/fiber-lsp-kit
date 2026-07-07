import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { InvoiceService, LiquidityMonitor, type ReceiveReadiness } from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/** Receiver node whose inbound (a ready RUSD channel's remote_balance) is a mutable handle. */
function node(inbound: bigint) {
  const state = { inbound };
  const fetchImpl = async (_url: string, i: { body?: string }) => {
    const { id, method } = JSON.parse(i.body ?? "{}");
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
                  remote_balance: "0x" + state.inbound.toString(16),
                  enabled: true,
                },
              ]
            : [],
      };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  const svc = new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: "http://m", fetchImpl }) });
  return { svc, state };
}

const CLOCK = { now: () => 1_700_000_000 };

test("check raises no alert while inbound is above the floor", async () => {
  const { svc } = node(500n);
  const mon = new LiquidityMonitor({ invoices: svc, targets: [{ asset: RUSD, minInbound: "100" }], ...CLOCK });
  assert.deepEqual(await mon.check(), []);
});

test("check alerts with the shortfall-to-target when inbound drops below the floor", async () => {
  const { svc } = node(50n);
  const seen: unknown[] = [];
  const mon = new LiquidityMonitor({
    invoices: svc,
    targets: [{ asset: RUSD, minInbound: "100", targetInbound: "300" }],
    handlers: { onAlert: (a) => seen.push(a) },
    ...CLOCK,
  });
  const alerts = await mon.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].inbound, "50");
  assert.equal(alerts[0].minInbound, "100");
  assert.equal(alerts[0].shortfall, "250"); // target 300 − inbound 50
  assert.equal(alerts[0].at, 1_700_000_000);
  assert.equal(seen.length, 1);
});

test("check auto-tops-up via ensureInbound with the shortfall-to-target", async () => {
  const n = node(50n);
  let provisioned: ReceiveReadiness | undefined;
  const mon = new LiquidityMonitor({
    invoices: n.svc,
    targets: [{ asset: RUSD, minInbound: "100", targetInbound: "300" }],
    handlers: {
      ensureInbound: async (r) => {
        provisioned = r;
        n.state.inbound = 300n; // LSP delivered the top-up
      },
    },
    ...CLOCK,
  });
  await mon.check();
  assert.equal(provisioned?.shortfall, "250");
  assert.equal(provisioned?.asset.symbol, "RUSD");
  assert.deepEqual(await mon.check(), []); // now above the floor
});

test("check defaults targetInbound to minInbound", async () => {
  const { svc } = node(30n);
  const mon = new LiquidityMonitor({ invoices: svc, targets: [{ asset: RUSD, minInbound: "100" }], ...CLOCK });
  const [alert] = await mon.check();
  assert.equal(alert.shortfall, "70"); // 100 − 30
});

test("start runs check on an interval until stopped", async () => {
  const { svc } = node(50n);
  let passes = 0;
  const mon = new LiquidityMonitor({
    invoices: svc,
    targets: [{ asset: RUSD, minInbound: "100" }],
    handlers: { onAlert: () => void (passes += 1) },
    ...CLOCK,
  });
  let handle: { stop: () => void; done: Promise<void> };
  handle = mon.start({
    intervalMs: 0,
    sleep: async () => {
      if (passes >= 2) handle.stop();
    },
  });
  await handle.done;
  assert.ok(passes >= 2);
});
