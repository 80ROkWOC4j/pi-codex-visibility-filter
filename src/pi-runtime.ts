import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isChatGPTCredential, type CatalogClient } from "./catalog.ts";
import { withVisibility } from "./provider.ts";

const OPENAI = "openai";

// Pi 1.5.2 has no public registration for filters on existing providers.
// Hook composition so Pi still owns models.json, auth, and provider registration.
interface Runtime extends Pick<ModelRuntime, "getAuth" | "getProvider"> {
  composeProvider(id: string): Provider | undefined;
  defaultBuiltins: ReadonlyMap<string, Provider>;
  credentials: Pick<CredentialStore, "read">;
}

function supportsComposition(runtime: Partial<Runtime> | undefined): runtime is Runtime {
  return typeof runtime?.composeProvider === "function" && typeof runtime.getProvider === "function" &&
    typeof runtime.getAuth === "function" && typeof runtime.defaultBuiltins?.get === "function" &&
    typeof runtime.credentials?.read === "function";
}

export function attachVisibility(registry: ModelRegistry, catalog: CatalogClient): (() => boolean) | undefined {
  const runtime = (registry as unknown as { runtime?: Partial<Runtime> }).runtime;
  if (!supportsComposition(runtime)) return;
  const original = runtime.composeProvider;
  const builtinOAuth = runtime.defaultBuiltins.get(OPENAI)?.auth.oauth;
  if (!builtinOAuth?.isSubscription || typeof builtinOAuth.refresh !== "function") return;
  const credentials = runtime.credentials;

  const isNativeChatGPT = (provider: Provider | undefined) =>
    provider?.auth.oauth?.refresh === builtinOAuth.refresh && provider.auth.oauth.login === builtinOAuth.login;

  const compose = (id: string) => {
    const base = original.call(runtime, id);
    if (id !== OPENAI || !base || !isNativeChatGPT(base)) return base;
    return withVisibility(base, catalog, async signal => {
      let credential = await credentials.read(OPENAI, { signal });
      if (signal.aborted || !isChatGPTCredential(credential) || !isNativeChatGPT(runtime.getProvider(OPENAI))) return;
      if (Date.now() >= credential.expires) {
        // Pi owns the refresh lock and persists rotated refresh tokens.
        await runtime.getAuth(OPENAI, { signal });
        credential = await credentials.read(OPENAI, { signal });
      }
      if (!signal.aborted && isChatGPTCredential(credential) && Date.now() < credential.expires &&
          isNativeChatGPT(runtime.getProvider(OPENAI))) return credential;
    });
  };
  runtime.composeProvider = compose;
  return () => {
    if (runtime.composeProvider !== compose) return false;
    runtime.composeProvider = original;
    return true;
  };
}
