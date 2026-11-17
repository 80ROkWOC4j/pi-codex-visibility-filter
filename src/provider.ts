import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { CatalogClient } from "./catalog.ts";

/** Availability only: definitions, direct lookup, authentication and model transport stay native. */
export function withVisibility(
  base: Provider,
  catalog: CatalogClient,
  readCredential: (signal: AbortSignal) => Promise<Credential | undefined>,
): Provider {
  return {
    ...base,
    async refreshModels(context) {
      // Await both even if pi.dev fails, so the first RPC list sees the visibility result.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => base.refreshModels?.(context)),
        context.allowNetwork && !context.signal.aborted
          ? readCredential(context.signal).then(credential => catalog.refresh({ ...context, credential }))
          : undefined,
      ]);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    },
    filterModels(models, credential) {
      return catalog.filter(base.filterModels?.(models, credential) ?? models, credential);
    },
    filterAllModels(models, credential) {
      let native = models;
      if (base.filterAllModels) native = base.filterAllModels(models, credential);
      else if (base.filterModels) {
        const ids = new Set(base.filterModels(base.getModels(), credential).map(m => m.id));
        native = models.filter(m => (m.type !== undefined && m.type !== "chat") || ids.has(m.id));
      }
      return catalog.filter(native, credential);
    },
  };
}
