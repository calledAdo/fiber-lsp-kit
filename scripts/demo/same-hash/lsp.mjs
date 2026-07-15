import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { demoConsole } from "../shared/console.mjs";
import { inspectNodeState } from "../shared/node-state.mjs";
import { assertCustomerHoldChannel, assertDistinctNodes, assertPreimageObservation, assertSameChain, inspectNode } from "../shared/preflight.mjs";
import { createDemoRuntime } from "../shared/processes.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const runtime = createDemoRuntime(cfg);
await runtime.startMock(new URL("./mock-fnn.mjs", import.meta.url));

const rpcs = Object.fromEntries(
  Object.entries(cfg.topology.nodes).map(([role, node]) => [role, new FiberChannelRpcClient({ rpcUrl: node.rpc })]),
);
const nodes = await Promise.all([
  inspectNode("hold", rpcs.hold),
  inspectNode("payment", rpcs.payment),
  inspectNode("merchant", rpcs.merchant),
  inspectNode("customer", rpcs.customer),
]);
assertSameChain(nodes);
assertDistinctNodes(nodes);
const customerChannel = await assertCustomerHoldChannel({
  customerRpc: rpcs.customer,
  holdPubkey: nodes.find((node) => node.role === "hold").pubkey,
  asset: cfg.asset,
});
const lspStates = await Promise.all([
  inspectNodeState({ role: "hold", rpc: rpcs.hold, asset: cfg.asset }),
  inspectNodeState({ role: "payment", rpc: rpcs.payment, asset: cfg.asset }),
]);
demoConsole.heading("Same-hash JIT", "LSP operator");
demoConsole.ok("Node topology ready", `${cfg.topology.profile} profile · ${nodes.length} distinct nodes`);
demoConsole.ok("Customer path ready", `${cfg.fmt(customerChannel.outbound)} maximum payment`);
for (const state of lspStates) {
  demoConsole.ok(
    `${state.role === "hold" ? "Hold" : "Payment"} node liquidity`,
    `${cfg.fmt(state.assetTotals.totalOutbound)} outbound · ${cfg.fmt(state.assetTotals.totalInbound)} inbound`,
  );
}
await assertPreimageObservation(cfg.topology.nodes.payment.rpc);
demoConsole.ok("Preimage observer ready", "payment-node FNN pubsub");
demoConsole.info("Dashboard", `npm run ${cfg.commands.dashboard}`);
demoConsole.info("Full diagnostics", `npm run ${cfg.commands.status}`);

runtime.startReferenceComposition({
  FIBER_RPC_URL: cfg.topology.nodes.hold.rpc,
  JIT_PAY_FIBER_RPC_URL: cfg.topology.nodes.payment.rpc,
  LINKED_JIT_VK_PATH: "",
  JIT_ALLOW_UNSAFE_EXPOSED_SECRET: "",
});
