import { requestJitInvoice } from "../../shared/actions.mjs";
import { loadConfig } from "../config.mjs";

await requestJitInvoice(loadConfig());
