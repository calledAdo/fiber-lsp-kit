import { createWorld, makeNode, seedCustomerHoldChannel, serveMockWorld } from "../shared/mock-node.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const world = createWorld();
for (const { role, port } of cfg.mockNodes) makeNode(world, role, port);
seedCustomerHoldChannel({
  world,
  customerRole: "customer",
  holdRole: "lsp",
  amount: cfg.e2eFixtures.customerHoldCapacity,
  assetScript: cfg.assetScript,
});
const servers = serveMockWorld(world);
console.log("[mock-fnn] linked topology ready: customer => LSP channel; LSP and merchant start disconnected");
process.on("SIGINT", () => {
  for (const server of servers) server.close();
  process.exit(0);
});
