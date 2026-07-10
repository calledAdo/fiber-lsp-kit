#!/usr/bin/env node
/**
 * Assemble the release assets for `linked` JIT, and write the manifest an integrator checks against.
 *
 * `same_hash` JIT needs none of this — no key, no circuit, no prover. These artifacts exist only so a merchant
 * can prove to a single-node LSP.
 *
 *   node scripts/release/build-artifacts.mjs [--out dist/release]
 *
 * Emits, from the built circuit:
 *   verification_key.json          the LSP downloads this, and nothing else
 *   linkage.zkey.gz                the merchant's proving key (gzip halves the download)
 *   linkage.wasm                   the circuit, for witness generation
 *   MANIFEST.md                    what each file is for, and who needs it
 *   SHA256SUMS                     `sha256sum -c SHA256SUMS` after downloading
 *
 * The `.r1cs` and the ptau are NOT copied here. They are needed only to audit the ceremony, and the ptau must
 * be fetched from its public source rather than a mirror of ours — see docs/CEREMONY.md.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const build = join(root, "packages/protocol/circuits/dual-sha256-linkage/build");
const outIdx = process.argv.indexOf("--out");
const out = resolve(root, outIdx > -1 ? process.argv[outIdx + 1] : "dist/release");

const sources = {
  vk: join(build, "verification_key.json"),
  zkey: join(build, "dual_sha256_linkage_final.zkey"),
  wasm: join(build, "dual_sha256_linkage_js/dual_sha256_linkage.wasm"),
  r1cs: join(build, "dual_sha256_linkage.r1cs"),
};

for (const [name, path] of Object.entries(sources)) {
  try {
    await stat(path);
  } catch {
    console.error(`missing ${name}: ${path}`);
    console.error("build the circuit first — see packages/protocol/circuits/dual-sha256-linkage/README.md");
    process.exit(1);
  }
}

const sha256 = async (path) => {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
};
const size = async (path) => (await stat(path)).size;
const mb = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

await mkdir(out, { recursive: true });
await copyFile(sources.vk, join(out, "verification_key.json"));
await copyFile(sources.wasm, join(out, "linkage.wasm"));
await pipeline(createReadStream(sources.zkey), createGzip({ level: 9 }), createWriteStream(join(out, "linkage.zkey.gz")));

// The circuit hash identifies the statement. The vk and zkey must be a matched pair from one setup over it.
const r1csHash = await sha256(sources.r1cs);
const zkeyHash = await sha256(sources.zkey);

const assets = [
  ["verification_key.json", "LSP", "Set `LINKED_JIT_VK_PATH` to it. Nothing else to install."],
  ["linkage.zkey.gz", "merchant", `Proving key. \`gunzip\` → ${mb(await size(sources.zkey))}.`],
  ["linkage.wasm", "merchant", "The circuit, for witness generation. No other circom output is needed."],
];

const rows = [];
for (const [file, who, note] of assets) {
  const p = join(out, file);
  rows.push(`| \`${file}\` | ${who} | ${mb(await size(p))} | ${await sha256(p)} | ${note} |`);
}

await writeFile(
  join(out, "SHA256SUMS"),
  (await Promise.all(assets.map(async ([f]) => `${await sha256(join(out, f))}  ${f}`))).join("\n") + "\n",
);

await writeFile(
  join(out, "MANIFEST.md"),
  `# Linkage artifacts

These exist **only** so a merchant can prove linkage to an LSP that runs a single Fiber node (\`linked\` JIT
mode). An LSP that runs two nodes serves \`same_hash\` instead, where there is no proof, no key, and no
download on either side.

Verify everything before use:

\`\`\`bash
sha256sum -c SHA256SUMS
\`\`\`

| Asset | Who needs it | Size | SHA-256 | Notes |
|---|---|---|---|---|
${rows.join("\n")}

The **circuit** these are bound to:

| | SHA-256 |
|---|---|
| \`dual_sha256_linkage.r1cs\` | \`${r1csHash}\` |
| \`dual_sha256_linkage_final.zkey\` (uncompressed) | \`${zkeyHash}\` |

\`verification_key.json\` and the \`.zkey\` **must be a matched pair from the same setup over this circuit.**
Mixing them fails every proof, silently, at the LSP.

## Merchant setup

\`\`\`bash
npm i @fiberlsp/client @fiberlsp/prover-linked
curl -LO <release>/linkage.zkey.gz && gunzip linkage.zkey.gz
curl -LO <release>/linkage.wasm
\`\`\`

Then supply the hook. A prover binary is needed; \`linkage-prover\` (in \`tools/\`) and \`rapidsnark\` both work,
and the LSP cannot tell which produced the proof:

\`\`\`ts
import { makeLinkedProver } from "@fiberlsp/prover-linked";

const proveLinkage = makeLinkedProver({
  zkeyPath: "./linkage.zkey",
  wasmPath: "./linkage.wasm",
  proverPath: process.env.FIBERLSP_LINKED_PROVER, // or leave unset and put \`linkage-prover\` on PATH
});
\`\`\`

That is the whole setup. There is no conversion step to run.

## Why no pre-converted key is published

Loading a \`.zkey\` revalidates every curve point, which costs roughly 4× a proof. \`makeLinkedProver\` therefore
converts it to the prover's native form on first use and caches the result beside the \`.zkey\`, keyed to its
SHA-256. First proof ~6.4 s, every proof after ~1.1 s. Rotating the key invalidates the cache automatically, and
a corrupt cache is discarded and rebuilt rather than failing an order. Pass \`cache: false\` for \`rapidsnark\`,
which reads only the \`.zkey\`.

The converted key is deliberately **not** a release asset, even though it compresses to about the same size:

- **No other prover can read it.** \`rapidsnark\` rejects it outright. Publishing it as the artifact would lock
  every merchant into one implementation.
- **It cannot be audited.** \`zkey verify\` takes \`<r1cs> <ptau> <zkey>\`; there is no converted-key input. A
  merchant downloading one could not check it derives from the published ceremony — they would be trusting our
  conversion instead of the transcript.
- **It is arkworks' internal serialization**, with no cross-version guarantee, and it is loaded without curve
  validation precisely because the local machine produced it from a \`.zkey\` it already validated.

The \`.zkey\` is the ceremony's artifact. The converted key is a derived cache, and caches belong on the machine
that built them.

## LSP setup

\`\`\`bash
npm i @fiberlsp/server
curl -LO <release>/verification_key.json
LINKED_JIT_VK_PATH=./verification_key.json npm run server
\`\`\`

Verification is built in (\`@noble/curves\`); there is no proof-system dependency.

## The setup this key came from

Groth16 needs a circuit-specific phase 2, and its soundness requires **at least one** contributor to have
destroyed their entropy. A backdoored key lets a merchant forge linkage and steal from the LSP — so this is the
LSP's trust assumption, not the merchant's.

Phase 1 is the public Perpetual Powers of Tau, so no phase-1 secret is ours. **Phase 2 is a single development
contribution. It must not be trusted with real funds.** Publish the contribution chain, each attestation, and
the final beacon alongside these assets, and see [\`docs/CEREMONY.md\`](../../docs/CEREMONY.md).

Auditing the ceremony additionally needs \`dual_sha256_linkage.r1cs\` and the ptau, fetched from its public
source rather than any mirror.
`,
);

console.log(`wrote ${out}`);
for (const [file] of assets) console.log(`  ${file.padEnd(24)} ${mb(await size(join(out, file)))}`);
console.log(`  ${"MANIFEST.md".padEnd(24)}`);
console.log(`  ${"SHA256SUMS".padEnd(24)}`);
