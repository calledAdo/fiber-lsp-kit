# Modular Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the modular foundation for the architecture refactor by extracting FNN RPC into `@fiberlsp/fiber`, moving provider discovery into `@fiberlsp/registry`, and keeping existing client/server behavior compiling through explicit imports and compatibility re-exports.

**Architecture:** `@fiberlsp/protocol` becomes the contract package and no longer owns FNN JSON-RPC. `@fiberlsp/fiber` owns node/RPC primitives and depends on protocol for shared types. `@fiberlsp/registry` owns static provider registry and graph discovery, while `@fiberlsp/client` re-exports registry discovery for existing consumers.

**Tech Stack:** TypeScript project references, npm workspaces, Node `node:test`, FNN JSON-RPC wrapper, existing `tsx` test runner.

---

## Scope

This plan implements the first executable slice of the modular architecture. It does not move merchant checkout, LSP domain services, lease persistence, or JIT proof artifacts. Those belong in follow-up plans after this foundation compiles cleanly.

## File Structure

Create these new package roots:

```text
packages/fiber/
  package.json
  tsconfig.json
  src/index.ts
  src/rpc.ts
  test/rpc.test.ts

packages/registry/
  package.json
  tsconfig.json
  src/index.ts
  src/registry.ts
  src/graph.ts
  src/discover.ts
  test/registry.test.ts
```

Modify these existing files:

```text
package.json
packages/protocol/src/index.ts
packages/client/package.json
packages/client/tsconfig.json
packages/client/src/discover.ts
packages/client/src/quotes.ts
packages/client/src/index.ts
packages/client/test/discover.test.ts
packages/lsp-server/package.json
packages/lsp-server/tsconfig.json
packages/lsp-server/src/lsp.ts
packages/lsp-server/src/jit.ts
packages/lsp-server/src/server.ts
packages/lsp-server/test/mockRpc.ts
packages/lsp-server/test/*.test.ts
```

Delete this file after its contents have moved:

```text
packages/protocol/src/rpc.ts
```

---

### Task 1: Add Workspace Package Shells

**Files:**
- Modify: `package.json`
- Create: `packages/fiber/package.json`
- Create: `packages/fiber/tsconfig.json`
- Create: `packages/fiber/src/index.ts`
- Create: `packages/registry/package.json`
- Create: `packages/registry/tsconfig.json`
- Create: `packages/registry/src/index.ts`

- [ ] **Step 1: Add package metadata**

Create `packages/fiber/package.json`:

```json
{
  "name": "@fiberlsp/fiber",
  "version": "0.0.0",
  "description": "FNN JSON-RPC adapter and Fiber node utilities for Fiber LSP Kit.",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "@fiberlsp/protocol": "0.0.0"
  }
}
```

Create `packages/registry/package.json`:

```json
{
  "name": "@fiberlsp/registry",
  "version": "0.0.0",
  "description": "Static provider registry loading and graph discovery for Fiber LSP Kit.",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "@fiberlsp/fiber": "0.0.0",
    "@fiberlsp/protocol": "0.0.0"
  }
}
```

- [ ] **Step 2: Add TypeScript configs**

Create `packages/fiber/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [{ "path": "../protocol" }]
}
```

Create `packages/registry/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [{ "path": "../protocol" }, { "path": "../fiber" }]
}
```

- [ ] **Step 3: Add package entrypoints**

Create `packages/fiber/src/index.ts`:

```ts
export {};
```

Create `packages/registry/src/index.ts`:

```ts
export {};
```

- [ ] **Step 4: Update root build and test scripts**

Modify the root `package.json` scripts:

```json
{
  "scripts": {
    "build": "tsc -b packages/protocol packages/fiber packages/registry packages/lsp-server packages/client",
    "demo": "npm run build && node scripts/merchant-demo.mjs",
    "typecheck": "npm run build -- --dry 2>/dev/null; tsc -b packages/protocol packages/fiber packages/registry packages/lsp-server packages/client",
    "test": "npm run build && node --import tsx --test packages/*/test/*.test.ts",
    "test:live": "npm run build && node --import tsx --test packages/*/test/integration/*.test.ts",
    "server": "npm run build && npm -w @fiberlsp/server run start"
  }
}
```

Only replace the `scripts` object. Leave the rest of `package.json` unchanged.

- [ ] **Step 5: Refresh the workspace lockfile**

Run:

```bash
npm install --package-lock-only
```

Expected: `package-lock.json` records `packages/fiber` and `packages/registry` as workspaces without installing new external dependencies.

- [ ] **Step 6: Verify package shells build**

Run:

```bash
tsc -b packages/protocol packages/fiber packages/registry
```

Expected: pass. The new packages are empty shells at this point.

- [ ] **Step 7: Commit package shells**

Run:

```bash
git add package.json package-lock.json packages/fiber/package.json packages/fiber/tsconfig.json packages/fiber/src/index.ts packages/registry/package.json packages/registry/tsconfig.json packages/registry/src/index.ts
git commit -m "chore: add modular package shells"
```

---

### Task 2: Extract FNN RPC Into `@fiberlsp/fiber`

**Files:**
- Move: `packages/protocol/src/rpc.ts` -> `packages/fiber/src/rpc.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/fiber/src/index.ts`
- Create: `packages/fiber/test/rpc.test.ts`

- [ ] **Step 1: Write the failing fiber package test**

Create `packages/fiber/test/rpc.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";

test("openChannel serializes decimal funding as FNN hex", async () => {
  let captured: unknown;
  const rpc = new FiberChannelRpcClient({
    rpcUrl: "http://fnn.test",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return {
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { temporary_channel_id: "0xtemp" },
        }),
      };
    },
  });

  await rpc.openChannel({
    pubkey: "0x02aa",
    fundingAmount: "100000000",
    public: true,
  });

  assert.deepEqual(captured, {
    jsonrpc: "2.0",
    id: 1,
    method: "open_channel",
    params: [
      {
        pubkey: "0x02aa",
        funding_amount: "0x5f5e100",
        public: true,
      },
    ],
  });
});
```

- [ ] **Step 2: Run the failing fiber test**

Run:

```bash
node --import tsx --test packages/fiber/test/rpc.test.ts
```

Expected before implementation: fail with a module resolution error for `@fiberlsp/fiber` or a missing `rpc.ts` export.

- [ ] **Step 3: Move the RPC implementation**

Move the file:

```bash
git mv packages/protocol/src/rpc.ts packages/fiber/src/rpc.ts
```

In `packages/fiber/src/rpc.ts`, replace the local imports at the top:

```ts
import type { UdtTypeScript } from "./types.js";
import { asBig, toHex } from "./num.js";
```

with package imports:

```ts
import type { UdtTypeScript } from "@fiberlsp/protocol";
import { asBig, toHex } from "@fiberlsp/protocol";
```

- [ ] **Step 4: Remove the protocol RPC export**

In `packages/protocol/src/index.ts`, remove this line:

```ts
export * from "./rpc.js";
```

The rest of the exports stay in place.

- [ ] **Step 5: Verify the fiber entrypoint**

Keep `packages/fiber/src/index.ts` as:

```ts
export * from "./rpc.js";
```

- [ ] **Step 6: Run the fiber test**

Run:

```bash
npx tsc -b packages/protocol packages/fiber
node --import tsx --test packages/fiber/test/rpc.test.ts
```

Expected after implementation: the targeted build passes and the direct fiber test passes.

- [ ] **Step 7: Continue without committing**

Do not commit at this boundary. The full workspace will not compile until Task 3 migrates imports from
`@fiberlsp/protocol` to `@fiberlsp/fiber`.

---

### Task 3: Migrate Existing Imports To `@fiberlsp/fiber`

**Files:**
- Modify: `packages/client/package.json`
- Modify: `packages/client/tsconfig.json`
- Modify: `packages/client/src/InvoiceService.ts`
- Modify: `packages/client/src/JitCheckout.ts`
- Modify: `packages/client/src/LiquidityMonitor.ts`
- Modify: `packages/client/src/StreamingLease.ts`
- Modify: `packages/client/src/discover.ts`
- Modify: `packages/lsp-server/package.json`
- Modify: `packages/lsp-server/tsconfig.json`
- Modify: `packages/lsp-server/src/lsp.ts`
- Modify: `packages/lsp-server/src/jit.ts`
- Modify: `packages/lsp-server/src/server.ts`
- Modify: `packages/lsp-server/src/invoiceWebhooks.ts`
- Modify: `packages/lsp-server/test/mockRpc.ts`
- Modify: any test reported by `rg "FiberChannelRpcClient|RawChannel|GraphNodeInfo|GraphNodesPage|InvoiceStatus|PaymentResult" packages`

- [ ] **Step 1: Add package dependencies**

In `packages/client/package.json`, set dependencies to:

```json
"dependencies": {
  "@fiberlsp/fiber": "0.0.0",
  "@fiberlsp/protocol": "0.0.0"
}
```

In `packages/lsp-server/package.json`, set dependencies to:

```json
"dependencies": {
  "@fiberlsp/fiber": "0.0.0",
  "@fiberlsp/protocol": "0.0.0"
}
```

- [ ] **Step 2: Add TypeScript project references**

In `packages/client/tsconfig.json`, set references to:

```json
"references": [{ "path": "../protocol" }, { "path": "../fiber" }]
```

In `packages/lsp-server/tsconfig.json`, set references to:

```json
"references": [{ "path": "../protocol" }, { "path": "../fiber" }]
```

- [ ] **Step 3: Locate stale RPC imports**

Run:

```bash
rg -n "FiberChannelRpcClient|RawChannel|RawPeer|GraphNodeInfo|GraphNodesPage|InvoiceStatus|PaymentResult|SendPaymentArgs|OpenChannelArgs" packages/client packages/lsp-server packages/protocol
```

Expected before migration: matches in client, LSP server, tests, and no matches in `packages/protocol/src/index.ts`.

- [ ] **Step 4: Split mixed imports**

For each file that imports protocol domain types and fiber RPC types from `@fiberlsp/protocol`, split the import.

Use this pattern when a file currently imports both `Asset` and `FiberChannelRpcClient`:

```ts
import { type Asset, asBig, assetEquals } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
```

Use this pattern when a file imports raw channel or graph types:

```ts
import { FiberChannelRpcClient, type RawChannel, type GraphNodeInfo, type GraphNodesPage } from "@fiberlsp/fiber";
```

Do not import `Asset`, `AssetOffering`, `LspInfo`, `JitOrder`, `LeaseTerms`, fee helpers, asset helpers, or linkage helpers from `@fiberlsp/fiber`; those stay in `@fiberlsp/protocol`.

- [ ] **Step 5: Verify no protocol RPC imports remain**

Run:

```bash
rg -n "FiberChannelRpcClient|RawChannel|RawPeer|GraphNodeInfo|GraphNodesPage|InvoiceStatus|PaymentResult|SendPaymentArgs|OpenChannelArgs" packages/protocol packages/client packages/lsp-server
```

Expected after migration: every match outside `packages/fiber` imports those names from `@fiberlsp/fiber`, not from `@fiberlsp/protocol`.

- [ ] **Step 6: Run build**

Run:

```bash
npm run build
```

Expected after implementation: pass, or fail only on `packages/client/src/discover.ts` before Task 4 moves discovery.

- [ ] **Step 7: Commit RPC extraction and import migration**

Run:

```bash
git add packages/protocol/src/index.ts packages/fiber package-lock.json
git add packages/client/package.json packages/client/tsconfig.json packages/client/src packages/client/test
git add packages/lsp-server/package.json packages/lsp-server/tsconfig.json packages/lsp-server/src packages/lsp-server/test
git add -u packages/protocol/src/rpc.ts
git commit -m "refactor: move fnn rpc primitives to fiber package"
```

---

### Task 4: Move Static Registry And Graph Discovery Into `@fiberlsp/registry`

**Files:**
- Create: `packages/registry/src/registry.ts`
- Create: `packages/registry/src/graph.ts`
- Create: `packages/registry/src/discover.ts`
- Modify: `packages/registry/src/index.ts`
- Create: `packages/registry/test/registry.test.ts`
- Modify: `packages/client/package.json`
- Modify: `packages/client/tsconfig.json`
- Replace: `packages/client/src/discover.ts`
- Modify: `packages/client/src/quotes.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/test/discover.test.ts`

- [ ] **Step 1: Write failing registry package tests**

Create `packages/registry/test/registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, type GraphNodeInfo, type GraphNodesPage } from "@fiberlsp/fiber";
import {
  discoverFromGraph,
  discoverProviders,
  fetchRegistry,
  type HttpFetch,
  type Registry,
} from "@fiberlsp/registry";
import { udtAsset, type LspInfo } from "@fiberlsp/protocol";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type" as const,
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

function node(over: Partial<GraphNodeInfo> & { pubkey: string }): GraphNodeInfo {
  return {
    node_name: "n",
    version: "0.9",
    addresses: ["/ip4/1.2.3.4/tcp/8228"],
    features: [],
    timestamp: "0x0",
    chain_hash: "0x0",
    auto_accept_min_ckb_funding_amount: "0x0",
    udt_cfg_infos: [],
    ...over,
  };
}

function graphRpc(pages: GraphNodesPage[]) {
  let call = 0;
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}");
    const page = pages[call++] ?? { nodes: [], last_cursor: "0x" };
    return { json: async () => ({ jsonrpc: "2.0", id: body.id, result: page }) };
  };
  return new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl });
}

test("fetchRegistry loads a static providers file", async () => {
  const registry: Registry = {
    version: 1,
    providers: [{ name: "LSP", base_url: "https://lsp.test", chain: "testnet", lsp_pubkey: "0x02aa" }],
  };
  const fetchImpl: HttpFetch = async () => ({ status: 200, json: async () => registry });

  assert.deepEqual(await fetchRegistry("https://example.test/providers.json", fetchImpl), registry);
});

test("discoverFromGraph finds UDT-capable nodes and applies minAmount floors", async () => {
  const rows = await discoverFromGraph(
    graphRpc([
      {
        last_cursor: "0x",
        nodes: [
          node({
            pubkey: "0x02aa",
            udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x3e8", cell_deps: [] }],
          }),
          node({
            pubkey: "0x02bb",
            udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x186a0", cell_deps: [] }],
          }),
        ],
      },
    ]),
    { asset: RUSD, minAmount: "5000" },
  );

  assert.deepEqual(rows.map((r) => r.pubkey), ["0x02aa"]);
  assert.equal(rows[0]?.autoAcceptFloor, "1000");
});

test("discoverProviders merges registry and graph by lsp_pubkey", async () => {
  const info: LspInfo = {
    lsp_pubkey: "0x02aa",
    addresses: ["/ip4/1.2.3.4/tcp/8228"],
    chain: "testnet",
    supported_assets: [],
    fee_modes: ["prepaid"],
    order_expiry_seconds: 600,
  };
  const registry: Registry = {
    version: 1,
    providers: [{ name: "LSP", base_url: "https://lsp.test", chain: "testnet", lsp_pubkey: "0x02aa" }],
  };
  const fetchImpl: HttpFetch = async (url) => {
    if (url.endsWith("/lsp/v1/info")) return { status: 200, json: async () => info };
    return { status: 200, json: async () => registry };
  };
  const rpc = graphRpc([
    {
      last_cursor: "0x",
      nodes: [
        node({
          pubkey: "0x02aa",
          features: ["LspProvider"],
          udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x1", cell_deps: [] }],
        }),
      ],
    },
  ]);

  const providers = await discoverProviders({ registryUrl: "https://example.test/providers.json", rpc, fetchImpl, asset: RUSD });

  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0]?.sources.sort(), ["graph", "registry"]);
  assert.equal(providers[0]?.base_url, "https://lsp.test");
  assert.equal(providers[0]?.reachable, true);
});
```

- [ ] **Step 2: Run the failing registry tests**

Run:

```bash
node --import tsx --test packages/registry/test/registry.test.ts
```

Expected before implementation: fail because `@fiberlsp/registry` has no exported discovery implementation.

- [ ] **Step 3: Move registry types and static loading**

Create `packages/registry/src/registry.ts`:

```ts
export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface RegistryProvider {
  name: string;
  base_url: string;
  chain: string;
  lsp_pubkey?: string;
  operator?: string;
  note?: string;
}

export interface Registry {
  version: number;
  providers: RegistryProvider[];
}

export async function fetchRegistry(url: string, fetchImpl?: HttpFetch): Promise<Registry> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  const res = await f(url);
  return (await res.json()) as Registry;
}
```

- [ ] **Step 4: Move graph discovery**

Move the graph-native section from `packages/client/src/discover.ts` into `packages/registry/src/graph.ts`.

At the top of `packages/registry/src/graph.ts`, use these imports:

```ts
import {
  type Asset,
  asBig,
  canonicalAssetId,
  udtAsset,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient, type GraphNodeInfo } from "@fiberlsp/fiber";
```

The file must export:

```ts
export interface GraphProvider {
  pubkey: string;
  node_name: string;
  addresses: string[];
  asset: Asset;
  autoAcceptFloor?: string;
  features: string[];
  advertisesLsp: boolean;
}

export interface GraphDiscoverOptions {
  asset?: Asset;
  minAmount?: string | bigint;
  requireLspFeature?: boolean;
  lspFeatureName?: string;
  includeCkb?: boolean;
  pageSize?: number;
  maxNodes?: number;
}

export async function discoverFromGraph(
  rpc: FiberChannelRpcClient,
  opts: GraphDiscoverOptions = {},
): Promise<GraphProvider[]>;
```

Keep the current implementation behavior: CKB rows are included when requested, UDT rows are filtered by canonical asset id, and `minAmount` drops nodes whose auto-accept floor is higher than the requested amount.

- [ ] **Step 5: Move merged provider discovery**

Create `packages/registry/src/discover.ts` with the merged discovery logic from `packages/client/src/discover.ts`.

Use these imports:

```ts
import {
  type Asset,
  type LspInfo,
  canonicalAssetId,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import {
  fetchRegistry,
  type HttpFetch,
  type RegistryProvider,
} from "./registry.js";
import {
  discoverFromGraph,
  type GraphDiscoverOptions,
  type GraphProvider,
} from "./graph.js";
```

Define a local `tryGetInfo` helper instead of using `LspClient`:

```ts
async function tryGetInfo(baseUrl: string, fetchImpl?: HttpFetch): Promise<LspInfo | undefined> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  try {
    const res = await f(baseUrl.replace(/\/+$/, "") + "/lsp/v1/info", { method: "GET" });
    if (res.status >= 400) return undefined;
    return (await res.json()) as LspInfo;
  } catch {
    return undefined;
  }
}
```

The file must export the existing client-facing types:

```ts
export interface DiscoveredProvider extends RegistryProvider {
  info?: LspInfo;
  reachable: boolean;
}

export interface ResolvedProvider {
  sources: Array<"graph" | "registry">;
  name: string;
  pubkey?: string;
  base_url?: string;
  addresses?: string[];
  asset?: Asset;
  autoAcceptFloor?: string;
  advertisesLsp?: boolean;
  info?: LspInfo;
  reachable?: boolean;
}

export interface DiscoverProvidersOptions {
  registryUrl?: string;
  rpc?: FiberChannelRpcClient;
  asset?: Asset;
  minAmount?: string | bigint;
  resolveEndpoint?: (g: GraphProvider) => string | undefined;
  graph?: Omit<GraphDiscoverOptions, "asset" | "minAmount">;
  fetchImpl?: HttpFetch;
}
```

Keep exported functions:

```ts
export async function discover(registryUrl: string, fetchImpl?: HttpFetch): Promise<DiscoveredProvider[]>;
export async function discoverProviders(opts: DiscoverProvidersOptions): Promise<ResolvedProvider[]>;
```

- [ ] **Step 6: Re-export registry from client for compatibility**

Replace `packages/client/src/discover.ts` with:

```ts
export {
  discover,
  discoverFromGraph,
  discoverProviders,
  fetchRegistry,
  type Registry,
  type RegistryProvider,
  type DiscoveredProvider,
  type GraphProvider,
  type GraphDiscoverOptions,
  type ResolvedProvider,
  type DiscoverProvidersOptions,
  type HttpFetch,
} from "@fiberlsp/registry";
```

- [ ] **Step 7: Update client dependencies and references**

In `packages/client/package.json`, set dependencies to:

```json
"dependencies": {
  "@fiberlsp/fiber": "0.0.0",
  "@fiberlsp/protocol": "0.0.0",
  "@fiberlsp/registry": "0.0.0"
}
```

In `packages/client/tsconfig.json`, set references to:

```json
"references": [{ "path": "../protocol" }, { "path": "../fiber" }, { "path": "../registry" }]
```

- [ ] **Step 8: Update quote imports**

In `packages/client/src/quotes.ts`, replace:

```ts
import type { RegistryProvider } from "./discover.js";
```

with:

```ts
import type { RegistryProvider } from "@fiberlsp/registry";
```

- [ ] **Step 9: Update client discovery tests**

In `packages/client/test/discover.test.ts`, replace RPC imports:

```ts
import {
  FiberChannelRpcClient,
  type GraphNodeInfo,
  type GraphNodesPage,
} from "@fiberlsp/fiber";
```

Keep discovery imports from `@fiberlsp/client`. This verifies the compatibility re-export still works.

- [ ] **Step 10: Run registry and client discovery tests**

Run:

```bash
npm run build
node --import tsx --test packages/registry/test/registry.test.ts packages/client/test/discover.test.ts packages/client/test/quotes.test.ts
```

Expected after implementation: all three test files pass.

- [ ] **Step 11: Commit registry extraction**

Run:

```bash
git add packages/registry packages/client/package.json packages/client/tsconfig.json packages/client/src/discover.ts packages/client/src/quotes.ts packages/client/test/discover.test.ts package-lock.json
git commit -m "refactor: move provider discovery to registry package"
```

---

### Task 5: Clean Protocol Boundary And Verify Whole Workspace

**Files:**
- Modify: `README.md`
- Modify: `docs/LSPS-Fiber.md`
- Modify: `packages/protocol/package.json`
- Test: all package test files affected by package boundary changes

- [ ] **Step 1: Update protocol package description**

In `packages/protocol/package.json`, replace the description with:

```json
"description": "LSPS-Fiber protocol types, message schemas, asset identity, fee math, lease math, receipts, and linkage proof contracts."
```

- [ ] **Step 2: Check for accidental protocol RPC references**

Run:

```bash
rg -n "FNN RPC|FiberChannelRpcClient|RawChannel|graph_nodes|JSON-RPC" packages/protocol README.md docs/LSPS-Fiber.md
```

Expected after implementation:

- `packages/protocol` has no `FiberChannelRpcClient`, `RawChannel`, or `JSON-RPC wrapper` claims.
- README and docs may mention FNN JSON-RPC conceptually, but package tables should say `@fiberlsp/fiber` owns the adapter.

- [ ] **Step 3: Update README package table**

In `README.md`, update the package table rows so they include the new packages:

```markdown
| `@fiberlsp/protocol` | The LSPS-Fiber contract layer: assets, order/JIT/lease/receipt types, fee/rent math, and linkage proof contracts. |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, and channel opening helpers. |
| `@fiberlsp/registry` | Static provider registry + gossip graph discovery: load `providers.json`, merge by LSP pubkey, and resolve live provider offers. |
| `@fiberlsp/server` | Reference LSP engine + REST API, single-node linked-hash `JitService`, and server-side merchant invoice-webhook service. |
| `@fiberlsp/client` | Merchant SDK: provider discovery re-exports, quote comparison, inbound purchase, invoice checkout, JIT checkout, streaming rent, monitoring, and ledger helpers. |
```

- [ ] **Step 4: Update protocol spec implementation note**

In `docs/LSPS-Fiber.md`, update the implementation paragraph near the top to:

```markdown
This document specifies the wire protocol. The shared contracts live in `@fiberlsp/protocol`; the FNN JSON-RPC adapter lives in `@fiberlsp/fiber`; static registry and graph discovery live in `@fiberlsp/registry`; the reference implementation is `@fiberlsp/server` (LSP side) and `@fiberlsp/client` (merchant side).
```

- [ ] **Step 5: Run full offline verification**

Run:

```bash
npm run build
npm test
```

Expected after implementation: both commands pass.

- [ ] **Step 6: Run drift checks for old package claims**

Run:

```bash
rg -n "@fiberlsp/protocol.*FNN RPC|protocol.*JSON-RPC wrapper|FiberChannelRpcClient" README.md docs packages/protocol/src
```

Expected after implementation: no stale claim that protocol owns the FNN RPC adapter. Mentions of `FiberChannelRpcClient` should be outside `packages/protocol`.

- [ ] **Step 7: Commit boundary cleanup**

Run:

```bash
git add README.md docs/LSPS-Fiber.md packages/protocol/package.json
git commit -m "docs: document protocol fiber registry boundaries"
```

---

### Task 6: Final Review For Foundation Plan

**Files:**
- All files changed in Tasks 1-5

- [ ] **Step 1: Inspect workspace status**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing dirty files remain. Files touched by this plan should either be committed or intentionally unstaged because they belong to the user's existing worktree changes.

- [ ] **Step 2: Confirm package dependency direction**

Run:

```bash
rg -n "\"@fiberlsp/(fiber|registry|client|server)\"" packages/protocol/package.json packages/protocol/src
```

Expected: no output. `@fiberlsp/protocol` must not depend on higher-level packages.

- [ ] **Step 3: Confirm dependency graph**

Run:

```bash
node -e "const fs=require('fs'); for (const p of ['protocol','fiber','registry','client','lsp-server']) { const f='packages/'+p+'/package.json'; const j=JSON.parse(fs.readFileSync(f,'utf8')); console.log(j.name, Object.keys(j.dependencies||{}).join(',')); }"
```

Expected output:

```text
@fiberlsp/protocol 
@fiberlsp/fiber @fiberlsp/protocol
@fiberlsp/registry @fiberlsp/fiber,@fiberlsp/protocol
@fiberlsp/client @fiberlsp/fiber,@fiberlsp/protocol,@fiberlsp/registry
@fiberlsp/server @fiberlsp/fiber,@fiberlsp/protocol
```

- [ ] **Step 4: Confirm final tests**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 5: Commit any final fixes from review**

If Step 1 shows plan-related modified files, run:

```bash
git add package.json package-lock.json README.md docs/LSPS-Fiber.md packages
git commit -m "chore: finalize modular foundation split"
```

If Step 1 shows no plan-related modified files, do not create an empty commit.

## Self-Review Notes

Spec coverage in this foundation plan:

- Covers package boundary start for `protocol`, `fiber`, and `registry`.
- Covers static registry ownership and graph/registry discovery ownership.
- Covers removal of FNN RPC from `protocol`.
- Covers compatibility re-exports from `client`.
- Leaves merchant checkout unification, LSP domain package split, lease position storage, live-inbound rent accounting, persisted jobs, and `jit-proof` packaging for separate executable plans.

Type consistency:

- FNN RPC names move to `@fiberlsp/fiber`.
- Domain names stay in `@fiberlsp/protocol`.
- Registry names move to `@fiberlsp/registry` and are re-exported from `@fiberlsp/client`.
