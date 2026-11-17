import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CatalogClient } from "./catalog.ts";
import { withVisibility } from "./provider.ts";

export default function codexVisibility(pi: ExtensionAPI) {
  const base = builtinProviders().find(provider => provider.id === "openai");
  if (!base) return;
  const catalog = new CatalogClient();
  pi.registerProvider(withVisibility(base, catalog));

  pi.on("session_start", async (_event, ctx) => {
    // Await startup discovery before Paseo's first RPC list. Honor the host's offline policy.
    const result = await ctx.modelRegistry.refresh({ providers: ["openai"], signal: AbortSignal.timeout(7000) });
    if (result.aborted || result.errors.size) {
      ctx.ui.notify("Visibility catalog initialization did not complete. Check Pi authentication and restart Pi.", "warning");
    }
    const status = catalog.status();
    if (status.error) ctx.ui.notify(status.error + ". Filter inactive until Pi restarts.", "warning");
  });

  pi.registerCommand("codex-visibility", {
    description: "Show model visibility status (restart Pi to fetch again)",
    async handler(_args, ctx) {
      ctx.ui.notify(JSON.stringify(catalog.status(), null, 2), "info");
    },
  });
}
