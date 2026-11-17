import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pi = process.env.PI_TEST_BIN ?? "pi";
const remote = { models: [{ slug: "gpt-5.4", visibility: "list" }, { slug: "gpt-4o", visibility: "hide" }] };
const credential = { type: "oauth", clientId: "test-openai-grant", access: "test-openai-access", refresh: "test-refresh", expires: Date.now() + 86400000 };
function setup(t: TestContext, offline = false, apiKey = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-visibility-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1" };
  delete env.PI_OFFLINE;
  delete env.OPENAI_API_KEY;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: apiKey ? { type: "api_key", key: "test-key" } : credential }));
  const fixture = join(dir, "fixture.ts");
  writeFileSync(fixture, `
import extension from ${JSON.stringify(resolve(root, "src/index.ts"))};
import { appendFileSync } from "node:fs";
export default function(pi) {
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.openai.com/v1/models") throw new Error("Network disabled by test");
    if (new Headers(init.headers).get("Authorization") !== "Bearer test-openai-access") throw new Error("Wrong credential");
    appendFileSync(${JSON.stringify(join(dir, "requests"))}, "catalog\\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    return Response.json(${JSON.stringify(remote)});
  };
  extension(pi);
  pi.registerCommand("test-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
`);
  return { dir, env, args: [...(offline ? ["--offline"] : []), "--no-extensions", "-e", fixture] };
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
  const count = () => readFileSync(join(config.dir, "requests"), "utf8").trim().split("\n").length;
  const client = await rpc(config);
  try {
    const state = await client.request({ type: "get_state" });
    assert.equal(state.data.model.id, "gpt-4o", "explicit CLI selection remains possible");
    const check = async () => {
      const list = await client.request({ type: "get_available_models" });
      assert.equal(list.success, true);
      assert.deepEqual(list.data.models.filter((m: any) => m.provider === "openai").map((m: any) => m.id), ["gpt-5.4"]);
      assert.equal(count(), 1);
    };
    await check();
    assert.equal((await client.request({ type: "set_model", provider: "openai", modelId: "gpt-4o" })).success, false);
    for (const message of ["/codex-visibility", "/test-reload"]) {
      const response = await client.request({ type: "prompt", message });
      assert.equal(response.success, true, JSON.stringify(response));
      await check();
    }
    assert.equal((await client.request({ type: "new_session" })).success, true);
    await check();
  } finally { await client.close(); }
  const restarted = await rpc(config);
  try {
    assert.equal((await restarted.request({ type: "get_available_models" })).success, true);
    assert.equal(count(), 2);
    assert.ok(!existsSync(join(config.dir, "cache", "pi-codex-visibility-filter")));
  } finally { await restarted.close(); }
});

for (const kind of ["offline", "api-key"] as const) {
  test(kind + " leaves models visible without catalog requests", { timeout: 15000 }, async t => {
    const config = setup(t, kind === "offline", kind === "api-key");
    const client = await rpc(config);
    try {
      const list = await client.request({ type: "get_available_models" });
      assert.equal(list.success, true);
      assert.ok(list.data.models.some((m: any) => m.provider === "openai" && m.id === "gpt-4o"));
      assert.ok(!existsSync(join(config.dir, "requests")));
    } finally { await client.close(); }
  });
}
