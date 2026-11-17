import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CatalogClient } from "./catalog.ts";
import { attachVisibility } from "./pi-runtime.ts";

export default function codexVisibility(pi: ExtensionAPI) {
  const catalog = new CatalogClient();
  let detach: (() => boolean) | undefined;

  pi.on("session_shutdown", async (event, ctx) => {
    const detached = detach?.();
    detach = undefined;
    if (detached && event.reason !== "quit") {
      await ctx.modelRegistry.refresh({ providers: ["openai"], allowNetwork: false, signal: AbortSignal.timeout(7000) });
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    detach ??= attachVisibility(ctx.modelRegistry, catalog);
    if (!detach) {
      ctx.ui.notify("Visibility filter is unavailable in this Pi version.", "warning");
      return;
    }
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
