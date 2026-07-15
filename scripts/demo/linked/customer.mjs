import { startCustomerServer } from "../shared/customer-server.mjs";
import { loadConfig } from "./config.mjs";

await startCustomerServer(loadConfig());
