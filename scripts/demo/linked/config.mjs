import { loadScenarioConfig } from "../shared/config.mjs";

const mockNodes = {
  lsp: { rpc: "http://127.0.0.1:9127", port: 9127 },
  merchant: { rpc: "http://127.0.0.1:9147", p2p: "/ip4/127.0.0.1/tcp/9147", port: 9147 },
  customer: { rpc: "http://127.0.0.1:9137", port: 9137 },
};

export function loadConfig() {
  const cfg = loadScenarioConfig(new URL("./demo.config.json", import.meta.url), {
    mockNodes,
    requiredFields: ["lsp.rpc", "merchant.rpc", "merchant.p2p", "customer.rpc"],
  });
  cfg.commands = {
    dashboard: "demo:linked:dashboard",
    invoice: "demo:linked:invoice",
    pay: "demo:linked:pay",
    regularInvoice: "demo:linked:regular-invoice",
    regularPay: "demo:linked:regular-pay",
    status: "demo:linked:status",
  };
  cfg.holdRole = "lsp";
  return cfg;
}
