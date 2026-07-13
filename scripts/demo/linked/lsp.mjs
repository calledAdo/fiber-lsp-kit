import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { ensureArtifacts } from "../shared/artifacts.mjs";
import { assertCustomerHoldChannel, assertDistinctNodes, assertSameChain, formatPreflightReport, inspectNode } from "../shared/preflight.mjs";
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
  amount: cfg.amounts.jitPayment,
});
console.log(formatPreflightReport({ profile: cfg.topology.profile, nodes, customerChannel }));

runtime.startReferenceServer({
  FIBER_RPC_URL: cfg.topology.nodes.lsp.rpc,
  JIT_PAY_FIBER_RPC_URL: "",
  LINKED_JIT_VK_PATH: artifacts.vk,
  JIT_ALLOW_UNSAFE_EXPOSED_SECRET: "",
});
