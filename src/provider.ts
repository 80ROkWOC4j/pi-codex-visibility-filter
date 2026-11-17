import type { Provider } from "@earendil-works/pi-ai";
import { CatalogReader, filterVisible } from "./catalog.ts";

/** Decorate availability only. getModels/getModel, authentication and transport stay native. */
export function withVisibility(base: Provider, reader: CatalogReader): Provider {
  return {
    ...base,
    filterModels(models, credential) {
      const native = base.filterModels?.(models, credential) ?? models;
      return filterVisible(native, reader.read(), reader.options.mode);
    },
    filterAllModels(models, credential) {
      let native = models;
      if (base.filterAllModels) native = base.filterAllModels(models, credential);
      else if (base.filterModels) {
        const ids = new Set(base.filterModels(base.getModels(), credential).map(m => m.id));
        native = models.filter(m => (m.type !== undefined && m.type !== "chat") || ids.has(m.id));
      }
      return filterVisible(native, reader.read(), reader.options.mode);
    },
  };
}
