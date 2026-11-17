import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CatalogReader, optionsFromEnv } from "./catalog.ts";
import { withVisibility } from "./provider.ts";

export default function codexVisibility(pi: ExtensionAPI) {
  const reader = new CatalogReader(optionsFromEnv());
  for (const base of builtinProviders()) {
    if (reader.options.providers.includes(base.id)) pi.registerProvider(withVisibility(base, reader));
  }

  pi.registerCommand("codex-visibility", {
    description: "Show Codex visibility policy; use refresh to update Pi's available-model snapshot",
    async handler(args, ctx) {
      if (args.trim() === "refresh") {
        await ctx.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(5000) });
      } else if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("Usage: /codex-visibility [status|refresh]", "warning");
        return;
      }
      ctx.ui.notify(JSON.stringify(reader.status(), null, 2), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const status = reader.status();
    if (status.state !== "active") {
      ctx.ui.notify("Codex visibility filter inactive: " + status.state + ". Run /codex-visibility for details.", "warning");
    }
  });
}
