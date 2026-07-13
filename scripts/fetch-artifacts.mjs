#!/usr/bin/env node
/**
 * Download and verify the `linked` JIT release artifacts, so a merchant (or LSP) runs one command instead of
 * hand-curling. Dependency-free: Node built-ins only.
 *
 *   node scripts/fetch-artifacts.mjs --release <base-url> [--out ./linkage-artifacts] [--role merchant|lsp]
 *
 *   --release   Base URL of the GitHub release assets (the folder the files live under). Required.
 *   --out       Directory to write into. Default ./linkage-artifacts.
 *   --role      "merchant" (default) fetches the proving key + circuit; "lsp" fetches the verification key.
 *
 * Every file is checked against the release SHA256SUMS before it is kept. `same_hash` needs none of this.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : def;
};

const release = opt("release");
const role = opt("role", "merchant");
const outDir = resolve(opt("out", "./linkage-artifacts"));
if (!release) {
  console.error("usage: fetch-artifacts.mjs --release <base-url> [--out ./linkage-artifacts] [--role merchant|lsp]");
  process.exit(2);
}
if (role !== "merchant" && role !== "lsp") {
  console.error(`--role must be "merchant" or "lsp", got ${role}`);
  process.exit(2);
}

const base = release.replace(/\/+$/, "");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const get = async (name) => {
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`GET ${name} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// The release lists every asset's hash in SHA256SUMS (`<hash>  <filename>`), so fetch it once and check against it.
const sumsText = (await get("SHA256SUMS")).toString("utf8");
const sums = new Map(
  sumsText
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.trim().split(/\s+/);
      return [rest.join(" "), hash];
    }),
);

const verify = (name, buf) => {
  const want = sums.get(name);
  if (!want) throw new Error(`${name} is not listed in SHA256SUMS — refusing to trust it`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name} checksum mismatch:\n  expected ${want}\n  got      ${got}`);
};

/** Fetch, verify against SHA256SUMS, and (if gzipped) gunzip. Returns the bytes written and the on-disk name. */
const fetchVerified = async (name) => {
  const buf = await get(name);
  verify(name, buf);
  if (name.endsWith(".gz")) {
    return { name: name.slice(0, -3), bytes: gunzipSync(buf) };
  }
  return { name, bytes: buf };
};

const wanted = role === "merchant" ? ["linkage.ark.gz", "linkage.wasm"] : ["verification_key.json"];

await mkdir(outDir, { recursive: true });
console.log(`fetching ${role} artifacts from ${base} → ${outDir}`);
for (const asset of wanted) {
  const { name, bytes } = await fetchVerified(asset);
  await writeFile(join(outDir, name), bytes);
  console.log(`  ✓ ${name.padEnd(24)} ${(bytes.length / 1048576).toFixed(2)} MB  (sha256 verified)`);
}

if (role === "merchant") {
  console.log(`\nPoint the prover at them:`);
  console.log(`  makeLinkedProver({ zkeyPath: "${join(outDir, "linkage.ark")}", wasmPath: "${join(outDir, "linkage.wasm")}" })`);
} else {
  console.log(`\nEnable verification:`);
  console.log(`  LINKED_JIT_VK_PATH=${join(outDir, "verification_key.json")} npm run example:lsp`);
}
