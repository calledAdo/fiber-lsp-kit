// Fiber LSP Kit — Liquidity Console. Vanilla ES module, no build, no dependencies.
// Two drivers share one interface; the UI never knows whether it's replaying or hitting a live server.
import { TRANSCRIPT } from "./transcript.js";

const SHANNONS = 100_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);

// ---- formatting -------------------------------------------------------------
function assetLabel(a) {
  return a.kind === "CKB" ? "CKB" : a.symbol ?? "UDT";
}
function fmt(amount, asset) {
  // both CKB (shannons) and testnet RUSD use 8 decimals
  const v = Number(BigInt(amount)) / Number(SHANNONS);
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${assetLabel(asset)}`;
}
const short = (h, n = 10) => (h && h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-6)}` : h);

// ---- rpc log ----------------------------------------------------------------
function log(kind, text) {
  const el = document.createElement("div");
  el.className = `log-line log-${kind}`;
  el.innerHTML = `<span class="log-tag">${kind}</span>${text}`;
  $("#log").append(el);
  $("#log").scrollTop = $("#log").scrollHeight;
}

// ---- drivers ----------------------------------------------------------------
// Replay: canned real data with lifelike pacing.
const replayDriver = {
  mode: "replay",
  async getInfo() {
    log("GET", "/lsp/v1/info");
    await sleep(350);
    return TRANSCRIPT.info;
  },
  async createOrder(req) {
    log("POST", `/lsp/v1/orders  ${assetLabel(req.asset)} ${fmt(req.lsp_balance, req.asset)}`);
    await sleep(500);
    log("rpc", "new_invoice → CKB fee invoice");
    return {
      order_id: TRANSCRIPT.order_id,
      state: "awaiting_payment",
      request: req,
      fee: { asset: { kind: "CKB" }, total_fee: TRANSCRIPT.fee_total, fee_mode: "prepaid" },
      payment: { mode: "prepaid", fee_invoice: TRANSCRIPT.fee_invoice, amount: TRANSCRIPT.fee_total },
      expires_at: 0,
      created_at: 0,
    };
  },
  async *settleAndProvision() {
    log("POST", `/lsp/v1/orders/${short(TRANSCRIPT.order_id, 8)}/settle`);
    await sleep(400);
    log("rpc", "get_invoice → status: Paid ✓");
    yield { state: "opening" };
    await sleep(500);
    log("rpc", "connect_peer + open_channel (funding_udt_type_script = RUSD)");
    await sleep(900);
    log("rpc", "list_channels → ChannelReady");
    yield { state: "channel_active", channel_outpoint: TRANSCRIPT.channel_outpoint };
  },
  async receive() {
    log("rpc", "new_invoice (client, 5 RUSD)  →  send_payment (LSP)");
    await sleep(700);
    log("rpc", `get_payment → Success  ${short(TRANSCRIPT.receive.payment_hash, 8)}`);
    return TRANSCRIPT.receive;
  },
  async liquidity() {
    log("GET", "/lsp/v1/liquidity");
    await sleep(300);
    return TRANSCRIPT.liquidity;
  },
};

// Live: talk to a running reference server. The receive step needs the second node, so it stays replayed.
function liveDriver(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (method, path, body) => {
    log(method, path);
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (res.status >= 400) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  };
  return {
    mode: "live",
    getInfo: () => call("GET", "/lsp/v1/info"),
    createOrder: (req) => call("POST", "/lsp/v1/orders", req),
    async *settleAndProvision(order) {
      const settled = await call("POST", `/lsp/v1/orders/${order.order_id}/settle`);
      yield { state: settled.state, channel_outpoint: settled.channel_outpoint };
    },
    receive: () => replayDriver.receive(), // requires the client node; replayed
    liquidity: () => call("GET", "/lsp/v1/liquidity"),
  };
}

function currentDriver() {
  if ($("#mode-live").checked) {
    const url = $("#live-url").value.trim() || "http://127.0.0.1:8080";
    return liveDriver(url);
  }
  return replayDriver;
}

// ---- flow rendering ---------------------------------------------------------
function step(title) {
  const el = document.createElement("div");
  el.className = "step running";
  el.innerHTML = `<div class="step-head"><span class="spin"></span><b>${title}</b></div><div class="step-body"></div>`;
  $("#flow").append(el);
  return {
    body: (html) => (el.querySelector(".step-body").innerHTML = html),
    done: () => el.classList.replace("running", "done"),
    fail: (m) => {
      el.classList.replace("running", "failed");
      el.querySelector(".step-body").innerHTML = `<span class="err">${m}</span>`;
    },
  };
}

function offeringCard(o) {
  const badge = o.asset.kind === "CKB" ? "ckb" : "rusd";
  const prop = o.fee_schedule.proportional_bps ? ` + ${o.fee_schedule.proportional_bps / 100}%` : "";
  return `<div class="offer ${badge}">
    <div class="offer-asset">${assetLabel(o.asset)}</div>
    <div class="offer-row"><span>min</span><b>${fmt(o.min_capacity, o.asset)}</b></div>
    <div class="offer-row"><span>max</span><b>${fmt(o.max_capacity, o.asset)}</b></div>
    <div class="offer-row"><span>fee</span><b>${fmt(o.fee_schedule.base_fee, { kind: "CKB" })}${prop}</b></div>
  </div>`;
}

function liquidityBars(snap) {
  const max = snap.assets.reduce((m, a) => Math.max(m, Number(BigInt(a.outbound) + BigInt(a.inbound))), 1);
  return snap.assets
    .map((a) => {
      const out = Number(BigInt(a.outbound));
      const inb = Number(BigInt(a.inbound));
      return `<div class="liq-row">
        <div class="liq-label">${assetLabel(a.asset)} <span>${a.ready_channel_count}/${a.channel_count} ready</span></div>
        <div class="liq-bar">
          <div class="liq-out" style="width:${(out / max) * 100}%" title="outbound ${fmt(a.outbound, a.asset)}"></div>
          <div class="liq-in" style="width:${(inb / max) * 100}%" title="inbound ${fmt(a.inbound, a.asset)}"></div>
        </div>
        <div class="liq-nums"><span class="dot out"></span>${fmt(a.outbound, a.asset)} out
          <span class="dot in"></span>${fmt(a.inbound, a.asset)} in</div>
      </div>`;
    })
    .join("");
}

async function animateBalance(el, fromAmt, toAmt, asset) {
  const from = Number(BigInt(fromAmt)) / Number(SHANNONS);
  const to = Number(BigInt(toAmt)) / Number(SHANNONS);
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const v = from + ((to - from) * i) / steps;
    el.textContent = `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${assetLabel(asset)}`;
    await sleep(28);
  }
}

// ---- controller -------------------------------------------------------------
let running = false;
async function run() {
  if (running) return;
  running = true;
  reset(true);
  const driver = currentDriver();
  $("#mode-badge").textContent = driver.mode.toUpperCase();
  $("#mode-badge").className = `mode-badge ${driver.mode}`;

  try {
    // 1. connect
    const s1 = step("1 · Connect to LSP");
    const info = await driver.getInfo();
    $("#offering-body").innerHTML = info.supported_assets.map(offeringCard).join("");
    s1.body(`LSP <code>${short(info.lsp_pubkey)}</code> on <b>${info.chain}</b> · ${info.supported_assets.length} assets offered`);
    s1.done();

    // 2. order (buy 10 RUSD inbound, prepaid)
    const s2 = step("2 · Buy 10 RUSD inbound (client funds 0)");
    const req = TRANSCRIPT.request;
    let order = await driver.createOrder(req);
    s2.body(`order <code>${short(order.order_id, 8)}</code> · state <b>${order.state}</b> · fee ${fmt(order.fee.total_fee, { kind: "CKB" })} (CKB)`);
    s2.done();

    // 3. pay fee + provision
    const s3 = step("3 · Pay CKB fee → provision channel");
    for await (const patch of driver.settleAndProvision(order)) {
      order = { ...order, ...patch };
      if (patch.state === "opening") s3.body(`fee settled · <b>opening</b> — funding tx propagating…`);
      if (patch.state === "channel_active")
        s3.body(`<b class="ok">channel_active</b> · outpoint <code>${short(order.channel_outpoint, 12)}</code>`);
    }
    if (order.state !== "channel_active") throw new Error(order.failure_reason ?? "provisioning failed");
    s3.done();

    // 4. the money shot — receive 5 RUSD over inbound bought with zero RUSD
    const s4 = step("4 · Receive 5 RUSD over the purchased inbound");
    $("#hero").classList.add("show");
    const rusd = req.asset;
    $("#hero-sub").textContent = "client spendable RUSD";
    await animateBalance($("#hero-balance"), "0", "0", rusd);
    const recv = await driver.receive();
    await animateBalance($("#hero-balance"), recv.before, recv.after, rusd);
    $("#hero-note").innerHTML = `received <b>${fmt(recv.amount, rusd)}</b> · <code>${short(recv.payment_hash, 8)}</code> — having never held any RUSD`;
    s4.body(`spendable RUSD <b>0 → ${fmt(recv.after, rusd)}</b> · payment <b class="ok">Success</b>`);
    s4.done();

    // 5. liquidity dashboard
    const s5 = step("5 · LSP liquidity snapshot");
    const snap = await driver.liquidity();
    $("#liquidity-body").innerHTML = liquidityBars(snap);
    s5.body(`${snap.assets.length} assets · per-asset inbound/outbound capacity`);
    s5.done();

    log("done", "flow complete ✓");
  } catch (e) {
    log("err", e.message);
    const s = step("error");
    s.fail(e.message);
  } finally {
    running = false;
  }
}

function reset(keepOffering = false) {
  $("#flow").innerHTML = "";
  $("#liquidity-body").innerHTML = "";
  $("#hero").classList.remove("show");
  $("#hero-balance").textContent = "0 RUSD";
  $("#hero-note").textContent = "";
  if (!keepOffering) $("#offering-body").innerHTML = "";
  $("#log").innerHTML = "";
}

// ---- wire up ----------------------------------------------------------------
$("#run").addEventListener("click", run);
$("#reset").addEventListener("click", () => reset(false));
$("#mode-live").addEventListener("change", () => $("#live-url").classList.toggle("hidden", !$("#mode-live").checked));
$("#mode-replay").addEventListener("change", () => $("#live-url").classList.add("hidden"));

// Deep-link auto-play (handy for demos, screenshots, and hosted previews): ?autorun=1
if (new URLSearchParams(location.search).get("autorun")) run();
