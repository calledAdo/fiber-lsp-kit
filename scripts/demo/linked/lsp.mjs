import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { demoConsole } from "../shared/console.mjs";
import { ensureArtifacts } from "../shared/artifacts.mjs";
import { inspectNodeState } from "../shared/node-state.mjs";
import {
  assertCustomerHoldChannel,
  assertDistinctNodes,
  assertPreimageObservation,
  assertSameChain,
  inspectNode,
} from "../shared/preflight.mjs";
import { createDemoRuntime } from "../shared/processes.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const artifacts = await ensureArtifacts("lsp", cfg);
const runtime = createDemoRuntime(cfg);
await runtime.startMock(new URL("./mock-fnn.mjs", import.meta.url));

const rpcs = Object.fromEntries(
  Object.entries(cfg.topology.nodes).map(([role, node]) => [role, new FiberChannelRpcClient({ rpcUrl: node.rpc })]),
);
const nodes = await Promise.all([
  inspectNode("lsp", rpcs.lsp),
  inspectNode("merchant", rpcs.merchant),
  inspectNode("customer", rpcs.customer),
]);
assertSameChain(nodes);
assertDistinctNodes(nodes);
const customerChannel = await assertCustomerHoldChannel({
  customerRpc: rpcs.customer,
  holdPubkey: nodes.find((node) => node.role === "lsp").pubkey,
  asset: cfg.asset,
});
const lspState = await inspectNodeState({ role: "lsp", rpc: rpcs.lsp, asset: cfg.asset });
demoConsole.heading("Linked JIT", "LSP");
demoConsole.ok("Node topology ready", `${cfg.topology.profile} profile · ${nodes.length} distinct nodes`);
demoConsole.ok("Customer path ready", `${cfg.fmt(customerChannel.outbound)} maximum payment`);
demoConsole.ok(
  "LSP liquidity ready",
  `${cfg.fmt(lspState.assetTotals.totalOutbound)} outbound · ${cfg.fmt(lspState.assetTotals.totalInbound)} inbound`,
);
demoConsole.ok("Linkage verifier loaded", "Groth16 verification key");
await assertPreimageObservation(cfg.topology.nodes.lsp.rpc);
demoConsole.ok("Preimage observer ready", "FNN pubsub");
demoConsole.info("Dashboard", `npm run ${cfg.commands.dashboard}`);
demoConsole.info("Full diagnostics", `npm run ${cfg.commands.status}`);

runtime.startReferenceComposition({
  FIBER_RPC_URL: cfg.topology.nodes.lsp.rpc,
  JIT_PAY_FIBER_RPC_URL: "",
  LINKED_JIT_VK_PATH: artifacts.vk,
  JIT_ALLOW_UNSAFE_EXPOSED_SECRET: "",
});
