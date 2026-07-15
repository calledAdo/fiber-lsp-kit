import { ensureArtifacts } from "../shared/artifacts.mjs";
import { assertHostedMockConfig } from "../shared/hosted-runtime.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
assertHostedMockConfig(cfg);
await ensureArtifacts("lsp", cfg);
await ensureArtifacts("merchant", cfg);
console.log("hosted linked artifacts ready");
