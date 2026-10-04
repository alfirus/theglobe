# ADR 0001 — Use SvelteKit Routes as the Bridge

**Status:** Superseded by ADR 0002 (Go backend for The Globe) — 3 October 2026 (was: Accepted — 25 September 2026)
**Date:** 2026-09-25
**Deciders:** Owner (alfirus)

> ADRs are immutable once accepted. If the decision changes, supersede this
> record with a new ADR (`docs/adr/0002-…`) rather than editing this file.
> See the org ADR standard (tech-writing skill / DOCS.md registry).

## Context

BLUEPRINT.md specifies a dedicated WebSocket bridge server on port 8742
(CORS proxy, audio relay, session sync, health aggregation) sitting between
the SvelteKit frontend and the Hermes Agent API server on port 8642, plus an
Electron shell wrapping the whole app in a transparent window.

Reality at the time of this decision (verified in the 2026-09-25 review
report, Section B §2):

- There is no `bridge/` directory, and nothing in `frontend/src` references
  WebSocket, port 8742, or `ws://`.
- The running system calls plain `fetch('/api/chat' | '/api/tts' |
  '/api/health' | '/api/settings' | '/api/stats')` from `+page.svelte`,
  which resolve to SvelteKit server routes under
  `frontend/src/routes/api/*/+server.ts`. Those routes proxy to
  OpenAI-compatible LLM providers (streaming SSE for chat) and to Piper for
  TTS.
- The browser does not need a CORS proxy: the SvelteKit server is the same
  origin, so CORS is a non-issue for the current architecture.
- The Electron shell (Phase 6) is not started either.

Forces at play:

1. The bridge was designed for things the app does not do yet — streaming
   audio chunks to/from the browser, session-state sync over a long-lived
   socket, and relaying Hermes-side STT/TTS.
2. Chat and TTS ship today through HTTP, and HTTP/SSE is simpler to run,
   debug, and deploy (no second process, no port to manage).
3. Rewriting the docs to match reality is cheap; building a bridge that
   nothing currently needs is not.
4. The vision (audio-reactive animation, chunked TTS, a desktop shell) still
   matters and should not be thrown away — it should be deferred, not
   deleted.

Alternatives considered:

- **Build the :8742 WebSocket bridge now** — rejected: no current feature
  requires it; it would add a process and a protocol for zero user value
  today.
- **Keep documenting the bridge as if it existed** — rejected: docs would
  keep describing a system that does not exist.
- **Replace SvelteKit with a plain SPA + separate Node server** — rejected:
  the SvelteKit server routes already provide the server side we need.

## Decision

SvelteKit `/api/*` server routes are the integration layer between the
frontend and the LLM/TTS backends; the WebSocket bridge (port 8742) and the
Electron shell are deferred, not built, and will only be reconsidered once
streaming audio chunks (chunked STT/TTS relay) actually require a
long-lived socket.

## Consequences

- Better: one process, one origin, no CORS handling, no extra port —
  `npm run dev` in `frontend/` is the whole system.
- Better: docs, architecture diagrams, and code now describe the same
  thing; the review's top doc/reality mismatch is closed.
- Better: HTTP/SSE streaming for chat is already proven in the shipped
  provider routes.
- Worse: no long-lived channel, so any future feature needing real-time
  bidirectional audio (chunked TTS playback, live STT partials, push state
  updates) must either add the bridge or adopt a new transport — this ADR
  does not pre-approve one.
- Worse: session state lives in the browser (IndexedDB conversations) and
  is not synchronised with a server-side session.
- Costs more: nothing now; the deferred bridge, if later built, still has
  to be designed from BLUEPRINT §9 essentially from scratch.
- Simplifies: BLUEPRINT sections describing the bridge, the WebSocket
  protocol, and the Electron shell are labelled **planned / not built**
  rather than presented as current architecture.
