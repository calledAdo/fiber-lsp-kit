import { payCurrentJitInvoice } from "../../shared/actions.mjs";
import { loadConfig } from "../config.mjs";

await payCurrentJitInvoice(loadConfig());
