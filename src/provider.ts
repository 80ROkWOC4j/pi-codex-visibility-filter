import type { Provider } from "@earendil-works/pi-ai";
import { CatalogClient } from "./catalog.ts";

/** Availability only: definitions, direct lookup, authentication and model transport stay native. */
export function withVisibility(base: Provider, catalog: CatalogClient): Provider {
  return {
    ...base,
    async refreshModels(context) {
      await base.refreshModels?.(context);
      await catalog.refresh(context);
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
