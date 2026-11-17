import { createHash } from "node:crypto";
import type { Credential, RefreshModelsContext } from "@earendil-works/pi-ai";

export const CATALOG_URL = "https://api.openai.com/v1/models";

type Row = { slug: string; visibility: "list" | "hide" | "none" | "hidden" };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseRows(value: unknown): Row[] {
  if (!object(value) || !Array.isArray(value.models) || !value.models.length) throw new Error("Invalid catalog");
  const seen = new Set<string>();
  const rows = value.models.map(row => {
    if (!object(row) || typeof row.slug !== "string" || !row.slug.trim() || typeof row.visibility !== "string" ||
        !["list", "hide", "none", "hidden"].includes(row.visibility) || seen.has(row.slug)) throw new Error("Invalid catalog");
    seen.add(row.slug);
    return { slug: row.slug, visibility: row.visibility as Row["visibility"] };
  });
  if (!rows.some(row => row.visibility === "list")) throw new Error("Empty visible catalog");
  return rows;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type ChatGPTCredential = Extract<Credential, { type: "oauth" }> & { clientId: string };

/** Pi's native ChatGPT login stores the grant's client ID and direct-token scope. */
export function isChatGPTCredential(credential: Credential | undefined): credential is ChatGPTCredential {
  return credential?.type === "oauth" && typeof credential.access === "string" && !!credential.access &&
    typeof credential.clientId === "string" && !!credential.clientId.trim() &&
    Array.isArray(credential.scopes) && credential.scopes.includes("chatgpt.tokens.use.direct");
}

/** Identify the OAuth grant so another login cannot reuse its catalog. */
function identity(credential: Credential | undefined) {
  if (isChatGPTCredential(credential)) return hash(credential.clientId);
}

interface State {
  identity: string;
  pending: Promise<void>;
  rows?: Row[];
  fetchedAt?: string;
  error?: string;
}
export interface ProcessCache { state?: State }
// Extension modules are reloaded by jiti. A process-global symbol retains the single attempt across /reload and /new.
const CACHE = Symbol.for("pi-codex-visibility-filter.process-cache.v3");
export function processCache(): ProcessCache {
  const globals = globalThis as typeof globalThis & { [CACHE]?: ProcessCache };
  return globals[CACHE] ??= {};
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Caller cancellation stops waiting, not the shared process-wide request another refresh is awaiting. */
async function wait(pending: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class CatalogClient {
  private readonly cache: ProcessCache;
  private readonly fetcher: typeof fetch;
  constructor(cache = processCache(), fetcher: typeof fetch = fetch) {
    this.cache = cache;
    this.fetcher = fetcher;
  }
  async refresh(context: RefreshModelsContext): Promise<void> {
    if (!context.allowNetwork || context.signal.aborted) return;
    const { credential } = context;
    if (!isChatGPTCredential(credential)) return;
    const owner = hash(credential.clientId);
    let state = this.cache.state;
    if (!state) {
      state = { identity: owner, pending: Promise.resolve() };
      this.cache.state = state;
      state.pending = this.fetchOnce(state, credential.access);
    }
    // An account change requires a process restart; never apply the previous account's catalog.
    if (state.identity === owner) await wait(state.pending, context.signal);
  }
  private async fetchOnce(state: State, access: string): Promise<void> {
    const signal = AbortSignal.timeout(5000);
    let status: number | undefined;
    try {
      const response = await this.fetcher(CATALOG_URL, {
        headers: { Authorization: "Bearer " + access, Accept: "application/json" },
        signal, redirect: "error",
      });
      status = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error("HTTP error"); }
      const rows = parseRows(await readResponse(response));
      signal.throwIfAborted();
      state.rows = rows;
      state.fetchedAt = new Date().toISOString();
    } catch {
      // Do not persist tokens, account IDs, raw errors or server response bodies.
      state.error = signal.aborted ? "catalog request timed out" : status && status !== 200 ? "catalog HTTP " + status : "catalog request failed or returned invalid data";
    }
  }
  filter<T extends { id: string; type?: string }>(models: readonly T[], credential: Credential | undefined): readonly T[] {
    const state = this.cache.state;
    if (!state?.rows || state.identity !== identity(credential)) return models;
    const visibility = new Map(state.rows.map(row => [row.slug, row.visibility]));
    return models.filter(model => {
      if (model.type !== undefined && model.type !== "chat") return true;
      return visibility.get(model.id) === "list";
    });
  }
  status() {
    const state = this.cache.state;
    return {
      attempted: !!state, fetchedAt: state?.fetchedAt,
      listed: state?.rows?.filter(row => row.visibility === "list").length ?? 0, error: state?.error,
      note: "OAuth only; policy applies only to the original login. Restart Pi to fetch again.",
    };
  }
}
