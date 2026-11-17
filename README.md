# pi-codex-visibility-filter

Show Codex-listed chat models in Pi without removing hidden models from direct lookup.
Uses the **Codex CLI's local model cache**, not a hand-maintained model-name blocklist.

## Install

Requires Pi's native Provider API; tested with **Pi 1.5.2**.

```sh
pi install git:github.com/80ROkWOC4j/pi-codex-visibility-filter
# Then /reload in Pi, or start a new Pi process.
```

Try without installing:

```sh
pi -e git:github.com/80ROkWOC4j/pi-codex-visibility-filter
```

For a local checkout, use `pi install .` from the repository directory.

This repository does not install itself or modify Pi/Paseo settings.

## Behavior

- Reads `$CODEX_HOME/models_cache.json` (default: `~/.codex/models_cache.json`).
- Defaults to both `openai` and `openai-codex`, including API-key-authenticated OpenAI.
  This is an intentional **display preference**, not a claim that Codex and the public API have identical availability.
- Default `listed` mode shows only chat model IDs present with `visibility: "list"`.
  Older IDs **absent** from the Codex catalog are hidden too.
- Optional `explicit` mode hides only explicitly non-listed rows; unknown IDs remain visible.
- Does not use `supported_in_api`: subscription-only listed models must not be excluded.
- No version-number inference, aliases, model capability changes, new model registration or reordering.
  Only the intersection with Pi's existing catalog can appear.
- Leaves non-chat models and other providers untouched.
- Keeps native authentication, token refresh and streaming.
- Preserves `getModels()`, direct model lookup, explicit `--model` resolution and session model restoration.
  It filters **availability**, not permissions; hidden models remain callable through direct lookup.
  **Exception:** Pi 1.5.2's RPC `set_model` only searches the available-model snapshot,
  so RPC/Paseo cannot switch to a hidden model through that command. Explicit CLI
  `--model` selection still works. No workaround or core patch is installed.
- Uses public native `filterModels` / `filterAllModels` hooks. No prototype patches.
- Missing, malformed, unsupported, empty, all-hidden or older-than-7-days cache:
  **fail open** (preserve Pi's native availability), with a startup warning.
- Reads no credentials; makes no network requests; writes no cache or auth files.
  Cache identity and unrelated fields are ignored and never displayed.

### Cache freshness and accounts

Run/login to Codex CLI to populate or refresh its cache. This extension does **not**
refresh the cache from OpenAI. It stats the file on availability evaluation and
reparses when it changes. Pi's synchronous available-model list is a snapshot;
use `/codex-visibility refresh`, reopen `/model`, or reload Pi to recompute it.

The cache is account-specific. We deliberately do not read credentials to match
accounts. Select the cache for the same account/workspace you intend to mirror.
A different account's cache may produce a misleading display policy; it never
grants access to a model.

## Commands

- `/codex-visibility` or `/codex-visibility status`: path, state, mode, providers,
  catalog timestamp and listed-model count (no tokens or account IDs).
- `/codex-visibility refresh`: recompute Pi model availability without network access.
  Does not refresh Codex's cache.

## Configuration

Environment variables, read when the extension loads:

| Variable | Default | Meaning |
|---|---|---|
| `PI_CODEX_VISIBILITY_CACHE` | `$CODEX_HOME/models_cache.json` | Explicit cache file; supports leading `~/` |
| `PI_CODEX_VISIBILITY_PROVIDERS` | `openai,openai-codex` | Comma-separated subset of these two providers |
| `PI_CODEX_VISIBILITY_MODE` | `listed` | `listed` or `explicit` |
| `PI_CODEX_VISIBILITY_MAX_AGE_HOURS` | `168` | Positive cache TTL |
| `CODEX_HOME` | `~/.codex` | Codex home when no explicit cache is given |

Example, affecting legacy Codex only:

```sh
PI_CODEX_VISIBILITY_PROVIDERS=openai-codex pi
```

Invalid configuration prevents this extension from registering; Pi reports the
extension load error rather than silently using a different policy.

## Pi and Paseo integration

Pi availability consumers (the model picker, normal cycling, RPC
`get_available_models`, and `--list-models`) use the native availability
filter when this extension is loaded. Real Pi 1.5.2 subprocess tests verify the
CLI listing, RPC listing, explicit CLI selection of a hidden model, RPC switching
restriction, and fail-open behavior. Raw/full-catalog consumers intentionally
still see hidden models. Explicitly scoped model cycles may retain models selected
before a policy change; reload/re-resolve the scope when changing policy.

For Paseo, install on the **daemon's** Pi environment, not merely the UI machine.
It must load this extension and query Pi's filtered availability. A host that
uses an independent/raw catalog, disables extensions, or caches its model list
will need integration work. Paseo's inspected Pi provider implementation starts a
Pi session and calls RPC `get_available_models`; that exact RPC path was tested
with Pi. Model filtering in the Paseo UI has also been manually confirmed in a
local setup. Other daemon environments and versions may differ.
A Pi extension cannot force a separate process to filter its own catalog.

This extension wraps the built-in providers during factory loading. Another
extension replacing `openai`/`openai-codex` may overwrite it (or be overwritten);
do not combine provider replacements without composing their behavior explicitly.
Pi's `models.json` overrides remain composed above the registered provider.

## Development

```sh
npm install --ignore-scripts
npm test
npm run check
npm run test:integration  # requires pi on PATH, or PI_TEST_BIN=/path/to/pi
```

Pi supplies the peer dependencies at runtime. To check against a specific Pi
release, make its `@earendil-works/pi-ai` and `pi-coding-agent` packages available
in local `node_modules` (or install those peers for development). Runtime has no
additional dependencies.

Tests use synthetic caches and do not call OpenAI. The subprocess integration test
uses a temporary Pi home and a dummy API key; it does not read or change user auth.
No prompts/inference requests are sent.
