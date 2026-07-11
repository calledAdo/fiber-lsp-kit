// mock-fnn — a local stand-in for real Fiber (fnn) nodes, so the 3-terminal demo runs with no chain.
//
//   NETWORK=local node scripts/theater/mock-fnn.mjs
//
// It reads the active profile (must be `fnn: "mock"`) and opens ONE HTTP JSON-RPC listener per node on that
// node's RPC port, all backed by a single shared "network". It implements exactly the fnn surface the kit
// touches for the JIT flagship — invoices (including HOLD invoices), channel open, payments, and preimage
// reveal — and nothing more. The LSP server, the merchant SDK, and the customer script are all REAL code and
// cannot tell this apart from fnn: they speak the same JSON-RPC. Swap the profile to `fnn: "live"` and the
// identical scripts talk to real nodes instead — this daemon is the only thing that goes away.
//
// The ZK is NOT faked here: `linked` proofs are built by the real wasm prover in the merchant terminal and
// verified by real code in the LSP server. This daemon only moves invoices, channels and preimages around.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { loadProfile } from "../live/lib/profile.mjs";

const P = loadProfile();
if (P.fnn !== "mock") {
  console.error(`mock-fnn refuses to run: profile "${P.name}" is fnn: ${JSON.stringify(P.fnn)}, not "mock".`);
  console.error(`It would shadow real nodes. Select a mock profile (e.g. NETWORK=local).`);
  process.exit(2);
}

const sha256 = (hex) => "0x" + createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
const portOf = (url) => Number(new URL(url).port);
// A stable, distinct node identity per port (the server checks the paying node is a *different* node).
const pubkeyFor = (port) => "02" + createHash("sha256").update(`node:${port}`).digest("hex").slice(0, 62);

// ── the shared network ────────────────────────────────────────────────────────────────────────────────
const world = {
  invoices: new Map(), // invoice_address -> { hash, amount, preimage?, issuer }
  held: new Map(), // payment_hash -> { node } : a captured-but-held payment, awaiting the issuer's settle
};
const registry = {}; // role -> node controls

function makeNode(role, port) {
  const status = new Map(); // payment_hash this node ISSUED -> Open | Received | Paid | Cancelled
  const payments = new Map(); // payment_hash this node PAID -> { status, payment_preimage? }
  const channels = [];
  const pubkey = pubkeyFor(port);
  let seq = 0;

  const rpc = (method, params) => {
    const p0 = params?.[0] ?? {};
    switch (method) {
      case "node_info":
        return { node_id: pubkey, pubkey, addresses: [`/ip4/127.0.0.1/tcp/${port}`] };
      case "list_peers":
        return { peers: Object.values(registry).filter((n) => n.role !== role).map((n) => ({ pubkey: n.pubkey })) };
      case "connect_peer":
        return {};
      case "graph_nodes":
        return { nodes: Object.values(registry).map((n) => ({ node_id: n.pubkey, addresses: [] })) };
      case "new_invoice": {
        const hash = p0.payment_hash ?? sha256(p0.payment_preimage);
        const addr = `fibt_${role}_${seq++}`;
        world.invoices.set(addr, { hash, amount: BigInt(p0.amount).toString(), preimage: p0.payment_preimage, issuer: role });
        status.set(hash, "Open");
        return { invoice_address: addr, invoice: { amount: BigInt(p0.amount).toString(), data: { payment_hash: hash } } };
      }
      case "parse_invoice": {
        const inv = world.invoices.get(p0.invoice);
        return inv ? { invoice: { amount: inv.amount, data: { payment_hash: inv.hash } } } : null;
      }
      case "get_invoice":
        return { status: status.get(p0.payment_hash) ?? "Open" };
      case "settle_invoice": {
        // The issuer reveals the preimage: its invoice becomes Paid, and any held payer payment now succeeds.
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
        const ch = { channel_id: `0xch_${role}_${seq}`, pubkey: p0.pubkey, funding_udt_type_script: p0.funding_udt_type_script ?? null,
          state: { state_name: "ChannelReady" }, channel_outpoint: `0xoutpoint_${role}_${seq}`, local_balance: p0.funding_amount, remote_balance: "0x0", enabled: true };
        channels.push(ch);
        return { temporary_channel_id: `0xtmp_${seq++}` };
      }
      case "list_channels":
        return { channels: p0.pubkey ? channels.filter((c) => c.pubkey === p0.pubkey) : channels };
      case "abandon_channel":
        return {};
      case "send_payment": {
        const inv = world.invoices.get(p0.invoice);
        if (!inv) return { status: "Failed" };
        if (inv.preimage) {
          // The issuer set a preimage (a normal / leg invoice): the payer learns it on payment — settled now.
          registry[inv.issuer].setStatus(inv.hash, "Paid");
          payments.set(inv.hash, { status: "Success", payment_preimage: inv.preimage });
          return { payment_hash: inv.hash, status: "Success" };
        }
        // No preimage (a HOLD invoice): the payment is captured and HELD until the issuer settles it.
        registry[inv.issuer].setStatus(inv.hash, "Received");
        payments.set(inv.hash, { status: "Inflight" });
        world.held.set(inv.hash, { node: registry[role] });
        return { payment_hash: inv.hash, status: "Inflight" };
      }
      case "get_payment":
        return payments.get(p0.payment_hash) ?? { status: "Failed" };
      default:
        return null;
    }
  };

  return { role, port, pubkey, rpc, setStatus: (h, s) => status.set(h, s), payments };
}

// ── one HTTP JSON-RPC listener per node ─────────────────────────────────────────────────────────────────
const listeners = [];
for (const [role, node] of Object.entries(P.nodes)) {
  if (!node.rpc) continue;
  const port = portOf(node.rpc);
  registry[role] = makeNode(role, port);
}
for (const role of Object.keys(registry)) {
  const node = registry[role];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let out = null, id = null;
      try {
        const { id: rid, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        id = rid;
        out = node.rpc(method, params);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: out }));
    });
  });
  server.listen(node.port, "127.0.0.1", () => console.log(`[mock-fnn] ${role.padEnd(9)} node on http://127.0.0.1:${node.port}  (${node.pubkey.slice(0, 14)}…)`));
  listeners.push(server);
}

console.log(`[mock-fnn] up — ${listeners.length} node(s) sharing one network [${P.name}]. Ctrl-C to stop.`);
process.on("SIGINT", () => { console.log("\n[mock-fnn] stopping."); for (const s of listeners) s.close(); process.exit(0); });
