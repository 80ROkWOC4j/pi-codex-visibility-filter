import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Mode = "listed" | "explicit";
export interface Options {
  cachePath: string;
  providers: string[];
  mode: Mode;
  maxAgeMs: number;
}
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): Options {
  const mode = env.PI_CODEX_VISIBILITY_MODE ?? "listed";
  if (mode !== "listed" && mode !== "explicit") throw new Error("PI_CODEX_VISIBILITY_MODE must be listed or explicit");
  const hours = Number(env.PI_CODEX_VISIBILITY_MAX_AGE_HOURS ?? 168);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("PI_CODEX_VISIBILITY_MAX_AGE_HOURS must be positive");
  const providers = (env.PI_CODEX_VISIBILITY_PROVIDERS ?? "openai,openai-codex").split(",").map(s => s.trim()).filter(Boolean);
  if (!providers.length || providers.some(p => p !== "openai" && p !== "openai-codex")) {
    throw new Error("PI_CODEX_VISIBILITY_PROVIDERS must contain openai and/or openai-codex");
  }
  const path = env.PI_CODEX_VISIBILITY_CACHE ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
  return { cachePath: resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path), providers, mode, maxAgeMs: hours * 3600000 };
}

export interface Catalog {
  fetchedAt: number;
  visibility: Map<string, string>;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseCatalog(value: unknown): Catalog {
  if (!object(value) || typeof value.fetched_at !== "string" || !Array.isArray(value.models) || !value.models.length) {
    throw new Error("Invalid or empty Codex catalog");
  }
  const fetchedAt = Date.parse(value.fetched_at);
  if (!Number.isFinite(fetchedAt)) throw new Error("Invalid catalog timestamp");
  const visibility = new Map<string, string>();
  for (const row of value.models) {
    if (!object(row) || typeof row.slug !== "string" || !row.slug.trim() ||
        typeof row.visibility !== "string" || !["list", "hide", "none", "hidden"].includes(row.visibility) ||
        visibility.has(row.slug)) {
      throw new Error("Invalid, duplicate, or unsupported catalog row");
    }
    visibility.set(row.slug, row.visibility);
  }
  if (![...visibility.values()].includes("list")) throw new Error("Catalog has no listed models");
  return { fetchedAt, visibility };
}

export class CatalogReader {
  private fingerprint = "";
  private catalog: Catalog | undefined;
  private reason = "not read";
  readonly options: Options;
  private readonly now: () => number;
  constructor(options: Options, now = Date.now) {
    this.options = options;
    this.now = now;
  }
  read(): Catalog | undefined {
    try {
      const stat = statSync(this.options.cachePath);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid catalog file");
      const fingerprint = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
      if (fingerprint !== this.fingerprint) {
        this.catalog = parseCatalog(JSON.parse(readFileSync(this.options.cachePath, "utf8")));
        this.fingerprint = fingerprint;
      }
      const age = this.now() - this.catalog!.fetchedAt;
      if (age < -300000 || age > this.options.maxAgeMs) {
        this.reason = "catalog timestamp is stale or in the future";
        return undefined;
      }
      this.reason = "active";
      return this.catalog;
    } catch {
      // Fail open, including partial writes. Never retain another account's old policy.
      this.catalog = undefined;
      this.fingerprint = "";
      this.reason = "catalog missing, unreadable, malformed, or unsupported";
      return undefined;
    }
  }
  status() {
    const catalog = this.read();
    return {
      state: this.reason, cachePath: this.options.cachePath, mode: this.options.mode,
      providers: this.options.providers,
      fetchedAt: catalog ? new Date(catalog.fetchedAt).toISOString() : undefined,
      listed: catalog ? [...catalog.visibility.values()].filter(v => v === "list").length : 0,
    };
  }
}

export function filterVisible<T extends { id: string; type?: string }>(
  models: readonly T[], catalog: Catalog | undefined, mode: Mode,
): readonly T[] {
  if (!catalog) return models;
  return models.filter(model => {
    if (model.type !== undefined && model.type !== "chat") return true;
    const visibility = catalog.visibility.get(model.id);
    return visibility === "list" || (mode === "explicit" && visibility === undefined);
  });
}
