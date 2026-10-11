# globe-server (ADR-0002 Phase 1)

Go backend for The Globe. Phase 1 scope is deliberately narrow: the HTTP
service shell plus the config/security core ported from
`frontend/src/lib/config.ts`. The seven SvelteKit `/api/*` routes stay the
default until the Phase 3 cutover — this module implements **none** of them
yet (Phase 2, Lisa's card), so there is zero risk to the running TS system.

## Layout

- `cmd/globe-server` — entrypoint: binds `GLOBE_API_HOST` (default
  `127.0.0.1`, loopback only) + `GLOBE_API_PORT` (default `8787`), clean
  shutdown on SIGINT/SIGTERM (10 s drain), secret-free request logs.
- `internal/config` — behavior port of `frontend/src/lib/config.ts`: settings
  file (`.globe-settings.json`, 64 KiB cap, 0600), key precedence
  (file → per-provider/agent env → generic `HERMES_API_KEY` → `""`), upstream
  URL allow-list (loopback, RFC1918, 100.64/10 CGNAT, documented hosts +
  `GLOB_ALLOWED_ORIGINS`), `POST /api/settings` sanitise + merge (whitelist
  projection, explicit-clear `""` rotation path), key-free public view,
  TTS resolution + budgets, and the `assertApiRequest` guard
  (`AssertAPIRequest`: Origin/`Sec-Fetch-Site` rejection, timing-safe
  `API_SERVER_KEY` compare via `Authorization: Bearer` / `X-API-Key`,
  loopback-Host rule against DNS rebinding).
- `internal/server` — mux: `GET /healthz` liveness (`{"service":
  "globe-server","status":"ok"}`); the Phase 1b Desktop-file bridge
  (`GET /api/files` listing + `GET /api/files/:name` file bytes, in
  `internal/files`); every remaining `/api/*` path passes the guard then
  gets a JSON 404 until Phase 2 ports the routes. Request logs carry routing
  metadata only (method, path, status, bytes, ms) — never headers, query
  strings or bodies (C4 rule, enforced by construction + test).

## Run (dev)

```sh
go run ./cmd/globe-server            # 127.0.0.1:8787
GLOBE_API_PORT=8787 go run ./cmd/globe-server
GLOBE_USE_GO=1 npm run dev --prefix ../frontend   # Vite proxies /api → Go
```

`GLOBE_USE_GO` defaults to **off** — without it, Vite serves the SvelteKit
TS routes as before. `GLOBE_API_HOST` exists for the tailnet bind Phase 1b/2
needs; leave it loopback in dev.

## Test

```sh
go vet ./... && go test ./...
```

The Go tests in `internal/config` mirror `frontend/tests/config.test.ts`
1:1 (same fixtures, same expectations). If a behavior diverges from
`config.ts`, the fix lands here — the Vitest suite is the ratified contract.

## Env contracts (identical to config.ts)

`HERMES_API_KEY_<PROVIDER>` · `HERMES_API_KEY` · `HERMES_API_KEY_<AGENT>`
(`_HERMES_AGENT` / `_OPENCLAW_AGENT`) · `VOICE_TOOLS_OPENAI_KEY` /
`OPENAI_API_KEY` · `ELEVENLABS_API_KEY` · `API_SERVER_KEY` · `PIPER_MODEL` ·
`TTS_TIMEOUT_MS` · `TTS_MAX_CONCURRENT` · `GLOB_ALLOWED_ORIGINS` ·
`GLOBE_API_HOST` / `GLOBE_API_PORT` (server bind only).

`STT_*` knobs (`STT_PYTHON`, `STT_WORKER`, `STT_MODEL`, `STT_LANGUAGE`,
`STT_TIMEOUT_MS`) are route-level — they arrive with the `/api/stt` port in
Phase 2, not here.

## Desktop-file bridge (Phase 1b)

Read-only viewer for the owner's Desktop, surfaced in the visor as the
Files panel (same-origin `/api/files`):

- `GET /api/files` → `[{name, size, modified, contentType}]` — only
  servable files are listed (allow-listed extension, within the size cap).
- `GET /api/files/:name` → file bytes with `Content-Disposition: inline`
  (viewable types), `X-Content-Type-Options: nosniff`. `.svg` is served as
  `text/plain`, never `image/svg+xml` — inline SVG executes script, and the
  bridge previews files; it must not become a stored-XSS vector.
- Both routes run `AssertAPIRequest` first: tailnet devices authenticate
  with `API_SERVER_KEY`; there are no anonymous off-loopback reads. Names
  are bare file names only — traversal, separators, absolute paths, drive
  letters, and symlinks escaping the root are rejected.

`GLOBE_FILES_ROOT` (default: current user's Desktop) ·
`GLOBE_FILES_EXT` (default: `pdf,png,jpg,jpeg,gif,webp,svg,txt,md,csv`) ·
`GLOBE_FILES_MAX_BYTES` (default: 10 MiB, fails closed on garbage).

## ADR

Implements ADR-0002 Phase 1 (scaffold + config/security parity) — see
https://github.com/alfirus/theglobe/pull/20
(`docs/adr/0002-go-backend-for-the-globe.md` once that PR merges).
