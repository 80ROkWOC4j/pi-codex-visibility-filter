import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pi = process.env.PI_TEST_BIN ?? "pi";
test("real Pi CLI and Paseo-style RPC availability, explicit selection and fail-open", { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-visibility-integration-"));
  const cache = join(dir, "models_cache.json");
  writeFileSync(cache, JSON.stringify({ fetched_at: new Date().toISOString(), models: [
    { slug: "gpt-5.4", visibility: "list" }, { slug: "gpt-4o", visibility: "hide" },
  ] }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "test-not-a-real-key",
    PI_CODEX_VISIBILITY_CACHE: cache, PI_CODEX_VISIBILITY_PROVIDERS: "openai,openai-codex",
    PI_CODEX_VISIBILITY_MODE: "listed", PI_CODEX_VISIBILITY_MAX_AGE_HOURS: "168" };
  const args = ["--offline", "--no-extensions", "-e", resolve(root, "src/index.ts")];
  const child = spawn(pi, [...args, "--mode", "rpc", "--no-session", "--provider", "openai", "--model", "gpt-4o"], { cwd: dir, env, stdio: "pipe" });
  let output = "";
  let stderr = "";
  let counter = 0;
  type Response = { success: boolean; data?: any; error?: string };
  const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void }>();
  const exited = new Promise<void>((done) => child.once("close", () => done()));
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
      } catch (error) {
        for (const item of pending.values()) item.reject(error as Error);
      }
    }
  });
  async function request(command: Record<string, unknown>): Promise<Response> {
    const id = String(++counter);
    let timeout: NodeJS.Timeout;
    try {
      return await new Promise<Response>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("RPC timeout: " + stderr)), 10000);
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      });
    } finally { clearTimeout(timeout!); pending.delete(id); }
  }
  try {
    const state = await request({ type: "get_state" });
    assert.equal(state.success, true, JSON.stringify(state));
    assert.equal(state.data.model.id, "gpt-4o", "explicit --model must remain resolvable");
    const list = await request({ type: "get_available_models" });
    assert.equal(list.success, true);
    assert.deepEqual(list.data.models.filter((m: any) => m.provider === "openai").map((m: any) => m.id), ["gpt-5.4"]);
    const blocked = await request({ type: "set_model", provider: "openai", modelId: "gpt-4o" });
    assert.equal(blocked.success, false, "Pi RPC set_model only accepts available models");
    const allowed = await request({ type: "set_model", provider: "openai", modelId: "gpt-5.4" });
    assert.equal(allowed.success, true);
    const listing = execFileSync(pi, [...args, "--list-models", "openai"], { cwd: dir, env, encoding: "utf8", timeout: 15000 });
    assert.match(listing, /gpt-5\.4/);
    assert.doesNotMatch(listing, /gpt-4o/);
    writeFileSync(cache, "{");
    const fallback = execFileSync(pi, [...args, "--list-models", "openai"], { cwd: dir, env, encoding: "utf8", timeout: 15000 });
    assert.match(fallback, /gpt-4o/, "malformed catalog must fail open");
    assert.equal(stderr, "");
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(kill);
    rmSync(dir, { recursive: true, force: true });
  }
});
