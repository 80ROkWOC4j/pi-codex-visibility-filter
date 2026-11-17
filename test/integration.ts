import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pi = process.env.PI_TEST_BIN ?? "pi";
const syntheticId = "synthetic-remote-overlay-model";
const remote = { models: [{ slug: "gpt-5.4", visibility: "list" }, { slug: "gpt-4o", visibility: "hide" }, { slug: syntheticId, visibility: "list" }] };
const syntheticModel = {
  id: syntheticId, name: "Synthetic overlay v1", provider: "openai", api: "openai-responses",
  baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096,
};
const scope = "chatgpt.tokens.use.direct";
const credential = { type: "oauth", clientId: "test-openai-grant", scopes: [scope], access: "test-openai-access", refresh: "test-refresh", expires: Date.now() + 86400000 };
type Scenario = "oauth" | "offline" | "api-key" | "radius" | "expired" | "refresh-failed";
function setup(t: TestContext, scenario: Scenario = "oauth") {
  const dir = mkdtempSync(join(tmpdir(), "pi-visibility-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1" };
  delete env.PI_OFFLINE;
  delete env.OPENAI_API_KEY;
  const expired = scenario === "expired" || scenario === "refresh-failed";
  const stored = scenario === "api-key" ? { type: "api_key", key: "test-key" }
    : { ...credential, ...(expired ? { expires: 0 } : {}), ...(scenario === "radius" ? { access: "test-radius-access" } : {}) };
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: stored }));
  const openai = scenario === "radius"
    ? { oauth: "radius", baseUrl: "https://radius.invalid/v1", models: [{ id: "gpt-4o", api: "openai-responses" }] }
    : { modelOverrides: { [syntheticId]: { maxTokens: 3072 } } };
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openai } }));
  const fixture = join(dir, "fixture.ts");
  writeFileSync(fixture, `
import extension from ${JSON.stringify(resolve(root, "src/index.ts"))};
import { CatalogClient } from ${JSON.stringify(resolve(root, "src/catalog.ts"))};
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
export default function(pi) {
  const marker = Symbol.for("pi-visibility-test.filter-probe");
  if (!CatalogClient.prototype[marker]) {
    const filter = CatalogClient.prototype.filter;
    CatalogClient.prototype.filter = function(...args) {
      if (globalThis.__visibilityTestProbing) appendFileSync(${JSON.stringify(join(dir, "filter-calls"))}, "filter\\n");
      return filter.apply(this, args);
    };
    CatalogClient.prototype[marker] = true;
  }
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.href === "https://auth.openai.com/api/accounts/oauth/token") {
      appendFileSync(${JSON.stringify(join(dir, "oauth-refreshes"))}, "refresh\\n");
      if (${scenario === "refresh-failed"}) return new Response(null, { status: 401 });
      return Response.json({ access_token: "test-rotated-access", refresh_token: "test-rotated-refresh",
        scope: ${JSON.stringify(scope)}, expires_in: 3600 });
    }
    if (target.href === "https://radius.invalid/v1/config") {
      appendFileSync(${JSON.stringify(join(dir, "radius-requests"))}, "config\\n");
      return Response.json({ models: [] });
    }
    if (target.origin === "https://pi.dev" && target.pathname.startsWith("/api/models/providers/")) {
      if (target.pathname !== "/api/models/providers/openai") return new Response(null, { status: 404 });
      appendFileSync(${JSON.stringify(join(dir, "native-requests"))}, "catalog\\n");
      const forced = existsSync(${JSON.stringify(join(dir, "force-marker"))});
      return Response.json({ models: [{ ...${JSON.stringify(syntheticModel)}, name: forced ? "Synthetic overlay v2" : "Synthetic overlay v1" }] },
        { headers: { "Last-Modified": "Thu, 01 Jan 2099 00:00:00 GMT" } });
    }
    if (target.href !== "https://api.openai.com/v1/models") throw new Error("Network disabled by test");
    appendFileSync(${JSON.stringify(join(dir, "requests"))}, "catalog\\n");
    if (new Headers(init?.headers).get("Authorization") !== ${JSON.stringify(expired ? "Bearer test-rotated-access" : "Bearer test-openai-access")}) {
      throw new Error("Wrong credential");
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    return Response.json(${JSON.stringify(remote)});
  };
  extension(pi);
  pi.registerCommand("test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("test-probe-wrapper", { handler: async (_args, ctx) => {
    if (ctx.modelRegistry.getRegisteredNativeProvider("openai")) throw new Error("OpenAI provider was replaced");
    globalThis.__visibilityTestProbing = true;
    try { ctx.modelRegistry.getProvider("openai").filterModels([], ${JSON.stringify(credential)}); }
    finally { globalThis.__visibilityTestProbing = false; }
  } });
  pi.registerCommand("test-force-refresh", { handler: async (_args, ctx) => {
    writeFileSync(${JSON.stringify(join(dir, "force-marker"))}, "forced");
    const result = await ctx.modelRegistry.refresh({ providers: ["openai"], force: true, signal: AbortSignal.timeout(7000) });
    if (result.aborted || result.errors.size) throw new Error("Forced refresh failed");
  } });
}
`);
  return { dir, env, args: [...(scenario === "offline" ? ["--offline"] : []), "--no-extensions", "-e", fixture] };
}
async function rpc(config: ReturnType<typeof setup>) {
  const { args, dir, env } = config;
  const child = spawn(pi, [...args, "--mode", "rpc", "--no-session", "--provider", "openai", "--model", "gpt-4o"], { cwd: dir, env, stdio: "pipe" });
  let output = "", stderr = "", counter = 0;
  type Response = { success: boolean; data?: any; error?: string };
  const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void }>();
  const exited = new Promise<void>(done => child.once("close", () => done()));
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => { for (const item of pending.values()) item.reject(error); });
  child.stdout.on("data", chunk => {
    output += chunk;
    let index: number;
    while ((index = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, index); output = output.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === "response") pending.get(record.id)?.resolve(record);
      } catch (error) { for (const item of pending.values()) item.reject(error as Error); }
    }
  });
  return {
    async request(command: Record<string, unknown>): Promise<Response> {
      const id = String(++counter);
      let timeout: NodeJS.Timeout;
      try {
        return await new Promise<Response>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("RPC timeout: " + stderr)), 10000);
          pending.set(id, { resolve, reject });
          child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
        });
      } finally { clearTimeout(timeout!); pending.delete(id); }
    },
    async close() {
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(kill);
    },
  };
}

test("new openai OAuth works without Codex: one request across first RPC, force, reload and new session; restart fetches again", { timeout: 45000 }, async t => {
  const config = setup(t);
  const count = (file = "requests") => existsSync(join(config.dir, file)) ? readFileSync(join(config.dir, file), "utf8").trim().split("\n").length : 0;
  const client = await rpc(config);
  try {
    const state = await client.request({ type: "get_state" });
    assert.equal(state.data.model.id, "gpt-4o", "explicit CLI selection remains possible");
    const check = async (expectedName: string, expectedMaxTokens = 3072) => {
      const list = await client.request({ type: "get_available_models" });
      assert.equal(list.success, true);
      const openai = list.data.models.filter((m: any) => m.provider === "openai");
      assert.deepEqual(openai.map((m: any) => m.id).sort(), ["gpt-5.4", syntheticId].sort());
      const synthetic = openai.find((m: any) => m.id === syntheticId);
      assert.equal(synthetic.name, expectedName);
      assert.equal(synthetic.contextWindow, 64000);
      assert.equal(synthetic.maxTokens, expectedMaxTokens);
      assert.equal(count(), 1);
      const beforeProbe = count("filter-calls");
      assert.equal((await client.request({ type: "prompt", message: "/test-probe-wrapper" })).success, true);
      assert.equal(count("filter-calls") - beforeProbe, 1, "exactly one visibility wrapper is installed");
    };
    await check("Synthetic overlay v1");
    assert.ok(count("native-requests") >= 1, "native pi.dev catalog was requested");
    assert.equal((await client.request({ type: "set_model", provider: "openai", modelId: "gpt-4o" })).success, false);
    for (const message of ["/codex-visibility", "/test-reload"]) {
      const response = await client.request({ type: "prompt", message });
      assert.equal(response.success, true, JSON.stringify(response));
      await check("Synthetic overlay v1");
    }
    assert.equal((await client.request({ type: "new_session" })).success, true);
    await check("Synthetic overlay v1");
    const beforeForce = count("native-requests");
    assert.equal((await client.request({ type: "prompt", message: "/test-force-refresh" })).success, true);
    assert.ok(count("native-requests") > beforeForce, "force refresh requested native catalog again");
    await check("Synthetic overlay v2");
    writeFileSync(join(config.dir, "models.json"), JSON.stringify({ providers: { openai: {
      modelOverrides: { [syntheticId]: { maxTokens: 2048 } },
    } } }));
    assert.equal((await client.request({ type: "prompt", message: "/test-force-refresh" })).success, true);
    await check("Synthetic overlay v2", 2048);
    writeFileSync(join(config.dir, "models.json"), JSON.stringify({ providers: {} }));
    assert.equal((await client.request({ type: "prompt", message: "/test-force-refresh" })).success, true);
    await check("Synthetic overlay v2", 4096);
  } finally { await client.close(); }
  const restarted = await rpc(config);
  try {
    assert.equal((await restarted.request({ type: "get_available_models" })).success, true);
    assert.equal(count(), 2);
    assert.ok(!existsSync(join(config.dir, "cache", "pi-codex-visibility-filter")));
  } finally { await restarted.close(); }
});

for (const kind of ["offline", "api-key", "radius"] as const) {
  test(kind + " leaves models visible without catalog requests", { timeout: 15000 }, async t => {
    const config = setup(t, kind);
    const client = await rpc(config);
    try {
      const list = await client.request({ type: "get_available_models" });
      assert.equal(list.success, true);
      assert.ok(list.data.models.some((m: any) => m.provider === "openai" && m.id === "gpt-4o"));
      assert.ok(!existsSync(join(config.dir, "requests")));
      if (kind === "radius") assert.ok(existsSync(join(config.dir, "radius-requests")));
    } finally { await client.close(); }
  });
}

for (const scenario of ["expired", "refresh-failed"] as const) {
  test(scenario === "expired" ? "Pi rotates an expired ChatGPT token before the visibility request"
    : "failed ChatGPT token refresh leaves the native catalog available", { timeout: 15000 }, async t => {
    const config = setup(t, scenario);
    const client = await rpc(config);
    try {
      const list = await client.request({ type: "get_available_models" });
      assert.equal(list.success, true);
      const models = list.data.models.filter((m: any) => m.provider === "openai");
      assert.ok(models.some((m: any) => m.id === syntheticId));
      assert.equal(existsSync(join(config.dir, "requests")), scenario === "expired");
      assert.equal(models.some((m: any) => m.id === "gpt-4o"), scenario === "refresh-failed");
      assert.equal(readFileSync(join(config.dir, "oauth-refreshes"), "utf8"), "refresh\n");
      if (scenario === "expired") {
        const auth = JSON.parse(readFileSync(join(config.dir, "auth.json"), "utf8"));
        assert.equal(auth.openai.refresh, "test-rotated-refresh");
      }
    } finally { await client.close(); }
  });
}
