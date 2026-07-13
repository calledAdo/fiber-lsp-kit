// The always-succeeds mock Fiber node — the shared logic behind the mock-fnn daemon AND the end-to-end test,
// so both exercise exactly the same behaviour. It implements the fnn JSON-RPC surface the JIT flow touches:
// invoices (incl. HOLD invoices held until settle, and node-generated invoices that settle directly), channel
// open, invoice + keysend payments, and preimage reveal. It moves invoices/channels/preimages around; it does
// NOT touch the ZK (real prover + real verifier do that above it).
import { createHash } from "node:crypto";

const sha256 = (hex) => "0x" + createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
export const pubkeyFor = (port) => "02" + createHash("sha256").update(`node:${port}`).digest("hex").slice(0, 62);
const sameScript = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function moveAcrossChannel(world, receiver, invoice) {
  const amount = BigInt(invoice.amount);
  const channel = receiver.channels.find((candidate) =>
    candidate.enabled &&
    candidate.state.state_name === "ChannelReady" &&
    sameScript(candidate.funding_udt_type_script, invoice.udt_type_script) &&
    BigInt(candidate.remote_balance) >= amount);
  if (!channel) return;

  channel.local_balance = "0x" + (BigInt(channel.local_balance) + amount).toString(16);
  channel.remote_balance = "0x" + (BigInt(channel.remote_balance) - amount).toString(16);
  const peer = Object.values(world.registry).find((candidate) => candidate.pubkey === channel.pubkey);
  const mirror = peer?.channels.find((candidate) => candidate.channel_outpoint === channel.channel_outpoint);
  if (mirror) {
    mirror.local_balance = "0x" + (BigInt(mirror.local_balance) - amount).toString(16);
    mirror.remote_balance = "0x" + (BigInt(mirror.remote_balance) + amount).toString(16);
  }
}

/** A shared "network" all nodes are backed by. One per demo run / test. */
export function createWorld() {
  return { invoices: new Map(), held: new Map(), registry: {} }; // addr->{hash,amount,preimage?,issuer}; hash->{node}; role->node
}

/** Build one node for `role` on `port`, registered into `world.registry`. */
export function makeNode(world, role, port) {
  const { registry } = world;
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
      case "graph_channels": {
        const limit = p0.limit === undefined ? channels.length : Number(BigInt(p0.limit));
        return {
          channels: channels.slice(0, limit).map((ch) => ({
            channel_outpoint: ch.channel_outpoint,
            node1: pubkey,
            node2: ch.pubkey,
            created_timestamp: "0x1",
            update_info_of_node1: {
              timestamp: "0x1", enabled: ch.enabled, outbound_liquidity: ch.local_balance,
              tlc_expiry_delta: "0xdbba00", tlc_minimum_value: "0x0", fee_rate: "0x0",
            },
            update_info_of_node2: {
              timestamp: "0x1", enabled: ch.enabled, outbound_liquidity: ch.remote_balance,
              tlc_expiry_delta: "0xdbba00", tlc_minimum_value: "0x0", fee_rate: "0x0",
            },
            capacity: "0x" + (BigInt(ch.local_balance) + BigInt(ch.remote_balance)).toString(16),
            chain_hash: "0xmock",
            udt_type_script: ch.funding_udt_type_script ?? null,
          })),
          last_cursor: "0x",
        };
      }
      case "new_invoice": {
        // A node-generated invoice (no hash/preimage supplied) gets a random preimage — so it settles directly.
        const preimage = p0.payment_preimage ?? ("0x" + createHash("sha256").update(`${role}:${seq}:${Date.now()}:${Math.random()}`).digest("hex"));
        const hash = p0.payment_hash ?? sha256(preimage);
        const addr = `fibt_${role}_${seq++}`;
        const timestamp = "0x" + Date.now().toString(16);
        const signature = createHash("sha256").update(`signature:${pubkey}:${hash}`).digest("hex");
        world.invoices.set(addr, {
          hash,
          amount: BigInt(p0.amount).toString(),
          preimage: p0.payment_hash ? undefined : preimage,
          issuer: role,
          pubkey,
          currency: p0.currency ?? "Fibt",
          description: p0.description,
          udt_type_script: p0.udt_type_script ?? null,
          expiry: p0.expiry,
          timestamp,
          signature,
        });
        status.set(hash, "Open");
        return { invoice_address: addr, invoice: { amount: BigInt(p0.amount).toString(), data: { payment_hash: hash } } };
      }
      case "parse_invoice": {
        const inv = world.invoices.get(p0.invoice);
        if (!inv) return null;
        const attrs = [{ payee_public_key: inv.pubkey }];
        if (inv.description !== undefined) attrs.push({ description: inv.description });
        if (inv.expiry !== undefined) attrs.push({ expiry_time: inv.expiry });
        return {
          invoice: {
            currency: inv.currency,
            amount: inv.amount,
            signature: inv.signature,
            data: { timestamp: inv.timestamp, payment_hash: inv.hash, attrs },
          },
        };
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
        const channelId = `0xch_${role}_${seq}`;
        const channelOutpoint = `0xoutpoint_${role}_${seq}`;
        const common = { channel_id: channelId, funding_udt_type_script: p0.funding_udt_type_script ?? null,
          state: { state_name: "ChannelReady" }, channel_outpoint: channelOutpoint, enabled: true };
        channels.push({ ...common, pubkey: p0.pubkey, local_balance: p0.funding_amount, remote_balance: "0x0" });
        const peer = Object.values(registry).find((candidate) => candidate.pubkey === p0.pubkey);
        if (peer) peer.channels.push({ ...common, state: { ...common.state }, pubkey, local_balance: "0x0", remote_balance: p0.funding_amount });
        return { temporary_channel_id: `0xtmp_${seq++}` };
      }
      case "list_channels": return { channels: p0.pubkey ? channels.filter((c) => c.pubkey === p0.pubkey) : channels };
      case "abandon_channel": return {};
      case "shutdown_channel": {
        // Cooperative close: flip the channel to Closed (leaves the record so list_channels history holds).
        const ch = channels.find((c) => c.channel_id === p0.channel_id || c.channel_outpoint === p0.channel_id);
        if (ch) { ch.state = { state_name: "Closed" }; ch.enabled = false; }
        return null;
      }
      case "build_router": return {
        router_hops: p0.hops_info.map((hop, index) => ({
          target: hop.pubkey,
          channel_outpoint: hop.channel_outpoint ?? `0xmock_route_${index}`,
          amount_received: p0.amount,
          incoming_tlc_expiry: "0x5265c00",
        })),
      };
      case "send_payment_with_router": {
        const ph = p0.payment_hash ?? ("0x" + createHash("sha256").update(`route:${role}:${seq++}:${Date.now()}`).digest("hex"));
        if (p0.dry_run) return { payment_hash: ph, status: "Created", fee: "0x0" };

        const first = p0.router[0];
        const last = p0.router[p0.router.length - 1];
        const donor = channels.find((ch) => ch.channel_outpoint === first.channel_outpoint);
        const starved = channels.find((ch) => ch.channel_outpoint === last.channel_outpoint);
        if (!donor || !starved) return { payment_hash: ph, status: "Failed", failed_error: "mock route channel not found" };

        const amount = BigInt(last.amount_received);
        donor.local_balance = "0x" + (BigInt(donor.local_balance) - amount).toString(16);
        donor.remote_balance = "0x" + (BigInt(donor.remote_balance) + amount).toString(16);
        starved.local_balance = "0x" + (BigInt(starved.local_balance) + amount).toString(16);
        starved.remote_balance = "0x" + (BigInt(starved.remote_balance) - amount).toString(16);
        payments.set(ph, {
          payment_hash: ph,
          status: "Success",
          fee: "0x0",
          amount: last.amount_received,
          udt_type_script: p0.udt_type_script ?? null,
        });
        return { payment_hash: ph, status: "Success", fee: "0x0" };
      }
      case "send_payment": {
        if (!p0.invoice && p0.target_pubkey) { // keysend (e.g. streaming rent): spontaneous pay to a pubkey
          const amount = BigInt(p0.amount);
          const direct = channels.find((candidate) =>
            candidate.pubkey === p0.target_pubkey &&
            candidate.enabled &&
            candidate.state.state_name === "ChannelReady" &&
            sameScript(candidate.funding_udt_type_script, p0.udt_type_script) &&
            BigInt(candidate.local_balance) >= amount);
          if (!direct) return { status: "Failed", failed_error: "mock direct channel has insufficient balance" };
          if (p0.dry_run) return { status: "Success", fee: "0x0" };
          direct.local_balance = "0x" + (BigInt(direct.local_balance) - amount).toString(16);
          direct.remote_balance = "0x" + (BigInt(direct.remote_balance) + amount).toString(16);
          const peer = Object.values(registry).find((candidate) => candidate.pubkey === p0.target_pubkey);
          const mirror = peer?.channels.find((candidate) => candidate.channel_outpoint === direct.channel_outpoint);
          if (mirror) {
            mirror.local_balance = "0x" + (BigInt(mirror.local_balance) + amount).toString(16);
            mirror.remote_balance = "0x" + (BigInt(mirror.remote_balance) - amount).toString(16);
          }
          const ph = "0x" + createHash("sha256").update(`ks:${role}:${seq++}:${Date.now()}`).digest("hex");
          payments.set(ph, { payment_hash: ph, status: "Success", fee: "0x0", amount: p0.amount, udt_type_script: p0.udt_type_script ?? null });
          return { payment_hash: ph, status: "Success", fee: "0x0" };
        }
        const inv = world.invoices.get(p0.invoice);
        if (!inv) return { status: "Failed" };
        if (inv.preimage) { // a regular merchant invoice: the payer learns the preimage — settled now
          const issuer = registry[inv.issuer];
          moveAcrossChannel(world, issuer, inv);
          issuer.setStatus(inv.hash, "Paid");
          payments.set(inv.hash, { payment_hash: inv.hash, status: "Success", payment_preimage: inv.preimage, amount: "0x" + BigInt(inv.amount).toString(16), udt_type_script: p0.udt_type_script ?? null });
          return { payment_hash: inv.hash, status: "Success" };
        }
        // a HOLD invoice: captured and HELD until the issuer settles it
        registry[inv.issuer].setStatus(inv.hash, "Received");
        payments.set(inv.hash, { payment_hash: inv.hash, status: "Inflight", amount: "0x" + BigInt(inv.amount).toString(16) });
        world.held.set(inv.hash, { node: registry[role] });
        return { payment_hash: inv.hash, status: "Inflight" };
      }
      case "get_payment": return payments.get(p0.payment_hash) ?? { status: "Failed" };
      case "list_payments": return { payments: [...payments.entries()].map(([h, v]) => ({ payment_hash: h, ...v })) };
      default: return null;
    }
  };
  const node = { role, port, pubkey, rpc, setStatus: (h, s) => status.set(h, s), payments, channels };
  registry[role] = node;
  return node;
}
