import { test } from "node:test";
import assert from "node:assert/strict";
import type { Credential, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { CatalogClient, CATALOG_URL, parseRows, processCache, type ProcessCache } from "../src/catalog.ts";
import { withVisibility } from "../src/provider.ts";

function credential(clientId = "test-grant"): Extract<Credential, { type: "oauth" }> {
  return { type: "oauth", clientId, scopes: ["chatgpt.tokens.use.direct"], access: "opaque-test-access", refresh: "secret-refresh", expires: Date.now() + 86400000 };
}
const readCredential = async () => credential();
const remote = { models: [{ slug: "new", visibility: "list", supported_in_api: false, extra: "ignored" }, { slug: "old", visibility: "hide" }, { slug: "none", visibility: "none" }] };
const models = [{ id: "new" }, { id: "old" }, { id: "absent" }, { id: "none" }, { id: "image", type: "image" }];
const ids = (items: readonly { id: string }[]) => items.map(m => m.id);
function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return { credential: credential(), allowNetwork: true, signal: new AbortController().signal,
    publish: async p => { p.update?.(); return true; }, ...overrides };
}
const ok = (async () => Response.json(remote)) as typeof fetch;
const client = (fetcher = ok, cache: ProcessCache = {}) => new CatalogClient(cache, fetcher);

test("parse visibility metadata; reject public API-key response shape and malformed catalogs", () => {
  assert.deepEqual(parseRows(remote)[0], { slug: "new", visibility: "list" });
  for (const raw of [{ data: [{ id: "new" }] }, {}, { models: [] }, { models: [null] },
    { models: [...remote.models, remote.models[0]] }, { models: [{ slug: "x", visibility: "unknown" }] },
    { models: [{ slug: "x", visibility: "hide" }] },
  ]) assert.throws(() => parseRows(raw));
});

test("OpenAI OAuth endpoint is fixed; redirects rejected; subscription-only models retained", async () => {
  const catalog = client(async (url, init) => {
    assert.equal(String(url), CATALOG_URL);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer opaque-test-access");
    assert.equal(headers.get("ChatGPT-Account-Id"), null);
    return Response.json(remote);
  });
  await catalog.refresh(context());
  assert.deepEqual(ids(catalog.filter(models, credential())), ["new", "image"]);
});

test("one request per process despite force, reload, new session or token rotation", async () => {
  const cache: ProcessCache = {};
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(remote); };
  const first = client(fetcher, cache);
  await first.refresh(context());
  await first.refresh(context({ force: true }));
  const reloaded = client(fetcher, cache);
  await reloaded.refresh(context({ credential: { ...credential(), access: "rotated-access" }, force: true }));
  assert.deepEqual(ids(reloaded.filter(models, credential())), ["new", "image"]);
  assert.equal(calls, 1);
  assert.equal(processCache(), processCache());
});

test("changed account fails open without fetching again", async () => {
  let calls = 0;
  const cache: ProcessCache = {};
  const catalog = client(async () => { calls++; return Response.json(remote); }, cache);
  await catalog.refresh(context());
  await catalog.refresh(context({ credential: credential("another-grant") }));
  assert.equal(catalog.filter(models, credential("another-grant")), models);
  assert.equal(catalog.filter(models, undefined), models);
  assert.equal(calls, 1);
});

test("offline, API-key, and other OAuth credentials never consume the attempt", async () => {
  let calls = 0;
  const catalog = client(async () => { calls++; return Response.json(remote); });
  await catalog.refresh(context({ allowNetwork: false }));
  await catalog.refresh(context({ credential: { type: "api_key", key: "dummy" } }));
  await catalog.refresh(context({ credential: undefined }));
  const otherOAuth = { ...credential(), scopes: ["resource.invoke"] };
  await catalog.refresh(context({ credential: otherOAuth }));
  await catalog.refresh(context({ credential: { ...credential(), clientId: "" } }));
  assert.equal(calls, 0);
  assert.equal(catalog.status().attempted, false);
  await catalog.refresh(context());
  assert.equal(calls, 1);
  assert.equal(catalog.filter(models, otherOAuth), models);
});

test("failed, invalid and oversized requests fail open and are not retried in this process", async () => {
  for (const response of [new Response("secret", { status: 401 }), new Response("secret", { status: 500 }),
    Response.json({ models: [] }), new Response("bad JSON"), new Response("x".repeat(8 * 1024 * 1024 + 1))]) {
    let calls = 0;
    const catalog = client(async () => { calls++; return response; });
    await catalog.refresh(context());
    await catalog.refresh(context({ force: true }));
    assert.equal(calls, 1);
    assert.equal(catalog.filter(models, credential()), models);
    assert.ok(catalog.status().error);
    assert.ok(!JSON.stringify(catalog.status()).includes("secret"));
  }
});

test("concurrent startup refreshes share one request; cancelling one waiter cannot cancel another", async () => {
  let calls = 0;
  let finish: (response: Response) => void = () => {};
  const catalog = client(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const controller = new AbortController();
  const first = catalog.refresh(context({ signal: controller.signal }));
  const rejection = assert.rejects(first);
  const second = catalog.refresh(context());
  controller.abort();
  finish(Response.json(remote));
  await Promise.all([rejection, second]);
  assert.equal(calls, 1);
  assert.deepEqual(ids(catalog.filter(models, credential())), ["new", "image"]);
});

test("provider composition keeps native auth, lookup, transport and filters", async () => {
  const catalog = client();
  await catalog.refresh(context());
  const base = { id: "openai", name: "OpenAI", auth: {}, getModels: () => models,
    stream: () => {}, streamSimple: () => {}, filterModels: (items: typeof models) => items.filter(m => m.id !== "absent"),
  } as unknown as Provider;
  const wrapped = withVisibility(base, catalog, readCredential);
  for (const key of ["auth", "getModels", "stream", "streamSimple"] as const) assert.equal(wrapped[key], base[key]);
  assert.ok(wrapped.getModels().some(m => m.id === "old"));
  assert.deepEqual(ids(wrapped.filterAllModels!(base.getModels(), credential())), ["new", "image"]);
  base.filterAllModels = items => items.filter(m => m.id !== "new");
  assert.deepEqual(ids(withVisibility(base, catalog, readCredential).filterAllModels!(base.getModels(), credential())), ["image"]);
});

test("provider wrapper preserves models and metadata added by native refresh", async () => {
  const catalog = client();
  let current = [{ id: "old", contextWindow: 100 }];
  let refreshes = 0;
  const base = {
    id: "openai", name: "OpenAI", getModels: () => current,
    async refreshModels(ctx: RefreshModelsContext) {
      refreshes++;
      await ctx.publish({ update: () => { current = [...current, { id: "new", contextWindow: 200 }]; } });
    },
  } as unknown as Provider;
  const wrapped = withVisibility(base, catalog, readCredential);
  await wrapped.refreshModels!(context());
  assert.equal(refreshes, 1);
  assert.deepEqual(ids(wrapped.getModels()), ["old", "new"]);
  assert.deepEqual(wrapped.filterAllModels!(wrapped.getModels(), credential()), [{ id: "new", contextWindow: 200 }]);
});

test("native refresh failure still awaits visibility before returning the error", async () => {
  let complete: (response: Response) => void = () => {};
  const catalog = client(() => new Promise(resolve => { complete = resolve; }));
  const failure = new Error("native catalog unavailable");
  const base = { refreshModelsAuth: "configured", refreshModels: () => { throw failure; } } as unknown as Provider;
  const wrapped = withVisibility(base, catalog, readCredential);
  assert.equal(wrapped.refreshModelsAuth, "configured");
  let settled = false;
  const refresh = wrapped.refreshModels!(context());
  const rejected = assert.rejects(refresh, error => {
    settled = true;
    return error === failure;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  complete(Response.json(remote));
  await rejected;
  assert.deepEqual(ids(catalog.filter(models, credential())), ["new", "image"]);
});
