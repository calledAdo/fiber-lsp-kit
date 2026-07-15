import { requestRegularInvoice } from "../../shared/actions.mjs";
import { loadConfig } from "../config.mjs";

await requestRegularInvoice(loadConfig());
