import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function saveState(cfg, key, value) {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, `${key}.json`), JSON.stringify(value, null, 2));
}

export function loadState(cfg, key) {
  const file = join(cfg.stateDir, `${key}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function updateState(cfg, key, patch) {
  const current = loadState(cfg, key) ?? {};
  const next = { ...current, ...patch };
  saveState(cfg, key, next);
  return next;
}
