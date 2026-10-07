# pi-cache-guard

A [Pi](https://pi.dev) extension that asks before a prompt would re-cache a large conversation,
and shows how long the prompt cache has left. Part of the cache-guard family:
[claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard),
[opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard) and
[codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard) share its core
(`src/core.ts`) and settings file.

## What it does

**Warns.** Anthropic keeps a cached prompt prefix for its TTL (5 minutes, or 1 hour with
`PI_CACHE_RETENTION=long`) from the start of the last request that used it. The first prompt after
that writes the whole conversation to the cache again, at 1.25x (or 2x) the input price instead of
0.05-0.1x for a read. When that rewrite would cost at least `warn.minCost` (default $0.50 at API
prices), the prompt waits for a confirm dialog:

```
The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).
Send anyway? (No keeps the prompt in the editor; /compact or /new first is cheaper.)
```

It also asks when the selected model differs from the one the conversation was cached for (each
model has its own cache). For models without a published TTL (OpenAI and Codex models) it asks
after `warn.idleMinutes` (default 180) idle, worded as a likelihood. Commands (`/...`), shell
input (`!...`), steering and follow-ups while the agent runs, and input from other extensions are
never held.

**Shows the clock.** The `cache-guard` status reads `cache 4:12` (time left), `cache cold`,
`cache cold (model)` or `cache cold?` (no TTL known, long idle). pi-status-footer folds it into its
context row.

**Keeps the cache warm: not here.** Pi does that itself. Set `"cacheWarming": "idle"` in
`~/.pi/agent/settings.json`: Pi then re-sends the last request with a one-token output cap at 90%
of the TTL, between runs too, while the expected saving is at least $0.05 and for up to 30 minutes
after the last real request (`/session` shows its next decision). Those refreshes are recorded as
`cache_warm` usage entries, and this extension's clock counts the ones that hit the cache.
`showCacheMissNotices: true` makes Pi print a line for each refresh and each significant miss.

## Commands

- `/cache-guard` or `/cache-guard status`: the last request, TTL, time left or why it is cold, and
  whether the next prompt will ask.
- `/cache-guard on`, `/cache-guard off`: for this session.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.pi/agent/cache-guard.json`,
then the project's `.agents/cache-guard.json` and `.pi/cache-guard.json`. Later files win; objects
merge. Pi reads `enabled` and `warn`:

```json
{ "enabled": true, "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "idleMinutes": 180 } }
```

`minTokens` applies only to models Pi has no prices for. `warm` settings are for the ports whose
harness has no built-in warming.

## Limits

- The clock is the API's guaranteed minimum, measured from each request's start; entries are
  deleted soon after it, not exactly at it. Other invalidations (tool or system prompt changes,
  an MCP server reconnecting) are not visible to it.
- Images attached to a held prompt are not put back in the editor.

## Development

```sh
npm ci && npm run check
pi -e ./src/index.ts
```
