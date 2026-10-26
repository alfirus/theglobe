# The Globe

A living neural electric globe — a visual AI interface with voice interaction.

Not a solid orb. A network of glowing neuron nodes, electric connections, and traveling sparks shaped into a sphere. The globe IS the agent.

## What Is This?

The Globe Interface is a locally-hosted, visually reactive **neural electric globe** that acts as a physical embodiment of an AI agent.

Today it runs as a **SvelteKit app in your browser**, and ships an **Electron shell** (`frontend/electron/main.js`) that packages it as a desktop app. The shell opens an opaque 1280×860 window today — the floating transparent window is planned, not built; see [ADR-0001](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md) and the phase table below.

The LLM calls come from the app's own server routes to an OpenAI-compatible provider (LM Studio at `127.0.0.1:1234` by default). The deeper [Hermes Agent](https://hermes-agent.nousresearch.com/) integration — skills, memory, sessions, tools — is the target architecture: the chat route sends the conversation's history and the configured system prompt (when set) with each request, but sessions, memory, and tool use do not reach the model yet.

## ✨ Features

Shipped:

- **Neural Electric Visual** — 680 nodes (18 clusters × 35 + 50 core), dynamic connections, traveling sparks, UnrealBloom glow
- **Streaming text chat** — multi-provider (SSE), conversation sidebar with IndexedDB persistence, markdown rendering
- **Voice input** — Web Speech API in Chromium, local Whisper fallback everywhere else
- **Voice output** — Piper TTS (local model), audio playback in the page
- **Audio-reactive animation** — a WebAudio `AnalyserNode` splits the playing voice into bass/mid/high bands and drives node size + warmth, connection brightness, ambient opacity, bloom, and globe scale; the bands decay to exactly 0 when audio stops, so the idle animation is untouched
- **Settings + device stats** — provider configuration UI, cross-platform system stats

Planned (not built): transparent Electron window, mood/color-shifting states beyond the current thinking/speaking treatments, Hermes skills/memory/tools.

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
│    GET/POST /api/stt    Whisper STT   │
│    GET/POST /api/settings provider cfg│
│    GET    /api/stats    device stats  │
│    POST   /api/health   provider check│
└──────────────┬────────────────────────┘
               │  HTTP (OpenAI-compatible) / local process
┌──────────────┴────────────────────────┐
│  LLM: LM Studio :1234 (or any         │
│       OpenAI-compatible provider)     │
│  TTS: local Piper voice model         │
│  STT: local Whisper (faster-whisper)  │
└───────────────────────────────────────┘

Planned, deferred (see ADR-0001):
  • WebSocket bridge :8742  • Electron transparent window
```

There is no bridge process in this repo — the SvelteKit `/api/*` routes *are* the bridge. The Electron shell (`frontend/electron/main.js`: spawns the adapter-node server on a free loopback port, splash + single-instance lock, electron-builder packaging) ships the app as a desktop app, but its window is opaque — transparency, click-through, tray, and desktop-pet behaviours are still planned.

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

Voice input uses the browser's Web Speech API where it exists (Chrome/Edge). Everywhere else the mic records a clip and the server transcribes it locally — that needs a Python speech engine:

```bash
python -m pip install faster-whisper   # preferred (CTranslate2)
python -m pip install openai-whisper   # fallback (torch)
```

Optional overrides: `STT_PYTHON` (interpreter), `STT_WORKER` (worker path), `STT_MODEL` (default `base`), `STT_LANGUAGE` (default auto-detect), `STT_TIMEOUT_MS` (default 60000).

## 🎨 Visual Design

The globe is **not a solid sphere**. It looks like electric neurons in a glob form:

- **Nodes** — Sharp bright points (Fibonacci sphere distribution)
- **Connections** — Dynamic lines between nearby nodes (form/dissolve)
- **Sparks** — Bright pulses traveling along connections
- **Core** — Central glow with heartbeat rhythm
- **Ambient** — Floating particles for depth

### Color States

The full palette below is the design target. **Implemented today:** two treatments — amber nodes while speaking and a bloom pulse while thinking — plus an audio-reactive layer on the speaking treatment: the playing voice's bass/mid/high bands drive node warmth, connection brightness, bloom, and globe scale. Still planned: the listening, error, and mood-drift treatments.

| State | Color | Status |
|-------|-------|--------|
| Idle | Soft electric blue | ✅ Built |
| Listening | Blue brightens + white sparks | 🔲 Planned |
| Thinking | Deep blue → purple | ✅ Built (bloom pulse) |
| Speaking | Warm amber/gold | ✅ Built (amber nodes + audio-reactive glow) |
| Error | Red flash | 🔲 Planned |

## 📁 Project Structure

```
theglobe/
├── frontend/                # SvelteKit + Three.js app
│   ├── electron/
│   │   └── main.js              # Electron shell: server child + window
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
│           ├── glob/               # NeuralGlobe.svelte, audioReactive.ts,
│           │                       # nodes.ts, connections.ts, sparks.ts,
│           │                       # core.ts, ambient.ts, neuralActivity.ts,
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

- **Frontend:** SvelteKit + Vite (browser tab by default; opaque Electron shell ships, transparent window planned)
- **3D:** Three.js + GLSL shaders
- **Post-processing:** UnrealBloomPass
- **API layer:** SvelteKit server routes — no separate bridge process
- **LLM:** Any OpenAI-compatible provider (LM Studio at `127.0.0.1:1234` by default)
- **TTS:** Piper (local voice model)
- **STT:** Web Speech API (Chrome/Edge) + local Whisper via `POST /api/stt` (Firefox/Safari)
- **Storage:** IndexedDB (conversations) + a local provider-settings file

## 📅 Development Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Static Neural Globe | ✅ Shipped | Three.js scene, 680 nodes, connections, idle animation |
| 2. Text Chat | ✅ Shipped | SvelteKit `/api/chat`, streaming SSE, multi-provider settings, conversation sidebar, multi-turn history + system prompt |
| 3. Voice Input | ✅ Shipped | Web Speech API (Chrome/Edge) + local Whisper fallback for other browsers |
| 4. Voice Output | ✅ Shipped | Piper TTS playback + audio-reactive animation (bass/mid/high bands drive node glow, connections, bloom, globe scale) |
| 5. Polish | 🔲 TODO | Emotion mapping, particles, error states |
| 6. Electron | 🔲 TODO | Transparent window, desktop pet |
| 7. Advanced | 🔲 TODO | Wake word, multi-language, AI City integration |

**Known gaps:** multi-turn history and the configured system prompt are **merged** — the chat route sends the system prompt as the first message, follows it with the conversation's most recent 40 history entries, then the new user message, and the UI builds that history from the conversation you have open. Still not built: the deeper Hermes integration — sessions, memory, and tool use do not reach the model yet.

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
| GET / POST | `/api/stt` | Speech engine capability probe / transcribe a recorded clip (local Whisper) |
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
