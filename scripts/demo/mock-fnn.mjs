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
import { createHash } from "node:crypto";
import { loadConfig } from "./lib/config.mjs";

const cfg = loadConfig();
const sha256 = (hex) => "0x" + createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
const pubkeyFor = (port) => "02" + createHash("sha256").update(`node:${port}`).digest("hex").slice(0, 62);

const world = { invoices: new Map(), held: new Map() }; // addr -> {hash,amount,preimage?,issuer}; hash -> {node}
const registry = {}; // role -> node controls

function makeNode(role, port) {
  const status = new Map();
  const payments = new Map();
  const channels = [];
  const pubkey = pubkeyFor(port);
  let seq = 0;
  const rpc = (method, params) => {
    const p0 = params?.[0] ?? {};
    switch (method) {
      case "node_info": return { node_id: pubkey, pubkey, addresses: [`/ip4/127.0.0.1/tcp/${port}`] };
      case "list_peers": return { peers: Object.values(registry).filter((n) => n.role !== role).map((n) => ({ pubkey: n.pubkey })) };
      case "connect_peer": return {};
      case "graph_nodes": return { nodes: Object.values(registry).map((n) => ({ node_id: n.pubkey, addresses: [] })) };
      case "new_invoice": {
        // A node-generated invoice (no hash/preimage supplied) gets a random preimage — so it settles directly.
        const preimage = p0.payment_preimage ?? ("0x" + createHash("sha256").update(`${role}:${seq}:${Date.now()}`).digest("hex"));
        const hash = p0.payment_hash ?? sha256(preimage);
        const addr = `fibt_${role}_${seq++}`;
        world.invoices.set(addr, { hash, amount: BigInt(p0.amount).toString(), preimage: p0.payment_hash ? undefined : preimage, issuer: role });
        status.set(hash, "Open");
        return { invoice_address: addr, invoice: { amount: BigInt(p0.amount).toString(), data: { payment_hash: hash } } };
      }
      case "parse_invoice": {
        const inv = world.invoices.get(p0.invoice);
        return inv ? { invoice: { amount: inv.amount, data: { payment_hash: inv.hash } } } : null;
      }
      case "get_invoice": return { status: status.get(p0.payment_hash) ?? "Open" };
      case "settle_invoice": {
        status.set(p0.payment_hash, "Paid");
        const h = world.held.get(p0.payment_hash);
        if (h) { h.node.payments.set(p0.payment_hash, { status: "Success", payment_preimage: p0.payment_preimage }); world.held.delete(p0.payment_hash); }
        return {};
      }
      case "cancel_invoice": {
        status.set(p0.payment_hash, "Cancelled");
        const h = world.held.get(p0.payment_hash);
        if (h) { h.node.payments.set(p0.payment_hash, { status: "Failed" }); world.held.delete(p0.payment_hash); }
        return {};
      }
      case "open_channel": {
        channels.push({ channel_id: `0xch_${role}_${seq}`, pubkey: p0.pubkey, funding_udt_type_script: p0.funding_udt_type_script ?? null,
          state: { state_name: "ChannelReady" }, channel_outpoint: `0xoutpoint_${role}_${seq}`, local_balance: p0.funding_amount, remote_balance: "0x0", enabled: true });
        return { temporary_channel_id: `0xtmp_${seq++}` };
      }
      case "list_channels": return { channels: p0.pubkey ? channels.filter((c) => c.pubkey === p0.pubkey) : channels };
      case "abandon_channel": return {};
      case "send_payment": {
        if (!p0.invoice && p0.target_pubkey) { // keysend (e.g. streaming rent): spontaneous pay to a pubkey
          if (p0.dry_run) return { status: "Success", fee: "0x0" };
          const ph = "0x" + createHash("sha256").update(`ks:${role}:${seq++}:${Date.now()}`).digest("hex");
          payments.set(ph, { status: "Success", fee: "0x0" });
          return { payment_hash: ph, status: "Success", fee: "0x0" };
        }
        const inv = world.invoices.get(p0.invoice);
        if (!inv) return { status: "Failed" };
        if (inv.preimage) { // a normal/leg invoice: the payer learns the preimage — settled now
          registry[inv.issuer].setStatus(inv.hash, "Paid");
          payments.set(inv.hash, { status: "Success", payment_preimage: inv.preimage });
          return { payment_hash: inv.hash, status: "Success" };
        }
        // a HOLD invoice: captured and HELD until the issuer settles it
        registry[inv.issuer].setStatus(inv.hash, "Received");
        payments.set(inv.hash, { status: "Inflight" });
        world.held.set(inv.hash, { node: registry[role] });
        return { payment_hash: inv.hash, status: "Inflight" };
      }
      case "get_payment": return payments.get(p0.payment_hash) ?? { status: "Failed" };
      default: return null;
    }
  };
  return { role, port, pubkey, rpc, setStatus: (h, s) => status.set(h, s), payments };
}

for (const [role, r] of Object.entries(cfg.roles)) {
  if (r.mock) registry[role] = makeNode(role, cfg.mock.ports[role]);
}
if (Object.keys(registry).length === 0) { console.log("[mock-fnn] no mock roles configured — nothing to do."); process.exit(0); }

const listeners = [];
for (const node of Object.values(registry)) {
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
