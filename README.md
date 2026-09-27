# The Globe

A living neural electric globe — a visual AI interface with voice interaction.

Not a solid orb. A network of glowing neuron nodes, electric connections, and traveling sparks shaped into a sphere. The globe IS the agent.

## What Is This?

The Globe Interface is a locally-hosted, visually reactive **neural electric globe** that acts as a physical embodiment of an AI agent.

Today it runs as a **SvelteKit app in your browser** — no desktop shell yet. The floating transparent window (Electron) is planned, not built; see [ADR-0001](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md) and the phase table below.

The LLM calls come from the app's own server routes to an OpenAI-compatible provider (LM Studio at `127.0.0.1:1234` by default). The deeper [Hermes Agent](https://hermes-agent.nousresearch.com/) integration — skills, memory, sessions, tools — is the target architecture: the chat route currently sends a stateless message list, so no conversation history, session, or tool use reaches the model yet.

## ✨ Features

Shipped:

- **Neural Electric Visual** — 680 nodes (18 clusters × 35 + 50 core), dynamic connections, traveling sparks, UnrealBloom glow
- **Streaming text chat** — multi-provider (SSE), conversation sidebar with IndexedDB persistence, markdown rendering
- **Voice input** — Web Speech API, Chrome/Edge only
- **Voice output** — Piper TTS (local model), audio playback in the page
- **Settings + device stats** — provider configuration UI, cross-platform system stats

Planned (not built): transparent Electron window, mood/color-shifting states beyond the current thinking/speaking treatments, audio-reactive animation, Hermes skills/memory/tools.

## 🏗️ Architecture

```
┌──────────────────────────────────────┐
│  Browser tab                          │
│  └── SvelteKit + Three.js             │
│      ├── Neural Globe (GLSL + bloom)  │
│      └── Chat UI · Settings · Stats   │
└──────────────┬────────────────────────┘
               │  fetch() — same origin
┌──────────────┴────────────────────────┐
│  SvelteKit server routes (:5173 dev)  │  ← the integration layer
│  frontend/src/routes/api/*            │
│    POST   /api/chat     SSE streaming │
│    POST   /api/tts      Piper TTS     │
│    GET/POST /api/settings provider cfg│
│    GET    /api/stats    device stats  │
│    POST   /api/health   provider check│
└──────────────┬────────────────────────┘
               │  HTTP (OpenAI-compatible) / local process
┌──────────────┴────────────────────────┐
│  LLM: LM Studio :1234 (or any         │
│       OpenAI-compatible provider)     │
│  TTS: local Piper voice model         │
└───────────────────────────────────────┘

Planned, deferred (see ADR-0001):
  • WebSocket bridge :8742  • Electron transparent window
```

There is no bridge process and no Electron shell in this repo — the SvelteKit `/api/*` routes *are* the bridge.

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/alfirus/theglobe.git
cd theglobe/frontend

# Install
npm install

# Run
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

TTS needs a local Piper voice model; provider settings are entered in the in-app Settings panel.

## 🎨 Visual Design

The globe is **not a solid sphere**. It looks like electric neurons in a glob form:

- **Nodes** — Sharp bright points (Fibonacci sphere distribution)
- **Connections** — Dynamic lines between nearby nodes (form/dissolve)
- **Sparks** — Bright pulses traveling along connections
- **Core** — Central glow with heartbeat rhythm
- **Ambient** — Floating particles for depth

### Color States

The full palette below is the design target. **Implemented today:** two treatments — amber nodes while speaking, a bloom pulse while thinking. The rest (listening, error, mood drift) is not built yet.

| State | Color | Status |
|-------|-------|--------|
| Idle | Soft electric blue | ✅ Built |
| Listening | Blue brightens + white sparks | 🔲 Planned |
| Thinking | Deep blue → purple | ✅ Built (bloom pulse) |
| Speaking | Warm amber/gold | ✅ Built (amber nodes) |
| Error | Red flash | 🔲 Planned |

## 📁 Project Structure

```
theglobe/
├── frontend/                # SvelteKit + Three.js app
│   └── src/
│       ├── routes/
│       │   ├── +page.svelte        # Main page: chat UI, globe, playback
│       │   └── api/                # Server routes (the "bridge")
│       │       ├── chat/           #   POST   streaming chat
│       │       ├── tts/            #   POST   Piper TTS
│       │       ├── settings/       #   GET/POST provider config
│       │       ├── stats/          #   GET    device stats
│       │       └── health/         #   POST   provider health
│       └── lib/
│           ├── glob/               # NeuralGlobe.svelte, nodes.ts,
│           │                       # connections.ts, sparks.ts, core.ts,
│           │                       # ambient.ts, neuralActivity.ts,
│           │                       # electricArcs.ts, shaders/
│           ├── ChatInput.svelte    # Compose + voice input
│           ├── ChatBubble.svelte   # Message rendering (markdown)
│           ├── ConversationSidebar.svelte
│           ├── Settings.svelte     # Provider configuration
│           ├── DeviceStats.svelte
│           └── db.ts               # IndexedDB conversations
├── docs/adr/                # Architecture Decision Records
├── BLUEPRINT.md             # Full design spec (vision + planned work)
├── WORKFLOW.md              # Agent workflow (Sofia/Shiela/Maisarah)
├── REVIEW.md                # Review log
├── LICENSE
└── README.md
```

## 🛠️ Tech Stack

- **Frontend:** SvelteKit + Vite (browser tab today; Electron window planned)
- **3D:** Three.js + GLSL shaders
- **Post-processing:** UnrealBloomPass
- **API layer:** SvelteKit server routes — no separate bridge process
- **LLM:** Any OpenAI-compatible provider (LM Studio at `127.0.0.1:1234` by default)
- **TTS:** Piper (local voice model)
- **STT:** Web Speech API (Chrome/Edge)
- **Storage:** IndexedDB (conversations) + a local provider-settings file

## 📅 Development Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Static Neural Globe | ✅ Shipped | Three.js scene, 680 nodes, connections, idle animation |
| 2. Text Chat | ✅ Shipped | SvelteKit `/api/chat`, streaming SSE, multi-provider settings, conversation sidebar |
| 3. Voice Input | ✅ Shipped | Web Speech API microphone input (Chrome/Edge only) |
| 4. Voice Output | ✅ Shipped | Piper TTS playback (audio-reactive animation not built) |
| 5. Polish | 🔲 TODO | Emotion mapping, particles, error states |
| 6. Electron | 🔲 TODO | Transparent window, desktop pet |
| 7. Advanced | 🔲 TODO | Wake word, multi-language, AI City integration |

**Known gaps:** the shipped chat has no multi-turn history and does not send the configured system prompt to the provider. Both are in progress under the current P0 work (`p0-chat-core` / `p0-api-security`) and are **not merged yet** — treat Phases 2–4 as shipped-with-known-gaps, not finished.

## Agent Workflow

- **Sofia** — Plans architecture, evaluates reviews
- **Shiela** — Implements code
- **Maisarah** — Reviews, finds bugs/gaps

See [WORKFLOW.md](WORKFLOW.md) for details; review findings live in [REVIEW.md](REVIEW.md).

## 📡 API Overview

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat` | Streaming chat completion against the configured provider (SSE) |
| POST | `/api/tts` | Synthesize speech with Piper, returns audio |
| GET / POST | `/api/settings` | Read / write provider settings |
| GET | `/api/stats` | Cross-platform device statistics |
| POST | `/api/health` | Health check for configured providers |

Full details: `frontend/src/routes/api/*/+server.ts`.

## 📄 Documentation

- [BLUEPRINT.md](BLUEPRINT.md) — Full design spec (vision, planned components)
- [WORKFLOW.md](WORKFLOW.md) — Agent workflow
- [REVIEW.md](REVIEW.md) — Review log
- [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs) — Hermes documentation

## Related ADRs

- [ADR 0001 — Use SvelteKit Routes as the Bridge](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md) — why there is no `:8742` bridge or Electron shell yet

## License

MIT — see [LICENSE](LICENSE).
