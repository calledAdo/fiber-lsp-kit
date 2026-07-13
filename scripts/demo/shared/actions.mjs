import { loadState } from "./state.mjs";

async function post(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `request failed with HTTP ${response.status}`);
  return result;
}

export async function requestJitInvoice(cfg, args = process.argv.slice(2)) {
  const [amountArg, capacityArg] = args;
  const body = {};
  if (amountArg !== undefined) body.amount = cfg.toBase(amountArg);
  if (capacityArg !== undefined) body.capacity = cfg.toBase(capacityArg);

  const result = await post(`http://127.0.0.1:${cfg.control.merchant}/request-invoice`, body);
  console.log(`hold invoice (the customer pays this):\n  ${result.invoice}`);
  console.log(`merchant nets ${cfg.fmt(result.netAmount)} (fee ${cfg.fmt(result.fee)})`);
  console.log(`next: npm run ${cfg.commands.pay}`);
  return result;
}

export async function payCurrentJitInvoice(cfg) {
  const hold = loadState(cfg, "jit-hold");
  if (!hold) throw new Error(`no hold invoice yet; run npm run ${cfg.commands.invoice}`);
  const result = await post(`http://127.0.0.1:${cfg.control.customer}/pay`, { invoice: hold.invoice });
  console.log(`payment: ${result.status}`);
  if (result.status !== "Success") throw new Error(`JIT payment ended as ${result.status}`);
  console.log("the merchant received a channel-backed payment and a channel");
  return result;
}

export async function streamRent(cfg) {
  const result = await post(`http://127.0.0.1:${cfg.control.merchant}/stream-rent`);
  for (const payment of result.payments ?? []) {
    const detail = payment.status === "paid"
      ? `paid ${cfg.fmt(payment.amount)}`
      : `skipped: ${payment.reason ?? "unknown reason"}`;
    console.log(`rent period ${payment.period}: ${detail}`);
  }
  console.log(`rent streamed: ${result.periodsPaid} live-priced period(s), total ${cfg.fmt(result.totalPaid)}`);
  if (result.periodsPaid === 0) throw new Error("no rent period settled; inspect the skipped reasons above");
  return result;
}
