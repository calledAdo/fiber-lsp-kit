import { loadScenarioConfig } from "../shared/config.mjs";

const mockNodes = {
  hold: { rpc: "http://127.0.0.1:9227", port: 9227 },
  payment: { rpc: "http://127.0.0.1:9327", port: 9327 },
  merchant: { rpc: "http://127.0.0.1:9247", p2p: "/ip4/127.0.0.1/tcp/9247", port: 9247 },
  customer: { rpc: "http://127.0.0.1:9237", port: 9237 },
};

export function loadConfig() {
  const cfg = loadScenarioConfig(new URL("./demo.config.json", import.meta.url), {
    mockNodes,
    requiredFields: ["hold.rpc", "payment.rpc", "merchant.rpc", "merchant.p2p", "customer.rpc"],
  });
  cfg.commands = {
    invoice: "demo:same-hash:invoice",
    pay: "demo:same-hash:pay",
  };
  return cfg;
}
