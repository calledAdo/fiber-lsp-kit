import { createWorld, makeNode, seedCustomerHoldChannel, serveMockWorld } from "../shared/mock-node.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const world = createWorld();
for (const { role, port } of cfg.mockNodes) makeNode(world, role, port);
seedCustomerHoldChannel({
  world,
  customerRole: "customer",
  holdRole: "hold",
  amount: cfg.amounts.customerHoldCapacity,
  assetScript: cfg.assetScript,
});
const servers = serveMockWorld(world);
console.log("[mock-fnn] same-hash topology ready: customer => hold channel; payment and merchant start disconnected");
process.on("SIGINT", () => {
  for (const server of servers) server.close();
  process.exit(0);
});
