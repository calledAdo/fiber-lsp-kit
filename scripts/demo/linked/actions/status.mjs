import { showDemoStatus } from "../../shared/actions.mjs";
import { loadConfig } from "../config.mjs";

await showDemoStatus(loadConfig());
