# Globe Interface — Blueprint

> **Project:** A living neural electric globe — a visual AI interface with voice interaction.
> **Status:** Architecture Design (v1.0)
> **Date:** August 2026

> **Read this first — what is spec vs. what is built.** This document is the
> *design target*. Sections marked **[PLANNED — NOT BUILT]** describe
> components that do not exist in this repo yet: the WebSocket bridge on
> port 8742, the Electron shell, the 8-state machine, and the Hermes agent
> integration (skills, memory, sessions — the
> chat route sends a stateless message list to an OpenAI-compatible provider).
> The audio-reactive pipeline is **not** one of them — it is built; see §7.
> What actually runs today is a SvelteKit app whose
> `frontend/src/routes/api/*` server routes talk straight to the LLM
> provider and to Piper TTS — the integration layer the bridge was going to
> provide. See **[ADR-0001 — Use SvelteKit Routes as the Bridge](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md)**
> for the decision, and `README.md` for the system as built.

---

## 1. Vision

Globe Interface is a locally-hosted, visually reactive **neural electric globe** that acts as a physical embodiment of an AI agent. Not a solid orb — a network of glowing neuron nodes, electric connections, and traveling sparks shaped into a sphere. The user speaks to it or types, and it responds with voice and text while animating to show it's alive.

**Hermes Agent is the brain** — not a raw LLM wrapper. The globe inherits all of Hermes' capabilities: skills, memory (Honcho), session management, tools, cron, and the full MCP ecosystem. LM Studio at `127.0.0.1:1234` is the LLM inference backend.

**The globe floats on your desktop** — a transparent Electron window with no chrome. It appears to live directly on your wallpaper, like a companion organism.

**Key differentiator:** This isn't "a chatbot with a cool UI." The globe IS the agent — it has personality, memory, and grows smarter through Hermes' skill system over time.

---

## 2. Architecture Overview

> **[PLANNED — NOT BUILT]** This is the target architecture from the original
> design. The bridge server (:8742), the WebSocket client, and the Electron
> window shown below do not exist. The system as built is: browser →
> SvelteKit `/api/*` server routes (`frontend/src/routes/api/`) → LLM provider
> / Piper. See [ADR-0001](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md).
> The audio analysis lane in VOICE PROCESSING below (`WebAudio AnalyserNode →
> animation data`) **is** built — see §7 — but TTS is local Piper, not the
> Hermes TTS API drawn here.

```
┌─────────────────────────────────────────────────────────────┐
│                    GLOBE INTERFACE                           │
│              (Transparent Electron Window)                   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              BROWSER FRONTEND (port 3000)             │  │
│  │                                                       │  │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────────────┐   │  │
│  │  │  Three.js    │  │ WebAudio │  │  WebSocket     │   │  │
│  │  │  Neural Globe│  │ Analyzer │  │  Client        │   │  │
│  │  └────┬─────────┘  └────┬─────┘  └────────┬───────┘   │  │
│  │       │                 │                   │           │  │
│  │  ┌────┴─────────────────┴───────────────────┴───────┐  │  │
│  │  │           SvelteKit Frontend                     │  │  │
│  │  │    Text input · Chat history · Status display    │  │  │
│  │  └─────────────────────────┬───────────────────────┘  │  │
│  └────────────────────────────┼──────────────────────────┘  │
│                               │                             │
│  ┌────────────────────────────┼──────────────────────────┐  │
│  │           VOICE PROCESSING (Browser)                   │  │
│  │                                                        │  │
│  │  STT: Web Speech API (primary) or Whisper WASM         │  │
│  │  TTS: Hermes TTS API → audio stream → WebAudio playback │  │
│  │  Analysis: WebAudio AnalyserNode → animation data       │  │
│  └────────────────────────────┬───────────────────────────┘  │
│                               │                             │
└───────────────────────────────┼─────────────────────────────┘
                                │
                       HTTP / WebSocket
                                │
┌───────────────────────────────┼─────────────────────────────┐
│                BRIDGE SERVER (port 8742)                      │
│                Node.js / Python (FastAPI)                     │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  - WebSocket → HTTP adapter for streaming               │  │
│  │  - Audio relay (STT/TTS if using Hermes STT)            │  │
│  │  - Session state sync                                    │  │
│  │  - CORS proxy (browser → Hermes)                         │  │
│  │  - Health check aggregation                              │  │
│  └────────────────────────┬────────────────────────────────┘  │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │
                     HTTP POST /v1/chat/completions
                     (OpenAI-compatible, streaming SSE)
                            │
┌───────────────────────────┼────────────────────────────────────┐
│              HERMES API SERVER (port 8642)                     │
│              (inside Hermes Gateway process)                   │
│                                                                │
│  ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌────────────────┐  │
│  │  AIAgent  │  │  Tools  │  │ Skills  │  │  Memory/       │  │
│  │  Runtime  │  │  (MCP)  │  │ System  │  │  Sessions      │  │
│  └──────┬───┘  └─────────┘  └─────────┘  └────────────────┘  │
│         │                                                      │
│  ┌──────┴──────────────────────────────────────────────────┐   │
│  │              LLM Provider: LM Studio                     │   │
│  │              http://127.0.0.1:1234/v1                     │   │
│  │              (OpenAI-compatible)                          │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. The Neural Electric Globe (NOT Solid)

### Visual Concept

The globe is **not a solid sphere**. It looks like **electric neurons in a glob form** — a plasma globe meets a brain scan visualization:

- Glowing neuron nodes floating in spherical formation
- Electric tendrils (axons/dendrites) connecting them
- Pulses of light racing along pathways (action potentials)
- You can **see through it** — no solid surface, just living electricity
- Bright core, sparser edges — the network fades into transparency

### Visual Elements

| Element | Description | Animation |
|---------|-------------|-----------|
| **Nodes** | Bright point particles (~200-500) in Fibonacci sphere distribution | Gentle float/breathe, brightness pulses per-node |
| **Connections** | Dynamic glowing lines between nearby nodes | Form/dissolve every few seconds, topology evolves |
| **Sparks** | Bright pulses traveling along connections (action potentials) | Race from node to node, create chain reactions |
| **Core** | Central glow, brighter than edges | Pulses with "heartbeat" rhythm |
| **Ambient particles** | Tiny floating specs of light | Drift slowly, add depth |
| **Field glow** | Soft halo around the structure | Breathes with animation cycle |

### Key Visual Properties

- **Transparent** — you can see through the gaps between neurons. No solid surface.
- **Organic** — connections form and dissolve. The topology is always changing.
- **Electric** — sparks fire along pathways. The network is always active.
- **Spherical** — all nodes distributed in a sphere shape, but the sphere itself is implied, not drawn.

---

## 4. Color System (Color-Shifting Based on Mood/Context)

> **[PARTIALLY BUILT]** Implemented today: amber nodes while speaking and a
> bloom pulse while thinking (`NeuralGlobe.svelte`). There is no LISTENING or
> ERROR visual, and no mood drift.

The globe changes color based on its current state and the emotion of the conversation. The color shifts are smooth (500ms lerp between states).

| State | Color | Feeling |
|-------|-------|---------|
| **Idle** | Soft electric blue | Calm neural activity |
| **Listening** | Blue brightens + white sparks | Alert, paying attention |
| **Thinking** | Deep blue → purple swirl | Processing, deep thought |
| **Speaking (happy)** | Warm amber/gold | Friendly, alive |
| **Speaking (neutral)** | Cool blue-white | Calm, informative |
| **Speaking (excited)** | Bright white + cyan sparks | Energy! |
| **Error** | Red flash → fade back to blue | Misfire, recovering |
| **Mood drift** | Slow color temperature shift | The globe has personality |

The entire neural network shifts together — connections, sparks, and core all inherit the palette. Like a brain state change.

---

## 5. State Machine

> **[PLANNED — NOT BUILT]** The code has two booleans (`isSpeaking`,
> `isThinking`) in `NeuralGlobe.svelte` and two visual treatments — not this
> 8-state machine, and no LISTENING or ERROR state (so the "Error red flash"
> row below cannot trigger as written). Kept as the design target.

```
┌─────────────────────────────────────────────────┐
│                 GLOBE STATE MACHINE              │
│                                                  │
│   ┌──────────┐   voice     ┌──────────────┐     │
│   │   IDLE   │ ────────→  │  LISTENING   │     │
│   │ breathing│            │   pulsing     │     │
│   └────┬─────┘            └──────┬───────┘     │
│        │                         │              │
│        │                    speech detected     │
│        │                         │              │
│        │                    ┌────▼──────┐       │
│        │                    │ THINKING  │       │
│        │                    │  spinning  │       │
│        │                    └────┬──────┘       │
│        │                         │              │
│        │                    text streaming       │
│        │                         │              │
│        │                    ┌────▼──────┐       │
│        │                    │ SPEAKING  │       │
│        │                    │  glowing   │       │
│        │                    └────┬──────┘       │
│        │                         │              │
│        │                    audio ends          │
│        │                         │              │
│        └─────────────────────────┘              │
│                                                  │
│   ERROR state: shaking, red pulse (timeout, etc) │
└─────────────────────────────────────────────────┘
```

### State Visual Details

| State | Visual | Technical |
|-------|--------|-----------|
| **Idle** | Slow breathing pulse, soft glow | Sinusoidal scale oscillation (0.98-1.02), subtle color shift |
| **Listening** | Faster pulse, concentric rings | Amplitude-driven scale, ring geometry spawn from center |
| **Thinking** | Inner swirl, particle system | Rotating inner mesh, particle emitter at poles, color → cool blue |
| **Speaking** | Glow intensity tied to audio | WebAudio amplitude → emission intensity, color → warm amber |
| **Error** | Shake + red flash | Position jitter (noise), color → red, decay back to idle |

---

## 6. "Alive" Behaviors

What makes the globe feel like a living organism, not a UI element:

1. **Connections evolve** — every few seconds, some connections break and new ones form. The network topology changes. Feels alive.
2. **Spark cascades** — when one node fires, nearby nodes have a chance to fire too (like real neural propagation). Creates chain reactions.
3. **Cluster activity** — different regions of the sphere activate at different times. Not uniform — like actual brain regions.
4. **Memory traces** — frequently-used pathways glow brighter over time (like neural plasticity). If you ask about the same topic repeatedly, those connections strengthen.
5. **Core heartbeat** — a subtle central pulse that's always running, like a brainstem keeping things alive.
6. **Mouse awareness** — the globe tilts slightly toward your cursor position. It knows you're there.

---

## 7. Voice Pipeline

### Input (STT)

| Approach | Pros | Cons |
|----------|------|------|
| **Browser Web Speech API** | Zero setup, instant, free | Chrome/Edge only, English-focused, less accurate |
| **Hermes STT (faster-whisper)** | Best accuracy, multi-language, local | Requires audio relay through bridge, slightly more latency |

**Recommended:** Start with Web Speech API for simplicity, offer Hermes faster-whisper as an option for higher accuracy.

### Output (TTS)

| Approach | Pros | Cons |
|----------|------|------|
| **Hermes TTS (Edge TTS)** | High quality, many voices, free | Requires bridge relay for audio |
| **Browser Web Speech API** | Zero setup, instant | Robotic quality, limited voices |
| **Frontend ElevenLabs** | Premium quality | Requires API key, paid |

**Shipped:** **Piper TTS** runs locally inside the SvelteKit TTS route
(`frontend/src/routes/api/tts/+server.ts`) — no bridge, no Edge TTS. The table
above is an options comparison from the original design, not a description of
what is installed.

### Audio-Reactive Animation Pipeline

> **✅ SHIPPED (P1-3, PR #10).** Playback builds exactly this graph:
> `frontend/src/lib/glob/audioReactive.ts` creates the `AudioContext` →
> `createMediaElementSource()` → `AnalyserNode` (`fftSize: 256`) chain while
> Piper TTS plays. `+page.svelte:996` hands the live `HTMLAudioElement` to
> `NeuralGlobe` through the `audioElement` prop, `NeuralGlobe.svelte:196`
> calls `start(el)` / `stop()`, and `NeuralGlobe.svelte:482-497` writes the
> smoothed bands into the shader uniforms every frame (node size + warmth,
> connection brightness, ambient opacity, bloom, globe scale). Every consumer
> is neutral at 0 and `stop()` zeroes the targets only, so the bands decay to
> an exact 0 and the idle animation is untouched. Three deviations from the
> diagram below, as built: bands are **bass 0–250 Hz / mid 250 Hz – 2 kHz**
> (widened so voice fundamentals land in bass), **warmth is driven by the mid
> band**, and "particles = high" is implemented as ambient-particle **opacity**
> rather than a per-frame count rebuild.

```
TTS audio (Piper /api/tts → HTMLAudioElement)
        │
        ▼
┌───────────────────┐
│  WebAudio API     │
│  AudioContext     │
│  createMediaElementSource()
│  AnalyserNode     │
│  fftSize: 256     │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  getByteFrequencyData()
│  → amplitude array │
│  → compute:        │
│    - bass (0-100Hz) │
│    - mid (100-2kHz) │
│    - high (2k-8kHz) │
│    - overall level   │
└────────┬───────────┘
         │
         ▼
┌───────────────────┐
│  Animation Driver  │
│  - scale = 1.0 +   │
│    amplitude * 0.15 │
│  - glow = mid * 2  │
│  - color shift =   │
│    bass → warmth    │
│  - particles =     │
│    high → count     │
└───────────────────┘
```

**Lip sync / viseme generation:**
- The globe doesn't need a "mouth" — the glow, distortion, and sparks ARE its expression
- Map audio amplitude to surface distortion intensity
- Use WebAudio AnalyserNode frequency bands to drive specific shader uniforms

---

## 8. Hermes Agent Integration

### The Golden Path: Hermes API Server

Hermes has a built-in **OpenAI-compatible API Server** (`API_SERVER_ENABLED=true`) that exposes `/v1/chat/completions` with streaming SSE. This is the integration point — no custom bridge logic needed beyond CORS proxy and audio relay.

| Aspect | Detail |
|--------|--------|
| **Endpoint** | `POST /v1/chat/completions` (standard OpenAI format) |
| **Streaming** | Yes — Server-Sent Events (SSE) |
| **Tool access** | Full — terminal, file, web, browser, MCP, skills, memory |
| **Session management** | Built-in — sessions persist across requests |
| **Warm starts** | Agent stays loaded between requests (~3-5s response) |
| **Auth** | Bearer token via `API_SERVER_KEY` |

### What Hermes Gives Us (That Raw LM Studio Can't)

- Remembers conversation context across sessions (memory)
- Can look up past conversations (session search)
- Has access to 50+ tools (files, web, terminal, browser)
- Loads skills dynamically based on task
- Can schedule cron jobs
- Manages sessions with proper context compression
- Supports model/provider switching without restart

### Configuration

```yaml
# Hermes config.yaml (for the globe profile)
model:
  default: qwen3-8b          # or whatever model is loaded in LM Studio
  provider: lmstudio
  base_url: http://127.0.0.1:1234/v1
  api_key: lm-studio

api_server:
  enabled: true
  port: 8642
  key: glob-interface-key

tts:
  provider: edge              # Free, no API key needed

stt:
  enabled: true
  provider: local             # faster-whisper, runs locally
```

---

## 9. Bridge Server

> **[PLANNED — NOT BUILT]** There is no `bridge/` directory and no reference
> to WebSocket / :8742 / `ws://` anywhere in `frontend/src`. SvelteKit
> `/api/*` server routes fulfil the HTTP parts of this role today (chat, TTS,
> settings, health); the WebSocket protocol below is deferred until streaming
> audio chunks need it. Decision: [ADR-0001 — Use SvelteKit Routes as the
> Bridge](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md).

### Why a Bridge?

The browser can't directly call Hermes API Server due to:
1. CORS restrictions (Hermes API doesn't set CORS headers for browser origins)
2. WebSocket needed for streaming audio/real-time state (Hermes only does HTTP SSE)
3. Audio relay for STT/TTS if using Hermes-side processing
4. Session state coordination between frontend and Hermes

### Bridge Endpoints

```
Bridge Server (port 8742)
├── GET  /health                    → Aggregated health (Hermes + LM Studio)
├── WS   /ws/glob                   → Main WebSocket channel
│   ├── Client → Server: { type: "text", content: "..." }
│   ├── Client → Server: { type: "audio", data: <base64 audio chunk> }
│   ├── Server → Client: { type: "text_delta", content: "..." }
│   ├── Server → Client: { type: "audio_chunk", data: <base64> }
│   ├── Server → Client: { type: "state", state: "thinking"|"speaking"|... }
│   ├── Server → Client: { type: "emotion", sentiment: "happy"|"neutral"|... }
│   └── Server → Client: { type: "error", message: "..." }
├── POST /api/send                  → One-shot message (fallback)
├── GET  /api/sessions              → List Hermes sessions
├── POST /api/session/reset         → Reset current session
└── POST /api/tts                   → Generate TTS audio
```

---

## 10. Desktop: Transparent Window

> **[PLANNED — NOT BUILT]** No `frontend/electron/` directory exists; the app
> runs in a browser tab today. The renderer is also created with
> `alpha: false` and an opaque black scene background, which a transparent
> window would need to change.

### Electron Configuration

```javascript
new BrowserWindow({
  width: 400,
  height: 400,
  transparent: true,      // glass effect
  frame: false,           // no title bar
  alwaysOnTop: true,      // floats above everything
  hasShadow: false,
  backgroundColor: '#00000000',  // fully transparent bg
  webPreferences: {
    nodeIntegration: true
  }
})
```

### Cross-Platform Support

| Feature | Windows | macOS | Ubuntu/Linux |
|---------|---------|-------|-------------|
| Transparent window | ✅ Excellent | ✅ Excellent | ✅ Good (needs compositor) |
| Frameless + always-on-top | ✅ | ✅ | ✅ |
| Dragging the globe | ✅ | ✅ | ✅ |
| Click-through mode | ✅ | ✅ | Varies |
| Performance | ✅ Great | ✅ Great | ✅ Good |

### Desktop Pet Features

- **Draggable** — click and drag the globe to reposition
- **Right-click menu** — settings, voice on/off, minimize, quit
- **Resize** — scroll wheel or pinch to scale
- **Minimize to tray** — hide the globe, bring back with hotkey
- **Multi-monitor** — drag to whichever screen you want
- **Click-through mode** — toggle so mouse clicks pass through

---

## 11. Complete Interaction Cycle

> **[PLANNED — NOT BUILT]** This cycle assumes the bridge WebSocket from §9
> and Edge TTS. What ships today: `fetch('/api/chat')` with SSE streaming and
> `fetch('/api/tts')` (Piper), with no WS state/emotion messages.

```
1. IDLE STATE
   └── Globe breathes gently, soft ambient glow

2. USER CLICKS MICROPHONE (or wake word detected)
   └── Frontend: navigator.mediaDevices.getUserMedia()
   └── Bridge WS: { type: "state", state: "listening" }
   └── Globe: Transitions to LISTENING (pulsing faster)

3. USER SPEAKS
   └── Browser Web Speech API captures audio
   └── Real-time transcription appears as "thinking bubbles"
   └── Globe: Pulse speed increases with voice amplitude

4. USER STOPS SPEAKING (silence detected)
   └── Final transcript assembled
   └── Bridge WS: { type: "text", content: "What's the weather?" }
   └── Bridge WS: { type: "state", state: "thinking" }
   └── Globe: Transitions to THINKING (inner swirl, cool blue)

5. BRIDGE CALLS HERMES API
   └── POST http://localhost:8642/v1/chat/completions
   └── Hermes Agent processes:
       - Loads session context (memory, previous turns)
       - Executes tools if needed (web search, file ops, etc.)
       - Generates response with streaming

6. TEXT STREAMS TO FRONTEND
   └── Bridge WS: { type: "text_delta", content: "The weather in " }
   └── Bridge WS: { type: "text_delta", content: "KL is 32°C " }
   └── Frontend: Text appears letter by letter
   └── Globe: Subtle color shift based on content sentiment

7. TEXT COMPLETE → TTS GENERATION
   └── Bridge: Generate TTS via Edge TTS
   └── Bridge WS: { type: "state", state: "speaking" }
   └── Globe: Transitions to SPEAKING (bright glow, particles)

8. AUDIO STREAMS TO FRONTEND
   └── Bridge WS: { type: "audio_chunk", data: <base64 mp3 chunk> }
   └── Frontend: Creates Audio element, connects to WebAudio
   └── WebAudio AnalyserNode → real-time amplitude data
   └── Globe: Glow intensity and distortion driven by audio

9. AUDIO FINISHES
   └── Bridge WS: { type: "state", state: "idle" }
   └── Globe: Returns to IDLE (breathing)
   └── Microphone ready for next input
```

---

## 12. Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Window** | Electron | **[PLANNED — NOT BUILT]** the app runs in a browser tab today |
| **Frontend Framework** | SvelteKit + Vite | Fast dev, small bundle, great reactivity |
| **3D Engine** | Three.js + custom GLSL shaders | Mature, well-documented, GPU-accelerated |
| **Post-processing** | UnrealBloomPass | Electric glow effect |
| **Audio Analysis** | Web Audio API | Built into browser, no deps |
| **STT (primary)** | Web Speech API | Zero setup, instant |
| **STT (alt)** | Hermes faster-whisper | Better accuracy, multi-language |
| **TTS** | Piper (shipped) | Local voice model, no API key — replaces the planned Hermes Edge TTS |
| **Bridge Server** | Node.js + ws | **[PLANNED — NOT BUILT]** deferred; SvelteKit `/api/*` routes stand in — see [ADR-0001](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md) |
| **AI Brain** | Hermes Agent API Server | **[NOT WIRED YET]** the chat route posts to an OpenAI-compatible `/chat/completions`; no session, history, or tools in the loop |
| **LLM Backend** | LM Studio (127.0.0.1:1234) | Local, private, fast |
| **GPU** | RTX 5060 Ti 16GB | Local inference via LM Studio |

---

## 13. Project Structure

> **[PLANNED — NOT BUILT]** This is the target tree from the original design.
> Most entries below do not exist yet: no `NodeCloud.svelte` / other
> per-element `.svelte` files (the globe is `.ts` modules under `lib/glob/`),
> no `lib/voice/`, no `lib/ws/`, no `stores/`, no `bridge/`, no root
> `shaders/`, no `config/`, no `scripts/`, no `ARCHITECTURE.md`, no
> `frontend/electron/`. The tree that actually exists is in
> [README.md](README.md) under *Project Structure*. Deferred parts are
> governed by [ADR-0001](docs/adr/0001-use-sveltekit-routes-as-the-bridge.md).
> The audio analysis entries below (`AudioAnalyzer.svelte`, `audio.ts`) exist
> as `lib/glob/audioReactive.ts` instead — see §7.

```
theglobe/
├── frontend/                    # Browser app (Electron)
│   ├── src/
│   │   ├── lib/
│   │   │   ├── glob/
│   │   │   │   ├── NeuralGlobe.svelte      # Main Three.js scene
│   │   │   │   ├── NodeCloud.svelte         # Neuron nodes (Points)
│   │   │   │   ├── NeuralConnections.svelte # Dynamic line graph
│   │   │   │   ├── SparkSystem.svelte       # Action potential particles
│   │   │   │   ├── CoreGlow.svelte          # Central glow
│   │   │   │   ├── AmbientParticles.svelte  # Floating specs
│   │   │   │   ├── AnimationDriver.svelte   # State machine + animation
│   │   │   │   ├── NeuralGraph.ts           # Graph logic (connections, firing)
│   │   │   │   └── shaders/
│   │   │   │       ├── node.vert/frag       # Neuron point shader
│   │   │   │       ├── line.vert/frag       # Connection line shader
│   │   │   │       ├── spark.vert/frag      # Traveling spark shader
│   │   │   │       └── noise.glsl           # Perlin/Worley noise
│   │   │   ├── voice/
│   │   │   │   ├── STTEngine.svelte         # Web Speech API wrapper
│   │   │   │   ├── TTSAudio.svelte          # Audio playback + analysis
│   │   │   │   └── AudioAnalyzer.svelte     # WebAudio AnalyserNode
│   │   │   ├── ws/
│   │   │   │   └── WebSocketClient.svelte   # Bridge connection
│   │   │   └── stores/
│   │   │       ├── state.ts                 # Globe state machine
│   │   │       ├── chat.ts                  # Chat history
│   │   │       └── audio.ts                 # Audio analysis data
│   │   ├── routes/
│   │   │   ├── +page.svelte                 # Main page
│   │   │   └── +layout.svelte               # App shell
│   │   └── app.html
│   ├── electron/
│   │   ├── main.ts                           # Electron main process
│   │   └── preload.ts                        # Preload script
│   ├── static/
│   ├── package.json
│   └── vite.config.ts
│
├── bridge/                      # Bridge server
│   ├── src/
│   │   ├── server.ts            # Express/Fastify server
│   │   ├── websocket.ts         # WebSocket handler
│   │   ├── hermes.ts            # Hermes API client
│   │   ├── tts.ts               # TTS generation
│   │   ├── stt.ts               # STT relay
│   │   └── health.ts            # Health aggregation
│   ├── package.json
│   └── tsconfig.json
│
├── shaders/                     # Shared GLSL shaders
│   ├── noise.glsl               # Perlin/Worley noise functions
│   ├── glow.glsl                # Glow/bloom effects
│   └── distortion.glsl          # Surface distortion
│
├── config/
│   ├── hermes-config.yaml       # Hermes profile config
│   └── .env.example             # Required env vars
│
├── scripts/
│   ├── setup.sh                 # One-command setup
│   └── dev.sh                   # Dev mode (hot reload both)
│
├── ARCHITECTURE.md              # Detailed architecture doc
├── BLUEPRINT.md                 # This file — project truth
└── README.md
```

---

## 14. Shader Approach

### Node Shader (Point Sprite)
- Soft radial falloff from center
- Brightness animated per-node (pulsing, reacting to state)
- Color uniform driven by current state palette
- Additive blending for glow叠加

### Line Shader (Connections)
- Thin glow lines between node positions
- Opacity based on "age" of connection (new = bright, old = fading)
- Color inherited from current state palette
- Width: 1-2px, bloom makes them appear thicker

### Spark Shader (Action Potentials)
- Bright point that travels along a line (lerp between node A and B)
- Trail effect: previous positions rendered with decreasing opacity
- Color: bright white core + state color halo
- Spawned at random intervals on random connections

### Post-Processing
- **UnrealBloomPass** — the key to the electric glow feel
  - strength: 1.5 (intense glow)
  - radius: 0.8 (wide bloom)
  - threshold: 0.2 (everything glows)

---

## 15. Performance Targets

| Component | Target | Notes |
|-----------|--------|-------|
| **3D Render** | 60fps | Use instanced rendering, limit draw calls |
| **Node count** | 200-500 | Target; the shipped build uses **680** (`nodes.ts`: 18 clusters × 35 + 50 core) |
| **Active connections** | 100-200 | Dynamic, constantly evolving |
| **Concurrent sparks** | 5-20 | Not too many, each is bright |
| **Bloom passes** | 1 | Quality bloom, single pass |
| **WebSocket latency** | <50ms | Bridge runs locally, no network hop |
| **STT latency** | <1s | Web Speech API is real-time |
| **TTS latency** | <2s first chunk | Edge TTS is fast; stream chunks as generated |
| **Hermes response** | 3-5s | API Server keeps agent warm |
| **GPU usage** | <30% | RTX 5060 Ti handles Three.js easily |
| **RAM** | <500MB | Browser + Three.js + audio buffers |

---

## 16. Development Phases

### Phase 1: Static Neural Globe (Week 1)
- Three.js scene with basic animated sphere
- Node cloud in Fibonacci sphere distribution
- Dynamic connections (form/dissolve)
- Idle breathing animation
- No backend, no voice — just a beautiful orb

### Phase 2: Text Chat (Week 2) — ✅ shipped via SvelteKit `/api/chat` (no bridge)
- ~~Bridge server with Hermes API connection~~ → served by `frontend/src/routes/api/chat/+server.ts` (streaming SSE, multi-provider)
- Text input field + chat history display
- Streaming text display
- Basic state transitions (idle → thinking → speaking → idle)

### Phase 3: Voice Input (Week 3) — ✅ shipped (Web Speech API, Chrome/Edge only)
- Web Speech API integration
- Microphone button + real-time transcription
- ~~Listening state animation~~ (not built — no LISTENING visual yet)
- Text + voice dual input

### Phase 4: Voice Output (Week 4) — ✅ shipped with Piper TTS **and** audio-reactive animation
- ~~Hermes TTS integration via bridge~~ → Piper via `frontend/src/routes/api/tts/+server.ts`
- Audio playback — an `HTMLAudioElement` routed through a WebAudio graph (`lib/glob/audioReactive.ts`: `AudioContext` → `AnalyserNode`, fftSize 256)
- Audio-reactive animation driving — bass/mid/high bands → node size + warmth, connection brightness, ambient opacity, bloom, globe scale (`NeuralGlobe.svelte:482-497`); bands settle to exactly 0 when playback stops
- Speaking state animation (amber nodes)

### Phase 5: Polish (Week 5)
- Emotion mapping from response content
- Spark cascades and cluster activity
- Ambient idle animations (random "life" behaviors)
- Error states and recovery
- Session persistence
- Performance optimization

### Phase 6: Electron (Week 6)
- Wrap in transparent window
- Desktop pet features (drag, resize, tray)
- Click-through mode
- System tray integration
- Cross-platform testing

### Phase 7: Advanced (Future)
- Custom shader work (holographic, liquid, plasma effects)
- Multi-language voice support
- Wake word integration ("Hey Globe")
- Multiple glob personalities
- Integration with AI City constellation view

---

## 17. Key Technical Challenges & Solutions

| Challenge | Solution |
|-----------|----------|
| **Streaming text → real-time animation** | SSE deltas arrive every ~50ms. Map content to animation params (!=excited, ?=curious, code=focused) |
| **Audio-reactive animation without latency** | WebAudio AnalyserNode provides frequency data at 60fps, matching render loop |
| **Making the globe feel alive when idle** | Perlin noise distortion, slow color drift, random particle spawns, varied breathing rhythm |
| **Session persistence across refreshes** | Bridge maintains session ID mapping. On reconnect, resume Hermes session |
| **Error handling (Hermes down)** | Health check aggregation. Globe shows appropriate error state |
| **CORS for browser → Hermes** | Bridge acts as CORS proxy (same-origin to browser, server-to-server to Hermes) |
| **TTS audio streaming** | Edge TTS generates chunks. Bridge streams each via WebSocket. Frontend queues and plays |

---

## 18. Configuration Reference

### Environment Variables (.env)

```bash
# Hermes API Server
API_SERVER_ENABLED=true
API_SERVER_PORT=8642
API_SERVER_KEY=glob-interface-secret

# LM Studio (configured in config.yaml)
LMSTUDIO_URL=http://127.0.0.1:1234

# Optional: TTS provider override
TTS_PROVIDER=edge
# ELEVENLABS_API_KEY=...   # For premium TTS

# Optional: STT provider
STT_PROVIDER=local
# GROQ_API_KEY=...        # For cloud STT
```

### Hermes Setup Commands

```bash
# Enable API server for the globe profile
hermes --profile glob config set API_SERVER_ENABLED true
hermes --profile glob config set API_SERVER_PORT 8642
hermes --profile glob config set API_SERVER_KEY glob-interface-secret

# Configure LM Studio as provider
hermes --profile glob config set model.provider lmstudio
hermes --profile glob config set model.base_url http://127.0.0.1:1234/v1
hermes --profile glob config set model.api_key lm-studio

# Set TTS
hermes --profile glob config set tts.provider edge

# Restart gateway
hermes --profile glob gateway restart
```

---

## 19. Integration with AI City (aict.my)

The Globe Interface can connect to AI City's **Neural Constellation** view:

- Each agent in AI City is visualized as a neural electric globe
- The constellation view shows all agents in a city as glowing orbs
- Individual globs can be "extracted" to the desktop via Globe Interface
- The desktop glob connects directly to the agent's Hermes Agent API Server
- The constellation view becomes "mission control," while individual globs live on the desktop

See [aict.my/BLUEPRINT.md](https://github.com/alfirus/aict.my/blob/main/BLUEPRINT.md) Section 11 for the full AI City Neural Constellation spec.

---

*This document is the project's single source of truth. Update as implementation reveals new constraints or opportunities.*
