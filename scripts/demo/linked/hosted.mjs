import { startDashboardServer } from "../shared/dashboard-server.mjs";
import { createDemoOperations } from "../shared/operations.mjs";
import {
  assertHostedMockConfig,
  createHostedOperations,
  createHostedProcessManager,
} from "../shared/hosted-runtime.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
assertHostedMockConfig(cfg);

const port = Number(process.env.PORT ?? 7104);
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`invalid PORT: ${process.env.PORT}`);
const resetAfterMs = Number(process.env.DEMO_RESET_MS ?? 10 * 60_000);
if (!Number.isSafeInteger(resetAfterMs) || resetAfterMs < 10_000) {
  throw new Error("DEMO_RESET_MS must be an integer of at least 10000");
}

const manager = createHostedProcessManager({ cfg });
await manager.start();

let resetTimer;
let actions;
function scheduleReset() {
  clearTimeout(resetTimer);
  resetTimer = setTimeout(async () => {
    try {
      await actions.resetDemo({ reason: "inactivity" });
    } catch {
      scheduleReset();
    }
  }, resetAfterMs);
  resetTimer.unref();
}

const dashboard = startDashboardServer(cfg, {
  host: "0.0.0.0",
  port,
  hosted: true,
  operations: createHostedOperations(createDemoOperations(cfg)),
  reset: () => manager.reset(),
  onActivity: scheduleReset,
  health: async () => manager.health(),
});
actions = dashboard.demoActions;
scheduleReset();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(resetTimer);
  await new Promise((resolve) => dashboard.close(resolve));
  await manager.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop().finally(() => process.exit(0));
  });
}
