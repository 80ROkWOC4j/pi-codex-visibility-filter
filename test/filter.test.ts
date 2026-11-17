import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogReader, filterVisible, optionsFromEnv, parseCatalog } from "../src/catalog.ts";
import { withVisibility } from "../src/provider.ts";
import type { Provider } from "@earendil-works/pi-ai";

const now = Date.parse("2026-01-01T00:00:00Z");
const payload = () => ({
  fetched_at: new Date(now).toISOString(),
  models: [
    { slug: "new", visibility: "list", supported_in_api: false },
    { slug: "old", visibility: "hide" },
    { slug: "none", visibility: "none" },
  ],
});
const models = [{ id: "new" }, { id: "old" }, { id: "absent" }, { id: "none" }, { id: "image", type: "image" }];
test("listed mode follows visibility, not supported_in_api; preserves other model types", () => {
  assert.deepEqual(filterVisible(models, parseCatalog(payload()), "listed").map(m => m.id), ["new", "image"]);
});
test("explicit mode preserves unknown IDs; missing catalog fails open", () => {
  assert.deepEqual(filterVisible(models, parseCatalog(payload()), "explicit").map(m => m.id), ["new", "absent", "image"]);
  assert.equal(filterVisible(models, undefined, "listed"), models);
});
test("reject empty, duplicate, invalid, future vocabulary and all-hidden catalogs", () => {
  for (const value of [
    {}, { ...payload(), fetched_at: "invalid" }, { ...payload(), models: [] },
    { ...payload(), models: [...payload().models, payload().models[0]] },
    { ...payload(), models: [{ slug: "x", visibility: "new-enum" }] },
    { ...payload(), models: [{ slug: "x", visibility: "hide" }] },
    { ...payload(), models: [null] },
  ]) assert.throws(() => parseCatalog(value));
});
test("configuration validates scope, mode and TTL", () => {
  const options = optionsFromEnv({ CODEX_HOME: "/example" });
  assert.equal(options.cachePath, "/example/models_cache.json");
  assert.equal(options.mode, "listed");
  for (const env of [
    { PI_CODEX_VISIBILITY_MODE: "bad" },
    { PI_CODEX_VISIBILITY_PROVIDERS: "anthropic" },
    { PI_CODEX_VISIBILITY_MAX_AGE_HOURS: "NaN" },
    { PI_CODEX_VISIBILITY_MAX_AGE_HOURS: "0" },
  ]) assert.throws(() => optionsFromEnv(env));
});
test("reader detects replacement, malformed writes, deletion, TTL and clock skew", () => {
  const dir = mkdtempSync(join(tmpdir(), "visibility-test-"));
  const path = join(dir, "models.json");
  let clock = now;
  const reader = new CatalogReader({ ...optionsFromEnv({}), cachePath: path, maxAgeMs: 1000 }, () => clock);
  try {
    assert.equal(reader.read(), undefined);
    writeFileSync(path, JSON.stringify(payload()));
    assert.equal(reader.read()?.visibility.get("new"), "list");
    clock += 1001;
    assert.equal(reader.read(), undefined);
    clock = now - 300001;
    assert.equal(reader.read(), undefined);
    clock = now;
    writeFileSync(path, "{");
    assert.equal(reader.read(), undefined);
    const replacement = payload();
    replacement.models[0].slug = "replacement";
    writeFileSync(path, JSON.stringify(replacement));
    assert.equal(reader.read()?.visibility.has("new"), false);
    assert.equal(reader.read()?.visibility.get("replacement"), "list");
    rmSync(path);
    assert.equal(reader.read(), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("provider wrapper preserves lookup catalog, auth, streams and native filters", () => {
  const reader = new CatalogReader(optionsFromEnv({}));
  reader.read = () => parseCatalog(payload());
  const base = {
    id: "openai", name: "OpenAI", auth: {},
    getModels: () => models,
    stream: () => {}, streamSimple: () => {},
    filterModels: (items: typeof models) => items.filter(m => m.id !== "absent"),
  } as unknown as Provider;
  const wrapped = withVisibility(base, reader);
  assert.equal(wrapped.getModels, base.getModels);
  assert.equal(wrapped.auth, base.auth);
  assert.equal(wrapped.stream, base.stream);
  assert.equal(wrapped.streamSimple, base.streamSimple);
  assert.ok(wrapped.getModels().some(m => m.id === "old"));
  assert.deepEqual(wrapped.filterModels!(base.getModels(), undefined).map(m => m.id), ["new", "image"]);
  assert.deepEqual(wrapped.filterAllModels!(base.getModels(), undefined).map(m => m.id), ["new", "image"]);
  base.filterAllModels = items => items.filter(m => m.id !== "new");
  assert.deepEqual(withVisibility(base, reader).filterAllModels!(base.getModels(), undefined).map(m => m.id), ["image"]);
});
