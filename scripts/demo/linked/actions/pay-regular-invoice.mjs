import { payCurrentRegularInvoice } from "../../shared/actions.mjs";
import { loadConfig } from "../config.mjs";

await payCurrentRegularInvoice(loadConfig());
