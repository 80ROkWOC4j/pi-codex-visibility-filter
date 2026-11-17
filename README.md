# pi-codex-visibility-filter

| Before | After |
|---|---|
| <img src="asset/before.png"> | <img src="asset/after.png"> |
| 68 models, include legacy models | 30+ models filtered |

Filter Pi’s model list using visibility metadata from OpenAI’s model catalog like Codex.
Uses Pi's built-in `openai` ChatGPT login. Codex CLI is optional.
Tested with Pi 1.5.2. The extension uses Pi's internal provider composition hook.

## Install

```sh
pi install git:github.com/80ROkWOC4j/pi-codex-visibility-filter
```

Restart Pi. If needed, run `/login openai` and choose **Sign in with ChatGPT**.

## Behavior

- Shows only models marked `visibility: "list"` from Pi's existing catalog; does not add models.
- Hidden models remain usable through CLI `--model`, but not RPC `set_model`.
- Fetches the live visibility catalog on Pi start. Restart Pi to fetch it again.
- Pi refreshes its own models and applies `models.json` changes normally. Offline mode and catalog or authentication failures leave Pi's available models visible.

Run `/codex-visibility` to check status.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run test:integration
```
