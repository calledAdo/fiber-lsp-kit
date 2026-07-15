import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { demoConsole } from "./console.mjs";
import { createCkbAssetBalanceProvider } from "./ckb-balance.mjs";
import { collectDashboardSnapshot } from "./dashboard-data.mjs";
import { createDemoOperations } from "./operations.mjs";

const dashboardRoot = new URL("../dashboard/", import.meta.url);

export function loadDashboardAssets() {
  return {
    "/": {
      type: "text/html; charset=utf-8",
      body: readFileSync(new URL("index.html", dashboardRoot), "utf8"),
    },
    "/dashboard.css": {
      type: "text/css; charset=utf-8",
      body: readFileSync(new URL("dashboard.css", dashboardRoot), "utf8"),
    },
    "/dashboard.js": {
      type: "text/javascript; charset=utf-8",
      body: readFileSync(new URL("dashboard.js", dashboardRoot), "utf8"),
    },
  };
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function actionError(message) {
  const error = new Error(message);
  error.code = "action_busy";
  return error;
}

const activityMessages = {
  invoice: {
    running: "Building proof and creating the hold invoice",
    success: "Hold invoice ready",
  },
  pay: {
    running: "Paying the customer invoice and waiting for settlement",
    success: "Atomic checkout settled",
  },
  "regular-invoice": {
    running: "Checking merchant inbound and creating a regular invoice",
    success: "Regular invoice ready",
  },
  "regular-pay": {
    running: "Checking the route and waiting for merchant confirmation",
    success: "Regular payment settled",
  },
  rent: {
    running: "Pricing and paying channel rent",
    success: "Rent payment complete",
  },
  reset: {
    running: "Resetting the shared simulation",
    success: "Simulation reset",
  },
};

export function createDashboardActionController(operations, {
  now = Date.now,
  reset,
  onActivity = () => {},
} = {}) {
  let current = { kind: undefined, status: "idle", startedAt: undefined, finishedAt: undefined, message: undefined };

  async function run(kind, operation, input) {
    if (current.status === "running") throw actionError(`${current.kind} action already in progress`);
    onActivity(kind);
    current = {
      kind,
      status: "running",
      startedAt: new Date(now()).toISOString(),
      finishedAt: undefined,
      message: activityMessages[kind].running,
    };
    try {
      const result = await operation(input);
      current = {
        ...current,
        status: "success",
        finishedAt: new Date(now()).toISOString(),
        message: activityMessages[kind].success,
      };
      return result;
    } catch (error) {
      current = {
        ...current,
        status: "error",
        finishedAt: new Date(now()).toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  return {
    requestInvoice: (input) => run("invoice", operations.requestInvoice, input),
    payInvoice: (input) => run("pay", operations.payInvoice, input),
    requestRegularInvoice: (input) => run("regular-invoice", operations.requestRegularInvoice, input),
    payRegularInvoice: (input) => run("regular-pay", operations.payRegularInvoice, input),
    streamRent: (input) => run("rent", operations.streamRent, input),
    ...(reset ? { resetDemo: (input) => run("reset", reset, input) } : {}),
    activity: () => {
      const started = current.startedAt ? Date.parse(current.startedAt) : undefined;
      const finished = current.finishedAt ? Date.parse(current.finishedAt) : now();
      return {
        ...current,
        elapsedMs: started === undefined ? undefined : Math.max(0, finished - started),
      };
    },
  };
}

const actionRoutes = {
  "/api/actions/invoice": "requestInvoice",
  "/api/actions/pay": "payInvoice",
  "/api/actions/regular-invoice": "requestRegularInvoice",
  "/api/actions/regular-pay": "payRegularInvoice",
  "/api/actions/rent": "streamRent",
  "/api/actions/reset": "resetDemo",
};

export async function routeDashboardRequest({ method, path, headers = {}, body, assets, snapshot, actions, health }) {
  if (method === "GET" && path === "/health") {
    try {
      const result = health ? await health() : { ready: true };
      return json(result.ready === false ? 503 : 200, result);
    } catch (error) {
      return json(503, { ready: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (method === "GET" && path === "/api/snapshot") {
    try {
      return json(200, await snapshot());
    } catch (error) {
      return json(503, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (method === "GET") {
    const asset = assets[path];
    if (!asset) return json(404, { error: "not found" });
    return {
      status: 200,
      headers: { "content-type": asset.type, "cache-control": "no-store" },
      body: asset.body,
    };
  }
  if (method !== "POST" || !actionRoutes[path]) return json(405, { error: "method not allowed" });
  const action = actions?.[actionRoutes[path]];
  if (!action) return json(404, { error: "action not available" });
  if (headers["x-demo-action"] !== "1") return json(403, { error: "missing demo action guard" });
  if (!String(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return json(415, { error: "actions require application/json" });
  }
  try {
    const result = await action(body ?? {});
    return json(200, { ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(error?.code === "action_busy" ? 409 : 400, { error: message });
  }
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

export function startDashboardServer(cfg, {
  host = "127.0.0.1",
  port = cfg.control.dashboard,
  assets = loadDashboardAssets(),
  snapshot,
  operations = createDemoOperations(cfg),
  balanceProvider,
  hosted = false,
  reset,
  onActivity,
  health,
} = {}) {
  const actions = createDashboardActionController(operations, { reset, onActivity });
  const effectiveBalanceProvider = balanceProvider ?? (
    cfg.topology.profile === "live" && cfg.ckbRpc
      ? createCkbAssetBalanceProvider({ rpcUrl: cfg.ckbRpc })
      : undefined
  );
  const collectSnapshot = snapshot ?? (() => collectDashboardSnapshot(cfg, { balanceProvider: effectiveBalanceProvider }));
  const collect = async () => ({
    ...(await collectSnapshot()),
    deployment: {
      hosted,
      transport: cfg.topology.profile === "mock" ? "simulated-fnn" : "live-fnn",
    },
  });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://${host}`).pathname;
    let response;
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      response = await routeDashboardRequest({
        method: req.method ?? "GET",
        path,
        headers: req.headers,
        body,
        assets,
        actions,
        snapshot: async () => ({ ...(await collect()), activity: actions.activity() }),
        health: health ?? (async () => ({ ready: true, profile: cfg.topology.profile })),
      });
    } catch (error) {
      response = json(400, { error: error instanceof Error ? error.message : String(error) });
    }
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
  server.listen(port, host, () => {
    demoConsole.heading(cfg.mode === "linked" ? "Linked JIT" : "Same-hash JIT", "Live dashboard");
    demoConsole.run("Dashboard ready", `http://${host}:${port}`);
    demoConsole.info("Mode", "interactive demo adapter · refreshes every second");
  });
  server.demoActions = actions;
  return server;
}
