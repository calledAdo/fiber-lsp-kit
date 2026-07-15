import { parseArgs } from "node:util";

import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { demoConsole, shortId } from "./console.mjs";
import { createDemoOperations } from "./operations.mjs";
import {
  formatNodeState,
  inspectNodeState,
} from "./node-state.mjs";

function commandOptions(args, options) {
  return parseArgs({ args, options, allowPositionals: false, strict: true }).values;
}

export function parseInvoiceCommandArgs(args) {
  const values = commandOptions(args, {
    amount: { type: "string" },
    capacity: { type: "string" },
  });
  if (!values.amount) throw new Error("--amount is required");
  if (!values.capacity) throw new Error("--capacity is required");
  return { amount: values.amount, capacity: values.capacity };
}

export function parsePayCommandArgs(args) {
  const values = commandOptions(args, {
    invoice: { type: "string" },
    latest: { type: "boolean", default: false },
  });
  if (values.invoice && values.latest) throw new Error("use only one of --invoice or --latest");
  if (!values.invoice && !values.latest) throw new Error("provide --invoice <invoice> or --latest");
  return { invoice: values.invoice, latest: values.latest };
}

export function parseRegularInvoiceCommandArgs(args) {
  const values = commandOptions(args, { amount: { type: "string" } });
  if (!values.amount) throw new Error("--amount is required");
  return { amount: values.amount };
}

export function parseRentCommandArgs(args) {
  const values = commandOptions(args, {
    channel: { type: "string" },
    latest: { type: "boolean", default: false },
    periods: { type: "string", default: "3" },
  });
  if (values.channel && values.latest) throw new Error("use only one of --channel or --latest");
  if (!values.channel && !values.latest) throw new Error("provide --channel <channel-id> or --latest");
  if (!/^[1-9]\d*$/.test(values.periods)) throw new Error("--periods must be a positive integer");
  return { channelId: values.channel, latest: values.latest, periods: Number(values.periods) };
}

export async function requestJitInvoice(cfg, args = process.argv.slice(2)) {
  const command = parseInvoiceCommandArgs(args);
  const operations = createDemoOperations(cfg, {
    onStage: (_kind, detail) => {
      demoConsole.ok("Customer path ready", `${cfg.fmt(detail.customerLimit)} maximum payment`);
      demoConsole.run(
        "Creating hold invoice",
        `${cfg.fmt(detail.amount)} payment · ${cfg.fmt(detail.capacity)} channel`,
      );
    },
  });
  const result = await operations.requestInvoice(command);
  const { analysis } = result;
  demoConsole.ok("Hold invoice ready", `${cfg.fmt(analysis.amount)} · ${analysis.currency ?? "unknown currency"}`);
  demoConsole.detail(`payment hash ${shortId(analysis.paymentHash)}`);
  demoConsole.raw("\nCustomer invoice:");
  demoConsole.raw(result.invoice);
  demoConsole.raw();
  demoConsole.ok("Merchant net amount", `${cfg.fmt(result.netAmount)} · fee ${cfg.fmt(result.fee)}`);
  demoConsole.info("Next", `npm run ${cfg.commands.pay} -- --latest`);
  return { ...result, analysis };
}

export async function payCurrentJitInvoice(cfg, args = process.argv.slice(2)) {
  const command = parsePayCommandArgs(args);
  const operations = createDemoOperations(cfg, {
    onStage: (_kind, detail) => demoConsole.run(
      "Paying hold invoice",
      `${cfg.fmt(detail.analysis.amount)} · ${shortId(detail.analysis.paymentHash)}`,
    ),
  });
  const result = await operations.payInvoice(command);
  demoConsole.ok("Atomic checkout settled", "merchant payment and channel confirmed");
  demoConsole.info("Inspect updated nodes", `npm run ${cfg.commands.status}`);
  return result;
}

export async function requestRegularInvoice(cfg, args = process.argv.slice(2)) {
  const command = parseRegularInvoiceCommandArgs(args);
  const operations = createDemoOperations(cfg, {
    onStage: (_kind, detail) => demoConsole.run("Creating regular invoice", cfg.fmt(detail.amount)),
  });
  const result = await operations.requestRegularInvoice(command);
  demoConsole.ok("Regular invoice ready", cfg.fmt(result.amount));
  demoConsole.detail(`payment hash ${shortId(result.paymentHash)}`);
  demoConsole.raw("\nCustomer invoice:");
  demoConsole.raw(result.invoice);
  demoConsole.raw();
  demoConsole.info("Next", `npm run ${cfg.commands.regularPay} -- --latest`);
  return result;
}

export async function payCurrentRegularInvoice(cfg, args = process.argv.slice(2)) {
  const command = parsePayCommandArgs(args);
  const operations = createDemoOperations(cfg, {
    onStage: () => demoConsole.run("Paying regular invoice", "checking Fiber route before dispatch"),
  });
  const result = await operations.payRegularInvoice(command);
  demoConsole.ok("Regular payment settled", `${result.elapsedMs} ms · merchant invoice ${result.invoiceStatus}`);
  demoConsole.info("Routing fee", result.fee ? cfg.fmt(BigInt(result.fee)) : "not reported");
  return result;
}

export async function streamRent(cfg, args = process.argv.slice(2)) {
  const command = parseRentCommandArgs(args);
  const operations = createDemoOperations(cfg, {
    onStage: (_kind, detail) => demoConsole.run(
      "Streaming channel rent",
      `${detail.periods} period(s) · ${shortId(detail.channelId)}`,
    ),
  });
  const result = await operations.streamRent(command);
  demoConsole.ok("Channel bound", `${shortId(result.channelId)} · capacity ${cfg.fmt(result.capacity)}`);
  demoConsole.detail(
    `initial inbound ${cfg.fmt(result.initialRent.remainingInbound)} · rent ${cfg.fmt(result.initialRent.amount)}`,
  );
  for (const payment of result.payments ?? []) {
    if (payment.status === "paid") {
      demoConsole.ok(`Rent period ${payment.period}`, `${cfg.fmt(payment.amount)} paid`);
    } else {
      demoConsole.warn(
        `Rent period ${payment.period} skipped`,
        `${payment.reason ?? "unknown reason"}` +
          (payment.payment_hash ? ` · reconcile ${shortId(payment.payment_hash)}` : ""),
      );
    }
  }
  demoConsole.ok("Rent stream complete", `${result.periodsPaid} period(s) · ${cfg.fmt(result.totalPaid)} total`);
  if (result.periodsPaid === 0) throw new Error("no rent period settled; inspect the skipped reasons above");
  return result;
}

export async function showDemoStatus(cfg) {
  const rpcs = Object.fromEntries(
    Object.entries(cfg.topology.nodes).map(([role, node]) => [
      role,
      new FiberChannelRpcClient({ rpcUrl: node.rpc }),
    ]),
  );
  const holdInfo = await rpcs[cfg.holdRole].nodeInfo();
  const hold = holdInfo.pubkey ?? holdInfo.node_id ?? holdInfo.public_key;
  if (!hold) throw new Error("hold node_info returned no pubkey");
  const states = await Promise.all(Object.entries(rpcs).map(([role, rpc]) =>
    inspectNodeState({ role, rpc, asset: cfg.asset, focusPeer: role === "customer" ? hold : undefined }),
  ));
  demoConsole.heading(`${cfg.mode === "linked" ? "Linked" : "Same-hash"} JIT`, "Full node status");
  demoConsole.info("Profile", cfg.topology.profile);
  demoConsole.raw(states.map((state) => formatNodeState(state, cfg)).join("\n\n"));
  return states;
}
