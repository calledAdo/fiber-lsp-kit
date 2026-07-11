// mock-fnn — an always-succeeds stand-in for real Fiber (fnn) nodes, so the demo needs no chain.
//
// It reads demo.config.json and opens one HTTP JSON-RPC listener for each role whose `fnn` is empty, all
// backed by a single shared "network". It implements exactly the fnn surface the JIT flow touches — invoices
// (including HOLD invoices), channel open, payments, and preimage reveal — and treats them as always
// succeeding. It is an abstraction of "a funded, connected node that works": if you want real guarantees, put
// a real node's URL in the config and this daemon steps aside for that role.
//
// The ZK is NOT faked here: `linked` proofs are built by the real prover in the merchant server and verified
// by real code in the LSP server. This daemon only moves invoices, channels and preimages around.
import { createServer } from "node:http";
import { loadConfig } from "./lib/config.mjs";
import { createWorld, makeNode } from "./lib/mock-node.mjs";

const cfg = loadConfig();
const world = createWorld();

for (const [role, r] of Object.entries(cfg.roles)) {
  if (r.mock) makeNode(world, role, cfg.mock.ports[role]);
}
if (Object.keys(world.registry).length === 0) { console.log("[mock-fnn] no mock roles configured — nothing to do."); process.exit(0); }

const listeners = [];
for (const node of Object.values(world.registry)) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let id = null, out = null;
      try { const { id: rid, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); id = rid; out = node.rpc(method, params); }
      catch (e) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: out }));
    });
  });
  server.listen(node.port, "127.0.0.1", () => console.log(`[mock-fnn] ${node.role.padEnd(9)} node on http://127.0.0.1:${node.port}  (${node.pubkey.slice(0, 14)}…)`));
  listeners.push(server);
}
console.log(`[mock-fnn] up — ${listeners.length} mock node(s), always-succeeds. Ctrl-C to stop.`);
process.on("SIGINT", () => { for (const s of listeners) s.close(); process.exit(0); });
