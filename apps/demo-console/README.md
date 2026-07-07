# Liquidity Console

A zero-dependency static demo of the Fiber LSP Kit flow: connect to an LSP → buy **RUSD inbound** with
zero client capital → **receive** a real stablecoin payment over it → view per-asset liquidity.

- **Replay mode** (default) plays back the real values captured from a live 2-node CKB testnet run —
  order id, fee, channel outpoint, payment hash and balances are all genuine.
  No node required, so it hosts anywhere static.
- **Live mode** points the same UI at a running reference server (`npm run server` in the repo root) via
  its base URL; it drives the real `/lsp/v1/*` endpoints. (The final "receive" step needs the second node,
  so it stays replayed.)

## Run locally

```bash
# from this directory — any static server works
python3 -m http.server 8099
# open http://127.0.0.1:8099
```

Deep-link `?autorun=1` plays the flow automatically (handy for screenshots and hosted previews).

## Host it

It's plain HTML/CSS/JS — deploy the folder as-is to any static host (GitHub Pages, Netlify, Vercel,
Cloudflare Pages). No build step.

## See also

- **`npm run demo`** (repo root) — the whole merchant flow (provision → invoice → settlement webhook →
  reconcile → CSV) run **node-lessly** against the real kit code with a real HTTP webhook sink. No browser.
- **[`scripts/demo/`](../../scripts/demo)** — reproduce the live node flow (discover → buy → invoice →
  routed pay → stream rent) with the demo harness scripts.
