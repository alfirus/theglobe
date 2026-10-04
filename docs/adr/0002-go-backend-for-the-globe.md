# ADR 0002 — Go Backend for The Globe

**Status:** Proposed — awaiting owner acceptance (requested 2026-10-03)
**Date:** 2026-10-03
**Deciders:** Owner (Joyah/Sofia) — decision recorded 2026-09-29; drafted by Maisarah (EM)
**Supersedes:** the core clause of ADR 0001 ("SvelteKit server routes are the bridge")

> ADRs are immutable once accepted. If this decision changes, supersede this
> record with a new ADR (`docs/adr/0003-…`) rather than editing this file.

## Context

Owner decision (Joyah/Sofia, 2026-09-29): **The Globe's backend must be written
in Go.** This supersedes ADR 0001's core clause; ADR 0001 is marked Superseded
(Status field only) and is otherwise untouched.

Reality at drafting (`origin/main` @ `12ba165`, after the P1 merge train
PRs #11–#19 landed 2026-09-28 → 2026-10-02):

- The service layer is SvelteKit server routes under
  `frontend/src/routes/api/*` — **seven routes, not five**: the P1 train added
  `/api/stt` and `/api/tts/stream` alongside `/api/chat`, `/api/tts`,
  `/api/health`, `/api/settings`, `/api/stats` (~1.9k LOC), plus
  `src/lib/config.ts` (the single validated config + `/api/*` guard module,
  security-reviewed) and `src/lib/server/tts.ts`.
- Contract highlights that must survive the swap: `/api/chat` relays upstream
  SSE unchanged (`data: {"content":…}` / `data: {"thinking":…}` /
  `data: [DONE]`) with per-uplink timeouts and structured errors; `/api/tts`
  returns a WAV and spawns `piper` with `shell: false` (the C1/M5 RCE fix);
  `/api/tts/stream` frames per-sentence audio exactly like `/api/chat`;
  `/api/stt` drives a warm Python `stt_worker.py` over NDJSON; `/api/settings`
  never echoes key material (whitelisted view); everything runs through
  `assertApiRequest` (Origin/fetch-metadata checks, timing-safe `API_SERVER_KEY`,
  loopback-`Host` rule against DNS rebinding).
- The frontend fetches same-origin relative `/api/*` from the client;
  `adapter-node` emits a standalone Node server (`node build`).
- An Electron shell landed 2026-09-30 (commit `b430d2d`): the packaged app
  spawns the adapter-node server as a child on a free loopback port and opens a
  BrowserWindow against it.
- CI gate (`.github/workflows/ci.yml`): svelte-check → ESLint/Prettier → Vitest
  (per-route contract tests in `frontend/tests/api/*`) → Playwright smoke → build.
- Ops runtimes today: Node 26 for the server, `piper` CLI for TTS, a Python
  Whisper worker for STT. Dev runs on this PC (Windows, git-bash).

Forces:

1. Owner ops preference: a **single backend binary** (build once, run anywhere,
   no Node runtime in the ops path).
2. New requirement — the **Desktop-file bridge**: files created on this PC's
   Desktop must be viewable from The Globe in a browser, including on other
   devices over the tailnet. That is a long-lived, concurrency-friendly
   file + streaming server, reachable off-loopback under the shared-secret model.
3. Contract stability: `/api/chat` SSE behavior must stay identical, and the P1
   test suite must stay green across the migration.
4. The deferred :8742 WebSocket bridge (ADR 0001) and the blueprint's
   "globe as agent" target need a long-lived process home; the backend swap is
   the moment to settle where those duties live.

Alternatives considered:

- **Keep the SvelteKit routes as the backend** — rejected: the owner's decision
  is explicit, and forces 1/2/4 need a service beyond request-scoped Node routes.
- **Node/Express (Fastify) sidecar** — rejected: keeps Node in ops, adds a
  process without the ops win.
- **Go service called cross-origin from the browser (direct to :8787)** —
  rejected: breaks the same-origin exemption in `assertApiRequest`, forces CORS,
  and pushes the shared secret into browser code.
- **SvelteKit stays the permanent edge and proxies `/api/*` to Go** — rejected
  as an end state: keeps Node in the ops path and adds a hop to every SSE
  stream. Acceptable only as a transitional dev-mode arrangement (Phase 2).
- **Rewrite/replace the frontend** — rejected: out of scope; the owner decided
  the backend language, not the frontend framework.

## Decision

1. **Go service `globe-server`.** The service layer becomes a Go 1.26 binary in
   a new `server/` module (`github.com/alfirus/theglobe/server`) that owns every
   `/api/*` path. **Contract parity is the law**: same paths, methods,
   request/response shapes, SSE frame bytes, `{error}` JSON with the same status
   codes (400/401/403/413/502/503/504), same headers (`X-Uplink-Mode`,
   `X-Agent`, `X-Provider`, legacy `X-System-Prompt`), and the same env-var and
   settings-file contracts (`HERMES_API_KEY_*`, `API_SERVER_KEY`, `PIPER_MODEL`,
   `TTS_TIMEOUT_MS`, `STT_*`, `GLOB_ALLOWED_ORIGINS`, `.globe-settings.json`).
   The Vitest contract tests are ported 1:1 as Go table tests and must pass
   before each route flips.

2. **Process topology: SvelteKit frontend + Go backend.**
   - *Dev (this PC, git-bash):* `vite dev` + `go run ./server`; Vite proxies
     `/api` → `127.0.0.1:8787` (`GLOBE_API_PORT`). Same-origin from the
     browser's point of view — no CORS, no secret in the client.
   - *Production (end state, Phase 3):* `globe-server` serves `/api/*` **and**
     the built frontend static assets — one binary, one port. `adapter-node` is
     retired; the Electron shell spawns `globe-server` instead of `node build`.
   - *Speech engines* (`piper`, `stt_worker.py`) stay external child processes
     spawned by `globe-server` with `shell: false` semantics preserved verbatim
     (the RCE fix is a port requirement, not a nice-to-have). "Single binary"
     means the service, not the speech toolchain.

3. **Desktop-file bridge** — `GET /api/files` (listing) and
   `GET /api/files/:name` (content), a new surface owned by Go from day one:
   read-only; name sanitisation (no traversal, no separators, no symlink escape
   from the root); extension allowlist + per-file size cap;
   `GLOBE_FILES_ROOT` (default: the current user's Desktop). Auth is identical
   to the rest of `/api/*` (origin/fetch-metadata checks + `API_SERVER_KEY` for
   anything off-loopback). Tailnet reachability is served by binding
   `globe-server` to the tailnet interface with the shared secret required for
   non-loopback hosts — the existing `assertApiRequest` rule-4 semantics.

4. **Hermes-agent integration runs on Go.** The blueprint's "globe as agent"
   target moves from the SvelteKit routes to `globe-server`: the
   OpenAI-compatible uplink to the Hermes Agent API server (:8642) / OpenClaw
   keeps its exact wire contract (`X-Uplink-Mode: agent`, `X-Agent: …`), now
   implemented in Go. The :8742 WebSocket bridge stays unbuilt; any future
   real-time duty (audio chunks, session sync, agent push) lands in
   `globe-server`. In short: **bridged, with `globe-server` as the bridge** —
   not a separate bridge process.

5. **Phasing (P1-safe).** The P1 merge train (PRs #11–#19) landed through
   2026-10-02, and Go work proceeds as follow-up phases **behind the same
   paths**, so any hotfix against the TS routes still lands cleanly:
   - **Phase 1** — `server/` scaffold + config/security parity +
     `/api/files` bridge (new surface only; zero risk to the running TS system).
   - **Phase 2** — port the seven routes to Go; dual-run parity harness (the
     same fixtures against TS and Go, SSE bytes compared); TS routes remain the
     default until parity sign-off.
   - **Phase 3** — cutover: frontend default to `globe-server` (Vite proxy in
     dev, static serving in prod), delete the TS `api/*` routes, retire
     `adapter-node`, swap the Electron child. The CI gate stays
     (svelte-check → lint → unit → smoke → build) and gains the Go tests.
   Each phase is its own PR referencing ADR 0002 in the PR template's
   `## ADR` field.

## Consequences

- **Positive:** one deployable backend artifact (cross-compiled `globe-server.exe`
  for this Windows PC; no Node runtime in the ops path after Phase 3); the
  Desktop-file bridge and future agent/real-time duties get a natural long-lived
  home with first-class tailnet serving; SSE/chat behavior stays byte-compatible
  by test contract, with the P1 suite as the migration's safety net; ADR 0001's
  deferred-bridge question closes — the Go service absorbs those duties if and
  when they are needed.
- **Negative:** a two-language repo (TS frontend + Go backend) — contributors
  need a Go 1.26 toolchain and CI grows a Go setup step; ~1.9k LOC of validated
  TS, including the security-reviewed `config.ts` guard, must be re-expressed in
  Go (the security rules — timing-safe secret compare, Origin/fetch-metadata
  checks, URL allowlist incl. 100.64/10, RCE-safe spawns — are ported as
  behavior and get a security review at Phase 2); until Phase 3 there are two
  implementations of the same routes to keep in sync for hotfixes; Electron
  packaging needs rework in Phase 3 (child spawn + bundling the Go binary).
- **Assumptions:** Go 1.26 is available on the dev/ops PC (verified:
  `go1.26.4 windows/amd64`) and `piper` + the Python Whisper worker stay as-is;
  the seven-route surface is stable enough that parity testing is mechanical,
  and any route added by an open PR is ported under the same contract rule;
  same-origin serving remains acceptable (no separate frontend host), so the
  shared-secret model keeps working unchanged.

## References

- ADR 0001 — `docs/adr/0001-use-sveltekit-routes-as-the-bridge.md` (superseded
  by this record; Status field changed only)
- Owner decision 2026-09-29 (Joyah/Sofia) — kanban card `t_af64099c`
- BLUEPRINT.md §9 (Hermes integration), §10 (desktop shell)
- P1 merge train: PRs #11–#19 (2026-09-28 → 2026-10-02)
- Security contract: `frontend/src/lib/config.ts` (cards `t_afd2c465`,
  `t_cc46938d`); CI baseline: `.github/workflows/ci.yml` (card `t_644b7899`)
