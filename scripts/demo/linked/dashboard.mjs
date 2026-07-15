import { startDashboardServer } from "../shared/dashboard-server.mjs";
import { loadConfig } from "./config.mjs";

startDashboardServer(loadConfig());
