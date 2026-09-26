# The Glob — Frontend (SvelteKit + Three.js)

SvelteKit app that renders the neural globe (Three.js + GLSL) and the chat
UI. The server routes under `src/routes/api/*` are the app's entire backend
— there is no separate bridge process (see
[`../docs/adr/0001-use-sveltekit-routes-as-the-bridge.md`](../docs/adr/0001-use-sveltekit-routes-as-the-bridge.md)).

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build
npm run preview    # preview the build
npm run check      # svelte-check / TypeScript
```

## Layout

```
src/
├── routes/
│   ├── +page.svelte          # Main page: chat UI, globe, playback
│   ├── +layout.svelte        # App shell
│   └── api/                  # Server routes (the "bridge")
│       ├── chat/             # POST  — streaming chat, multi-provider
│       ├── tts/              # POST  — Piper text-to-speech
│       ├── settings/         # GET/POST — provider settings (file-backed)
│       ├── stats/            # GET   — cross-platform device stats
│       └── health/           # POST  — provider health checks
└── lib/
    ├── glob/                 # Three.js scene: nodes, connections, sparks,
    │                         #   core glow, ambient particles, shaders
    ├── ChatInput.svelte      # Compose + voice input (Web Speech API, Chrome)
    ├── ChatBubble.svelte     # Message rendering (markdown)
    ├── ConversationSidebar.svelte
    ├── Settings.svelte       # LLM provider configuration
    ├── DeviceStats.svelte
    └── db.ts                 # IndexedDB conversation persistence
```

## Notes

- Dependencies: `three`, `@types/three`, `marked`. No UI framework.
- Provider API keys are stored in a local settings file written by
  `src/routes/api/settings/+server.ts`. Keep it out of version control.
- Voice input is Chrome-only (Web Speech API). TTS requires a local Piper
  model; the path is configured in the TTS route.

## Related ADRs

- [ADR 0001 — Use SvelteKit Routes as the Bridge](../docs/adr/0001-use-sveltekit-routes-as-the-bridge.md)
