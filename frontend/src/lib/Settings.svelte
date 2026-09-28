<script lang="ts">
  import { loadEffectiveSettings } from '$lib/settingsSync';
  import { pushEvent } from '$lib/events';

  export type Provider = 
    | 'hermes'
    | 'lmstudio'
    | 'opencode'
    | 'openrouter'
    | 'deepseek'
    | 'openclaw'
    | 'mimo';

  export type TtsProvider = 'system' | 'piper' | 'edge' | 'openai' | 'elevenlabs';

  export type Agent = 'hermes-agent' | 'openclaw-agent';
  export type UplinkMode = 'provider' | 'agent';

  interface ProviderConfig {
    id: Provider;
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Per-uplink budget in ms — shown in seconds in the field. */
    timeoutMs: number;
  }

  interface TtsConfig {
    provider: TtsProvider;
    voice: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    modelPath: string;
  }

  const TTS_ENGINES: { id: TtsProvider; name: string; hint: string }[] = [
    { id: 'system', name: 'System voice', hint: 'OS-native · no setup' },
    { id: 'piper', name: 'Piper', hint: 'Local neural · needs model' },
    { id: 'edge', name: 'Edge TTS', hint: 'Free cloud · no key' },
    { id: 'openai', name: 'OpenAI TTS', hint: 'Cloud · API key' },
    { id: 'elevenlabs', name: 'ElevenLabs', hint: 'Premium · API key' }
  ];

  const DEFAULT_TIMEOUT_MS = 120_000;

  export interface UplinkSelection {
    mode: UplinkMode;
    provider: Provider;
    agent: Agent;
  }

  /**
   * Runes callback prop (replaces `createEventDispatcher` + `on:change`): the
   * host passes `onchange={...}` and receives the whole uplink selection.
   * The legacy bare-`Provider` shape is still accepted for older hosts.
   */
  function notifyUplink(): void {
    onchange?.({ mode: uplinkMode, provider: selectedProvider, agent: selectedAgent });
  }

  let {
    initialProvider = 'hermes',
    // Visor HUD renders its own Settings entry in the top bar, so the legacy
    // floating button can be hidden while the modal stays driven from outside.
    hideTrigger = false,
    open = $bindable(false),
    onchange
  }: {
    initialProvider?: Provider;
    hideTrigger?: boolean;
    open?: boolean;
    onchange?: (selection: Provider | UplinkSelection) => void;
  } = $props();
  let selectedProvider = $state<Provider>('hermes');

  // Adopt the host's provider (server hydration lands after mount on a fresh
  // profile) until the user picks one in this modal — afterwards the local
  // choice wins. A `$effect.pre` (not a `$state` initializer) keeps
  // `initialProvider` reactive, which also clears `state_referenced_locally`.
  $effect.pre(() => {
    const incoming = initialProvider ?? 'hermes';
    if (!edited.provider) selectedProvider = incoming;
  });

  // System prompt state
  let systemPrompt = $state('');

  // Provider health state. Must be $state: mutating a plain object in runes
  // mode never re-renders, so the badge/timestamp never moved (M11).
  let providerHealth = $state<Record<string, { status: 'unknown' | 'healthy' | 'unhealthy'; lastChecked?: number }>>({});

  interface AgentConfig {
    id: Agent;
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  }

  const AGENT_ENTRIES: { id: Agent; name: string; hint: string }[] = [
    { id: 'hermes-agent', name: 'Hermes Agent', hint: 'Remote agent · sessions + tools' },
    { id: 'openclaw-agent', name: 'OpenClaw', hint: 'Remote agent · gateway' }
  ];

  interface StoredSettings {
    provider?: Provider;
    systemPrompt?: string;
    configs?: Record<string, Partial<ProviderConfig>>;
    tts?: Partial<TtsConfig>;
    uplinkMode?: UplinkMode;
    agent?: Agent;
    agents?: Record<string, Partial<AgentConfig>>;
  }

  function readStoredSettings(): StoredSettings {
    try {
      return JSON.parse(localStorage.getItem('globe-settings') || '{}');
    } catch {
      return {};
    }
  }

  /** True when the server already holds an API key for the active provider. */
  let keySaved = $state(false);

  /** Every copy that stays in the browser is stripped of key material (§2). */
  function stripKeys(configs: StoredSettings['configs']): StoredSettings['configs'] {
    const out: NonNullable<StoredSettings['configs']> = {};
    for (const [id, cfg] of Object.entries(configs || {})) {
      if (!cfg) continue;
      const { apiKey: _keptOnServer, ...rest } = cfg;
      out[id] = rest;
    }
    return out;
  }

  /** Same key-strip for the agent namespace (separate type, same rule). */
  function stripAgentKeys(agents: StoredSettings['agents']): StoredSettings['agents'] {
    const out: NonNullable<StoredSettings['agents']> = {};
    for (const [id, cfg] of Object.entries(agents || {})) {
      if (!cfg) continue;
      const { apiKey: _keptOnServer, ...rest } = cfg;
      out[id] = rest;
    }
    return out;
  }

  /**
   * Fields the user actually edited during this session (QA defect D3).
   *
   * A provider-card click used to POST the *code-default* view of that provider
   * (`model: ""`, stock base URL); `sanitizeSettingsBody` reads `""` as an
   * explicit clear and `mergeSettings` overwrote the stored value — measured:
   * `configs.lmstudio.model` went `qwen3.8-27b@q3_k_xl` → `""` from the click
   * alone. Only what is listed here is ever sent or written, so an empty string
   * reaches the server solely when the user cleared that field themselves.
   *
   * Deliberately not `$state`: nothing renders it, it only feeds persistence.
   */
  type EditableField = 'baseUrl' | 'model' | 'apiKey' | 'timeoutMs';
  type TtsEditableField = 'provider' | 'voice' | 'model' | 'baseUrl' | 'apiKey' | 'modelPath';
  const edited = {
    provider: false,
    systemPrompt: false,
    configs: {} as Record<string, Set<EditableField>>,
    tts: new Set<TtsEditableField>(),
    uplinkMode: false,
    agent: false,
    agents: {} as Record<string, Set<EditableField>>
  };

  function markAgentEdited(id: Agent, field: EditableField): void {
    const fields = edited.agents[id];
    if (fields) fields.add(field);
    else edited.agents[id] = new Set([field]);
  }

  function editedAgentFields(id: Agent): EditableField[] {
    const fields = edited.agents[id];
    return fields ? [...fields] : [];
  }

  function markEdited(id: Provider, field: EditableField): void {
    const fields = edited.configs[id];
    if (fields) fields.add(field);
    else edited.configs[id] = new Set([field]);
  }

  function editedFields(id: Provider): EditableField[] {
    const fields = edited.configs[id];
    return fields ? [...fields] : [];
  }

  function hasEdits(providerId: Provider, agentId: Agent): boolean {
    return (
      edited.provider ||
      edited.systemPrompt ||
      editedFields(providerId).length > 0 ||
      edited.tts.size > 0 ||
      edited.uplinkMode ||
      edited.agent ||
      editedAgentFields(agentId).length > 0
    );
  }

  /** Everything edited has been stored → the next change starts clean. */
  function clearEdited(): void {
    edited.provider = false;
    edited.systemPrompt = false;
    edited.configs = {};
    edited.tts = new Set();
    edited.uplinkMode = false;
    edited.agent = false;
    edited.agents = {};
  }

  /**
   * Single persistence path for this modal (H3/H4: settings actually persist).
   *
   * - only what the user edited travels anywhere (D3): a provider-card click
   *   posts `{ provider }` and nothing else, so the server-side prefill
   *   survives a click on a clean profile;
   * - localStorage gets `{ provider, systemPrompt, configs }` **without** API
   *   keys: key material may only live on the server (security review §2), and
   *   the local copy is what survives a reload, so nothing secret is written
   *   here. A hydrated prefill is not copied in either — it stays server-side
   *   and is re-read on every load;
   * - the same edited fields are POSTed to `/api/settings`, because the server
   *   is the source of truth for `resolveConfig()`. The key field is omitted
   *   when empty, so editing the base URL later cannot wipe a key that is
   *   already stored server-side;
   * - a failed POST must never break the UI, hence the catch.
   *
   * @returns true when the server accepted the update (or there was nothing to
   * send).
   */
  async function persistSettings(): Promise<boolean> {
    const config = providers[selectedProvider];
    const agentConfig = agents[selectedAgent];
    if (!config || !agentConfig) return false;
    // Nothing was edited (e.g. a re-click of the already-active card): a POST
    // here would have nothing to say and nothing to risk.
    if (!hasEdits(selectedProvider, selectedAgent)) return true;

    const stored = readStoredSettings();

    const patch: Partial<ProviderConfig> = {};
    for (const field of editedFields(selectedProvider)) {
      if (field === 'apiKey') {
        // Write-only: an empty key field means "leave the stored key alone".
        if (config.apiKey) patch.apiKey = config.apiKey;
      } else if (field === 'timeoutMs') {
        patch.timeoutMs = config.timeoutMs;
      } else if (field === 'baseUrl') {
        patch.baseUrl = config.baseUrl;
      } else {
        patch.model = config.model;
      }
    }
    const hasConfigPatch = Object.keys(patch).length > 0;

    const nextConfigs: NonNullable<StoredSettings['configs']> = {
      ...(stored.configs || {}),
      ...(hasConfigPatch ? { [selectedProvider]: patch } : {})
    };

    // TTS engine block: same edited-only contract; the key is write-only.
    const ttsPatch: Partial<TtsConfig> = {};
    for (const field of edited.tts) {
      if (field === 'apiKey') {
        if (tts.apiKey) ttsPatch.apiKey = tts.apiKey;
      } else if (field === 'provider') {
        ttsPatch.provider = tts.provider;
      } else if (field === 'voice') {
        ttsPatch.voice = tts.voice;
      } else if (field === 'model') {
        ttsPatch.model = tts.model;
      } else if (field === 'baseUrl') {
        ttsPatch.baseUrl = tts.baseUrl;
      } else {
        ttsPatch.modelPath = tts.modelPath;
      }
    }
    const hasTtsPatch = Object.keys(ttsPatch).length > 0;
    const nextTts: StoredSettings['tts'] = { ...(stored.tts || {}), ...ttsPatch };

    // Agent uplink block: same edited-only contract; the key is write-only.
    const agentPatch: Partial<AgentConfig> = {};
    for (const field of editedAgentFields(selectedAgent)) {
      if (field === 'apiKey') {
        if (agentConfig.apiKey) agentPatch.apiKey = agentConfig.apiKey;
      } else if (field === 'timeoutMs') {
        agentPatch.timeoutMs = agentConfig.timeoutMs;
      } else if (field === 'baseUrl') {
        agentPatch.baseUrl = agentConfig.baseUrl;
      } else {
        agentPatch.model = agentConfig.model;
      }
    }
    const hasAgentPatch = Object.keys(agentPatch).length > 0;
    const nextAgents: NonNullable<StoredSettings['agents']> = {
      ...(stored.agents || {}),
      ...(hasAgentPatch ? { [selectedAgent]: agentPatch } : {})
    };

    const localProvider =
      edited.provider || typeof stored.provider === 'string' ? selectedProvider : undefined;
    const localPrompt =
      edited.systemPrompt || typeof stored.systemPrompt === 'string' ? systemPrompt : undefined;
    const localMode =
      edited.uplinkMode || typeof stored.uplinkMode === 'string' ? uplinkMode : undefined;
    const localAgent =
      edited.agent || typeof stored.agent === 'string' ? selectedAgent : undefined;

    try {
      // localStorage copy: LLM configs without keys, TTS without the key,
      // agents without keys.
      const { apiKey: _ttsKey, ...ttsLocal } = nextTts;
      localStorage.setItem(
        'globe-settings',
        JSON.stringify({
          ...stored,
          ...(localProvider !== undefined ? { provider: localProvider } : {}),
          ...(localPrompt !== undefined ? { systemPrompt: localPrompt } : {}),
          ...(localMode !== undefined ? { uplinkMode: localMode } : {}),
          ...(localAgent !== undefined ? { agent: localAgent } : {}),
          configs: stripKeys(nextConfigs),
          ...(Object.keys(ttsLocal).length > 0 ? { tts: ttsLocal } : {}),
          agents: stripAgentKeys(nextAgents)
        })
      );
    } catch (err) {
      console.error('Failed to save settings locally:', err);
    }

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          ...(edited.systemPrompt ? { systemPrompt } : {}),
          ...(hasConfigPatch ? { configs: { [selectedProvider]: patch } } : {}),
          ...(hasTtsPatch ? { tts: ttsPatch } : {}),
          ...(edited.uplinkMode ? { uplinkMode } : {}),
          ...(edited.agent ? { agent: selectedAgent } : {}),
          ...(hasAgentPatch ? { agents: { [selectedAgent]: agentPatch } } : {})
        })
      });
      if (res.ok) {
        if (config.apiKey) keySaved = true;
        if (agentConfig.apiKey) {
          agentKeySaved = true;
          agentConfig.apiKey = '';
        }
        if (tts.apiKey) {
          ttsKeySaved = true;
          tts.apiKey = '';
        }
        clearEdited();
        return true;
      }
      return false;
    } catch (err) {
      // Server unreachable — the UI keeps working off the local copy.
      console.warn('Could not sync settings to server:', err);
      return false;
    }
  }

  /**
   * Ask the server whether a key exists. The value itself never comes back
   * (new server) — and if an older server still echoes it, only the boolean is
   * kept and the response is dropped.
   */
  async function refreshKeyStatus(): Promise<void> {
    try {
      const res = await fetch('/api/settings', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data?.configs?.[selectedProvider];
      if (typeof data?.hasKey === 'boolean') keySaved = data.hasKey;
      else if (cfg && typeof cfg.hasKey === 'boolean') keySaved = cfg.hasKey;
      else if (cfg && typeof cfg.apiKey === 'string') keySaved = cfg.apiKey.length > 0;
      else if (typeof data?.apiKey === 'string') keySaved = data.apiKey.length > 0;
    } catch {
      // Offline or pre-upgrade server: we simply don't know.
    }
  }

  /**
   * Structural view of a settings object: what `readStoredSettings()` returns
   * and what `$lib/settingsSync` merges in from the server have to feed the
   * same applier.
   */
  interface SettingsView {
    provider?: string;
    systemPrompt?: string;
    configs?: Record<string, { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number }>;
    tts?: {
      provider?: string;
      voice?: string;
      model?: string;
      baseUrl?: string;
      apiKey?: string;
      modelPath?: string;
      hasKey?: boolean;
    };
    uplinkMode?: string;
    agent?: string;
    agents?: Record<string, { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number }>;
  }

  /**
   * Apply a settings object — the local copy or the server-merged view — to
   * component state. Returns whether it found legacy API keys to scrub.
   */
  function applyStoredSettings(saved: SettingsView): boolean {
    if (saved.provider && providers[saved.provider as Provider]) {
      selectedProvider = saved.provider as Provider;
    }
    if (typeof saved.systemPrompt === 'string') systemPrompt = saved.systemPrompt;
    if (saved.uplinkMode === 'provider' || saved.uplinkMode === 'agent') {
      uplinkMode = saved.uplinkMode;
    }
    if (saved.agent && agents[saved.agent as Agent]) {
      selectedAgent = saved.agent as Agent;
    }
    for (const [id, config] of Object.entries(saved.agents || {})) {
      const target = agents[id as Agent];
      if (!target || !config) continue;
      if (typeof config.baseUrl === 'string') target.baseUrl = config.baseUrl;
      if (typeof config.model === 'string') target.model = config.model;
      if (typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)) {
        target.timeoutMs = Math.min(Math.max(Math.round(config.timeoutMs), 5_000), 600_000);
      }
    }

    let scrubbed = false;
    for (const [id, config] of Object.entries(saved.configs || {})) {
      const target = providers[id as Provider];
      if (!target || !config) continue;
      // baseUrl/model/timeout come back; apiKey never does — the field is write-only.
      if (typeof config.baseUrl === 'string') target.baseUrl = config.baseUrl;
      if (typeof config.model === 'string') target.model = config.model;
      if (typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)) {
        target.timeoutMs = Math.min(Math.max(Math.round(config.timeoutMs), 5_000), 600_000);
      }
      if (config.apiKey) {
        scrubbed = true;
        delete config.apiKey;
      }
    }
    // TTS engine block: provider + per-engine fields; apiKey never comes back.
    if (saved.tts && typeof saved.tts === 'object') {
      const incoming = saved.tts;
      if (incoming.provider && TTS_ENGINES.some((e) => e.id === incoming.provider)) {
        tts.provider = incoming.provider as TtsProvider;
      }
      for (const field of ['voice', 'model', 'baseUrl', 'modelPath'] as const) {
        if (typeof incoming[field] === 'string') tts[field] = incoming[field] as string;
      }
      if (incoming.apiKey) {
        scrubbed = true;
        delete incoming.apiKey;
      }
    }
    return scrubbed;
  }

  // Restore saved provider/system prompt/configs (called once, after `providers` exists).
  function loadSavedSettings(): void {
    const saved = readStoredSettings();
    const scrubbed = applyStoredSettings(saved);

    // Older builds wrote keys into localStorage — remove them on first load.
    if (scrubbed) {
      try {
        localStorage.setItem(
          'globe-settings',
          JSON.stringify({ ...saved, configs: stripKeys(saved.configs), agents: stripAgentKeys(saved.agents) })
        );
      } catch (err) {
        console.error('Failed to scrub stored API keys:', err);
      }
    }
  }

  /**
   * D1: adopt the server's prefill for every field this browser never set.
   *
   * `loadEffectiveSettings()` merges the local copy with `GET /api/settings`
   * (local wins, server fills the gaps) and writes nothing, so the prefill in
   * `.globe-settings.json` keeps reaching a fresh profile on every load — and
   * stays visible until the user actually edits a field. This is what makes the
   * "zero-setup first message" goal hold.
   */
  async function hydrateFromServer(): Promise<void> {
    const merged = await loadEffectiveSettings();
    applyStoredSettings(merged);
    // After hydration: whichever provider won, report its key status.
    await refreshKeyStatus();
    await refreshTtsKeyStatus();
    await refreshAgentKeyStatus();
  }

  /**
   * D2: probe through the server, never from the browser.
   *
   * The browser-side probe could not succeed for the configuration the owner
   * actually runs: LM Studio answers no CORS headers (the fetch throws before a
   * status can be read) and `config.apiKey` is `""` in the browser by design
   * (write-only key), so a healthy provider still failed the badge. `POST
   * /api/health` resolves the base URL *and* the key server-side, exactly like
   * `/api/chat` does — the body carries only the provider id.
   */
  // Last server-reported probe detail (e.g. `URL not allowed`, `fetch failed`,
  // `HTTP 401`) shown under the LINKED / NO SIGNAL word so a failure says why.
  let providerHealthDetail = $state<Record<string, string>>({});

  async function checkProviderHealth(providerId: Provider) {
    await checkUplinkHealth({ providerId });
  }

  async function checkAgentHealth(agentId: Agent) {
    await checkUplinkHealth({ agentId });
  }

  /** Shared probe: `{ providerId }` or `{ agentId }` — the server resolves both. */
  async function checkUplinkHealth(body: { providerId?: Provider; agentId?: Agent }) {
    const uplinkId = body.agentId ?? body.providerId ?? selectedProvider;
    // Flush unsaved edits first: the probe resolves base URL + key server-side,
    // so without this it would test the last-saved config — not what the user
    // just typed — and the badge would lie until the next save.
    await persistSettings();
    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Server-side probe budget: up to two candidate URLs × 5 s each.
        signal: AbortSignal.timeout(15_000)
      });
      const data: unknown = res.ok ? await res.json() : null;
      const healthy =
        !!data && typeof data === 'object' && (data as { healthy?: unknown }).healthy === true;
      const detail =
        !!data && typeof data === 'object'
          ? String((data as { error?: unknown }).error ?? '')
          : res.ok
            ? ''
            : `HTTP ${res.status}`;
      pushEvent(healthy ? 'LINK' : 'ERROR', `${uplinkId} check: ${healthy ? 'linked' : detail || 'failed'}`);

      providerHealth[uplinkId] = {
        status: healthy ? 'healthy' : 'unhealthy',
        lastChecked: Date.now()
      };
      providerHealthDetail[uplinkId] = healthy ? '' : detail;
    } catch {
      providerHealth[uplinkId] = { status: 'unhealthy', lastChecked: Date.now() };
      providerHealthDetail[uplinkId] = 'Request failed';
    }
  }

  type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

  /**
   * Connection status reads as a plain white mark **plus a word** — never a
   * colour. The owner standardised every icon on plain white, so the state has
   * to survive in shape + text (which also keeps it legible without colour).
   */
  function healthWord(status: HealthStatus): string {
    switch (status) {
      case 'healthy': return 'LINKED';
      case 'unhealthy': return 'NO SIGNAL';
      default: return 'NOT CHECKED';
    }
  }

  // The timestamp is `number | undefined`; wrapping the `new Date(...)` call
  // keeps svelte-check happy instead of asserting inside the template.
  function healthTime(lastChecked?: number): string {
    return lastChecked ? new Date(lastChecked).toLocaleTimeString() : '';
  }

  /**
   * Provider card click (H2): this function did not exist, so every click threw
   * `ReferenceError: handleSelect is not defined` and provider switching was
   * impossible. Selecting a provider updates state, tells the parent (which sets
   * the `X-Provider` header), persists the choice and re-runs the health check.
   */
  function handleSelect(id: Provider) {
    selectedProvider = id;
    // The selection itself is an edit: it is the one thing a card click means.
    edited.provider = true;
    notifyUplink();
    void persistSettings();
    void refreshKeyStatus();
    void handleHealthCheck();
  }

  function toggle() {
    open = !open;
  }

  async function handleSystemPromptChange() {
    edited.systemPrompt = true;
    await persistSettings();
  }

  // Base URL / API key / model edits — was `onChange={…}`, which Svelte 5 compiles
  // to `addEventListener('Change')` and therefore never fired (H3). The field
  // name travels with the handler so only the field the user touched is sent (D3).
  async function handleProviderFieldChange(field: 'baseUrl' | 'model') {
    markEdited(selectedProvider, field);
    await persistSettings();
  }

  // Per-uplink timeout edit (seconds in the field, ms in state/settings).
  // Non-numeric or out-of-range input is clamped, never rejected with a throw.
  async function handleTimeoutChange(raw: string) {
    const secs = Number(raw);
    const ms = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : DEFAULT_TIMEOUT_MS;
    const config = providers[selectedProvider];
    if (config) config.timeoutMs = Math.min(Math.max(ms, 5_000), 600_000);
    markEdited(selectedProvider, 'timeoutMs');
    await persistSettings();
  }

  function timeoutSecs(providerId: Provider): string {
    const ms = providers[providerId]?.timeoutMs;
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
      ? String(Math.round(ms / 1000))
      : String(Math.round(DEFAULT_TIMEOUT_MS / 1000));
  }

  // TTS engine edits: same edited-only contract as the LLM providers; the key
  // is write-only and cleared from state once the server accepts it.
  async function handleTtsSelect(id: TtsProvider) {
    tts.provider = id;
    edited.tts.add('provider');
    await persistSettings();
    await refreshTtsKeyStatus();
  }

  async function handleTtsFieldChange(field: 'voice' | 'model' | 'baseUrl' | 'modelPath') {
    edited.tts.add(field);
    await persistSettings();
  }

  async function handleTtsApiKeyChange() {
    edited.tts.add('apiKey');
    await persistSettings();
  }

  // Agent uplink state: which section carries chat + which agent entry.
  let uplinkMode = $state<UplinkMode>('provider');
  let selectedAgent = $state<Agent>('hermes-agent');
  let agentKeySaved = $state(false);

  async function refreshAgentKeyStatus(): Promise<void> {
    try {
      const res = await fetch('/api/settings', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data?.agents?.[selectedAgent];
      if (cfg && typeof cfg.hasKey === 'boolean') agentKeySaved = cfg.hasKey;
    } catch {
      // Offline or pre-upgrade server: we simply don't know.
    }
  }

  async function handleUplinkModeSelect(mode: UplinkMode) {
    uplinkMode = mode;
    edited.uplinkMode = true;
    notifyUplink();
    await persistSettings();
    if (mode === 'agent') {
      await refreshAgentKeyStatus();
      await checkAgentHealth(selectedAgent);
    } else {
      await refreshKeyStatus();
      await handleHealthCheck();
    }
  }

  async function handleAgentSelect(id: Agent) {
    selectedAgent = id;
    edited.agent = true;
    notifyUplink();
    await persistSettings();
    await refreshAgentKeyStatus();
    await checkAgentHealth(id);
  }

  async function handleAgentFieldChange(field: 'baseUrl' | 'model') {
    markAgentEdited(selectedAgent, field);
    await persistSettings();
  }

  async function handleAgentTimeoutChange(raw: string) {
    const secs = Number(raw);
    const ms = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : DEFAULT_TIMEOUT_MS;
    const target = agents[selectedAgent];
    if (target) target.timeoutMs = Math.min(Math.max(ms, 5_000), 600_000);
    markAgentEdited(selectedAgent, 'timeoutMs');
    await persistSettings();
  }

  function agentTimeoutSecs(agentId: Agent): string {
    const ms = agents[agentId]?.timeoutMs;
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
      ? String(Math.round(ms / 1000))
      : String(Math.round(DEFAULT_TIMEOUT_MS / 1000));
  }

  async function handleAgentApiKeyChange() {
    markAgentEdited(selectedAgent, 'apiKey');
    const savedToServer = await persistSettings();
    const target = agents[selectedAgent];
    if (savedToServer && target?.apiKey) {
      target.apiKey = '';
      agentKeySaved = true;
    }
  }

  async function handleAgentHealthCheck() {
    if (selectedAgent && agents[selectedAgent]) {
      await checkAgentHealth(selectedAgent);
    }
  }

  // `true` when the server already holds a key for the active TTS engine.
  let ttsKeySaved = $state(false);

  async function refreshTtsKeyStatus(): Promise<void> {
    try {
      const res = await fetch('/api/settings', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data?.tts;
      if (cfg && typeof cfg.hasKey === 'boolean') ttsKeySaved = cfg.hasKey;
    } catch {
      // Offline or pre-upgrade server: we simply don't know.
    }
  }



  // Write-only API key field: the value is POSTed to the server and then dropped
  // from component state, so it can never be written to localStorage. What the
  // UI keeps is only the fact that a key exists ("saved on server").
  async function handleApiKeyChange() {
    markEdited(selectedProvider, 'apiKey');
    const savedToServer = await persistSettings();
    const config = providers[selectedProvider];
    if (savedToServer && config?.apiKey) {
      config.apiKey = '';
      keySaved = true;
    }
  }

  async function handleHealthCheck() {
    if (selectedProvider && providers[selectedProvider]) {
      await checkProviderHealth(selectedProvider);
    }
  }

  // `$state` so `bind:value` edits are visible to sibling reads (health check,
  // the config header) instead of living only inside the input element.
  function blankProviderConfig(id: Provider, name: string, baseUrl = '', model = ''): ProviderConfig {
    return { id, name, baseUrl, apiKey: '', model, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  let providers = $state<Record<Provider, ProviderConfig>>({
    hermes: blankProviderConfig('hermes', 'Hermes Agent AI Platform', '', 'hermes-agent'),
    // Product default: LM Studio's own loopback port. Never a test-stub port —
    // an e2e mock once leaked `127.0.0.1:5224/v1` into the owner's config.
    lmstudio: blankProviderConfig('lmstudio', 'LM Studio (Local)', 'http://127.0.0.1:1234/v1'),
    opencode: blankProviderConfig('opencode', 'OpenCode Zen and Go', 'http://localhost:8765/v1'),
    openrouter: blankProviderConfig('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
    deepseek: blankProviderConfig('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'),
    openclaw: blankProviderConfig('openclaw', 'OpenClaw AI Platform'),
    mimo: blankProviderConfig('mimo', 'Xiaomi MiMo', 'https://api.xiaomimimo.com/v1', 'mimo-v2-flash')
  });

  // Agent uplink entries (remote Hermes / OpenClaw gateways) — separate
  // namespace from providers, same write-only-key contract.
  let agents = $state<Record<Agent, AgentConfig>>({
    'hermes-agent': {
      id: 'hermes-agent',
      name: 'Hermes Agent',
      baseUrl: '',
      apiKey: '',
      model: 'hermes-agent',
      timeoutMs: DEFAULT_TIMEOUT_MS
    },
    'openclaw-agent': {
      id: 'openclaw-agent',
      name: 'OpenClaw',
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  });

  // TTS engine state (Hermes-style engine table; `system` = OS-native default).
  let tts = $state<TtsConfig>({
    provider: 'system',
    voice: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    modelPath: ''
  });

  // Restore whatever the owner configured last session (provider, prompt, configs).
  // Replaces the old `providerDefaults`/`activeProviders` pair: it was a shallow
  // copy that shared every nested config object, and `activeProviders` was never
  // read again (L11).
  loadSavedSettings();
  // D1: fill everything this browser has never set from the server's own view
  // (that is what makes the server-side prefill show up on a fresh profile),
  // then report whether a key exists for whichever provider won.
  void hydrateFromServer();
</script>

<!-- Provider marks: one plain white monochrome glyph per provider, one stroke
     weight (1.6), no brand colour, no emoji. -->
{#snippet providerGlyph(id: Provider)}
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">
    {#if id === 'hermes'}
      <circle cx="12" cy="12" r="2.6"></circle>
      <ellipse cx="12" cy="12" rx="9.3" ry="4.3" transform="rotate(-28 12 12)"></ellipse>
      <ellipse cx="12" cy="12" rx="9.3" ry="4.3" transform="rotate(28 12 12)"></ellipse>
    {:else if id === 'lmstudio'}
      <path d="M12 3.4l7.8 4.3v8.6L12 20.6 4.2 16.3V7.7z"></path>
      <path d="M12 12l7.8-4.3M12 12v8.6M12 12L4.2 7.7"></path>
    {:else if id === 'opencode'}
      <path d="M9 7.5L4.6 12 9 16.5M15 7.5L19.4 12 15 16.5"></path>
      <path d="M13.3 5.4l-2.6 13.2"></path>
    {:else if id === 'openrouter'}
      <circle cx="12" cy="12" r="8.5"></circle>
      <path d="M3.5 12h17"></path>
      <path d="M12 3.5c2.6 2.7 2.6 14.3 0 17M12 3.5c-2.6 2.7-2.6 14.3 0 17"></path>
    {:else if id === 'deepseek'}
      <circle cx="12" cy="12" r="8.5"></circle>
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 1.9v3.3M12 18.8v3.3M1.9 12h3.3M18.8 12h3.3"></path>
    {:else if id === 'mimo'}
      <path d="M4 16.5l3.5-9 3.2 6.5 3.2-9.5 3.1 8L20.5 8"></path>
      <path d="M4 19.5h16"></path>
    {:else}
      <path d="M7 5.4c-.9 5.3 1.3 8.7 5 9.8 3.7-1.1 5.9-4.5 5-9.8"></path>
      <path d="M9.6 17.4h4.8"></path>
      <circle cx="12" cy="19.9" r="1.5"></circle>
    {/if}
  </svg>
{/snippet}

<!-- Settings Button (bottom right) — hidden when the host provides its own entry -->
{#if !hideTrigger}
	<button class="settings-btn" onclick={toggle} title="Settings" aria-label="Settings">
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
			<circle cx="12" cy="12" r="3"></circle>
			<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"></path>
		</svg>
	</button>
{/if}

<!-- Settings Modal — Visor HUD: hairline outline + corner brackets over a
     translucent scrim, underline inputs, bracket-end buttons, white marks. -->
{#if open}
  <button class="backdrop" aria-label="Close settings" onclick={toggle}></button>

  <div class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
    <span class="corner tl" aria-hidden="true"></span>
    <span class="corner tr" aria-hidden="true"></span>
    <span class="corner bl" aria-hidden="true"></span>
    <span class="corner br" aria-hidden="true"></span>

    <div class="modal-scroll">
      <div class="modal-header">
        <h2 class="modal-title">
          <span class="title-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"></path>
            </svg>
          </span>
          Settings
        </h2>
        <button class="close-btn" onclick={toggle} title="Close" aria-label="Close settings">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M6 6l12 12M18 6L6 18"></path>
          </svg>
        </button>
      </div>

      <!-- Uplink mode: stateless providers vs stateful remote agents. Only the
           active section carries chat. -->
      <div class="uplink-switch" role="group" aria-label="Uplink mode">
        <button
          class="uplink-tab {uplinkMode === 'provider' ? 'active' : ''}"
          aria-pressed={uplinkMode === 'provider'}
          onclick={() => handleUplinkModeSelect('provider')}
        >
          <span class="uplink-tab-key">PROVIDER UPLINK</span>
          <span class="uplink-tab-hint">Stateless chat endpoints</span>
        </button>
        <button
          class="uplink-tab {uplinkMode === 'agent' ? 'active' : ''}"
          aria-pressed={uplinkMode === 'agent'}
          onclick={() => handleUplinkModeSelect('agent')}
        >
          <span class="uplink-tab-key">AGENT UPLINK</span>
          <span class="uplink-tab-hint">Remote Hermes / OpenClaw</span>
        </button>
      </div>

      <div class="provider-list" role="group" aria-label="Providers">
        <span class="section-label">Provider uplink</span>

        {#each Object.values(providers) as provider}
          <button
            class="provider-card {selectedProvider === provider.id ? 'active' : ''}"
            aria-pressed={selectedProvider === provider.id}
            onclick={() => handleSelect(provider.id)}
          >
            <span class="provider-icon" aria-hidden="true">
              {@render providerGlyph(provider.id)}
            </span>
            <span class="provider-name">{provider.name}</span>
            {#if selectedProvider === provider.id}
              <span class="selected-badge">✓ Active</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Provider Configuration -->
      {#if providers[selectedProvider]}
        <div class="config-section">
          <h3 class="config-title">Configure: {providers[selectedProvider].name}</h3>

          <!-- Health Status -->
          <div class="health-status">
            <span class="health-label">Connection Status</span>
            <span class="health-mark" data-status={providerHealth[selectedProvider]?.status || 'unknown'}>
              {#if (providerHealth[selectedProvider]?.status || 'unknown') === 'healthy'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                </svg>
              {:else if providerHealth[selectedProvider]?.status === 'unhealthy'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M6 6l12 12M18 6L6 18"></path>
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M5 12h14"></path>
                </svg>
              {/if}
            </span>
            <span class="health-word">{healthWord(providerHealth[selectedProvider]?.status || 'unknown')}</span>
            {#if providerHealthDetail[selectedProvider]}
              <small class="health-error">{providerHealthDetail[selectedProvider]}</small>
            {/if}
            {#if providerHealth[selectedProvider]?.lastChecked}
              <small class="health-time">{healthTime(providerHealth[selectedProvider]?.lastChecked)}</small>
            {/if}
            <button class="btn-bracket check-health-btn" onclick={handleHealthCheck}>
              Check Connection
            </button>
          </div>

          <div class="form-group">
            <label for="cfg-base-url">Base URL</label>
            <input
              id="cfg-base-url"
              type="text"
              bind:value={providers[selectedProvider].baseUrl}
              placeholder="e.g., http://127.0.0.1:1234/v1"
              onchange={() => handleProviderFieldChange('baseUrl')}
            />
          </div>

          <div class="form-group">
            <label for="cfg-api-key">
              API Key (optional)
              {#if keySaved}
                <span class="key-saved">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                  </svg>
                  saved on server
                </span>
              {/if}
            </label>
            <!-- Write-only: the value is POSTed to the server and never kept in the browser. -->
            <input
              id="cfg-api-key"
              type="password"
              bind:value={providers[selectedProvider].apiKey}
              placeholder={keySaved ? '•••••••• (stored on the server)' : 'sk-...'}
              onchange={handleApiKeyChange}
            />
          </div>

          <div class="form-group">
            <label for="cfg-model">Model</label>
            <input
              id="cfg-model"
              type="text"
              bind:value={providers[selectedProvider].model}
              placeholder="e.g., qwen3.6-35b-a3b"
              onchange={() => handleProviderFieldChange('model')}
            />
          </div>

          <div class="form-group">
            <label for="cfg-timeout">Uplink timeout (seconds)</label>
            <input
              id="cfg-timeout"
              type="number"
              min="5"
              max="600"
              step="1"
              value={timeoutSecs(selectedProvider)}
              placeholder="120"
              onchange={(e) => handleTimeoutChange(e.currentTarget.value)}
            />
            <small class="field-hint">Budget for this uplink: chat stream + health probe (5–600 s).</small>
          </div>

          <!-- System Prompt -->
          <div class="form-group">
            <label for="cfg-prompt">System Prompt (Optional)</label>
            <textarea
              id="cfg-prompt"
              bind:value={systemPrompt}
              placeholder="e.g., You are a helpful AI assistant that speaks in a friendly and concise manner."
              rows="4"
              onchange={handleSystemPromptChange}
            ></textarea>
          </div>
        </div>
      {/if}

      <!-- Agent uplink: remote Hermes / OpenClaw gateways. Carries chat only
           when the AGENT UPLINK tab is active. -->
      <div class="provider-list" role="group" aria-label="Agent uplink">
        <span class="section-label">Agent uplink</span>
        {#if uplinkMode !== 'agent'}
          <small class="field-hint">Idle — select AGENT UPLINK above to route chat here.</small>
        {/if}

        {#each AGENT_ENTRIES as entry}
          {@const agent = agents[entry.id]}
          <button
            class="provider-card {selectedAgent === entry.id ? 'active' : ''}"
            aria-pressed={selectedAgent === entry.id}
            onclick={() => handleAgentSelect(entry.id)}
          >
            <span class="provider-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">
                {#if entry.id === 'hermes-agent'}
                  <circle cx="12" cy="12" r="2.6"></circle>
                  <ellipse cx="12" cy="12" rx="9.3" ry="4.3" transform="rotate(-28 12 12)"></ellipse>
                  <ellipse cx="12" cy="12" rx="9.3" ry="4.3" transform="rotate(28 12 12)"></ellipse>
                {:else}
                  <path d="M7 5.4c-.9 5.3 1.3 8.7 5 9.8 3.7-1.1 5.9-4.5 5-9.8"></path>
                  <path d="M9.6 17.4h4.8"></path>
                  <circle cx="12" cy="19.9" r="1.5"></circle>
                {/if}
              </svg>
            </span>
            <span class="provider-name">{entry.name}</span>
            <span class="engine-hint">{entry.hint}</span>
            {#if selectedAgent === entry.id && uplinkMode === 'agent'}
              <span class="selected-badge">✓ Active</span>
            {/if}
          </button>
        {/each}
      </div>

      {#if agents[selectedAgent]}
        <div class="config-section">
          <h3 class="config-title">Configure: {agents[selectedAgent].name}</h3>

          <div class="health-status">
            <span class="health-label">Connection Status</span>
            <span class="health-mark" data-status={providerHealth[selectedAgent]?.status || 'unknown'}>
              {#if (providerHealth[selectedAgent]?.status || 'unknown') === 'healthy'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                </svg>
              {:else if providerHealth[selectedAgent]?.status === 'unhealthy'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M6 6l12 12M18 6L6 18"></path>
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M5 12h14"></path>
                </svg>
              {/if}
            </span>
            <span class="health-word">{healthWord(providerHealth[selectedAgent]?.status || 'unknown')}</span>
            {#if providerHealthDetail[selectedAgent]}
              <small class="health-error">{providerHealthDetail[selectedAgent]}</small>
            {/if}
            {#if providerHealth[selectedAgent]?.lastChecked}
              <small class="health-time">{healthTime(providerHealth[selectedAgent]?.lastChecked)}</small>
            {/if}
            <button class="btn-bracket check-health-btn" onclick={handleAgentHealthCheck}>
              Check Connection
            </button>
          </div>

          <div class="form-group">
            <label for="agent-base-url">Gateway URL</label>
            <input
              id="agent-base-url"
              type="text"
              bind:value={agents[selectedAgent].baseUrl}
              placeholder="e.g., http://192.168.1.20:8000/v1"
              onchange={() => handleAgentFieldChange('baseUrl')}
            />
            <small class="field-hint">Remote Hermes / OpenClaw gateway — loopback, LAN, or Tailscale.</small>
          </div>

          <div class="form-group">
            <label for="agent-api-key">
              API Key (optional)
              {#if agentKeySaved}
                <span class="key-saved">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                  </svg>
                  saved on server
                </span>
              {/if}
            </label>
            <input
              id="agent-api-key"
              type="password"
              bind:value={agents[selectedAgent].apiKey}
              placeholder={agentKeySaved ? '•••••••• (stored on the server)' : 'sk-...'}
              onchange={handleAgentApiKeyChange}
            />
          </div>

          <div class="form-group">
            <label for="agent-model">Model</label>
            <input
              id="agent-model"
              type="text"
              bind:value={agents[selectedAgent].model}
              placeholder="e.g., hermes-agent"
              onchange={() => handleAgentFieldChange('model')}
            />
          </div>

          <div class="form-group">
            <label for="agent-timeout">Uplink timeout (seconds)</label>
            <input
              id="agent-timeout"
              type="number"
              min="5"
              max="600"
              step="1"
              value={agentTimeoutSecs(selectedAgent)}
              placeholder="120"
              onchange={(e) => handleAgentTimeoutChange(e.currentTarget.value)}
            />
            <small class="field-hint">Budget for this uplink: chat stream + health probe (5–600 s).</small>
          </div>
        </div>
      {/if}

      <!-- Voice output (TTS engine table) -->
      <div class="provider-list" role="group" aria-label="Voice output engines">
        <span class="section-label">Voice output</span>

        {#each TTS_ENGINES as engine}
          <button
            class="provider-card {tts.provider === engine.id ? 'active' : ''}"
            aria-pressed={tts.provider === engine.id}
            onclick={() => handleTtsSelect(engine.id)}
          >
            <span class="provider-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6">
                {#if engine.id === 'system'}
                  <path d="M4 10v4h3l4 3.5v-11L7 10z"></path>
                  <path d="M15.5 9.5a4 4 0 0 1 0 5M18 7a7.5 7.5 0 0 1 0 10"></path>
                {:else if engine.id === 'piper'}
                  <rect x="5" y="5" width="14" height="10" rx="1.5"></rect>
                  <path d="M9 19h6M12 15v4"></path>
                {:else if engine.id === 'edge'}
                  <circle cx="12" cy="12" r="8.5"></circle>
                  <path d="M3.5 12h17"></path>
                {:else if engine.id === 'openai'}
                  <circle cx="12" cy="12" r="2.6"></circle>
                  <ellipse cx="12" cy="12" rx="9.3" ry="4.3" transform="rotate(-28 12 12)"></ellipse>
                {:else}
                  <path d="M12 3.5v17M5 7.5l14 9M19 7.5l-14 9"></path>
                {/if}
              </svg>
            </span>
            <span class="provider-name">{engine.name}</span>
            <span class="engine-hint">{engine.hint}</span>
            {#if tts.provider === engine.id}
              <span class="selected-badge">✓ Active</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="config-section">
        <h3 class="config-title">Configure: {TTS_ENGINES.find((e) => e.id === tts.provider)?.name ?? tts.provider}</h3>

        {#if tts.provider === 'system'}
          <div class="form-group">
            <label for="tts-voice">Voice (optional)</label>
            <input
              id="tts-voice"
              type="text"
              bind:value={tts.voice}
              placeholder="OS default voice"
              onchange={() => handleTtsFieldChange('voice')}
            />
            <small class="field-hint">macOS `say` voice, Windows voice-name match, or espeak-ng voice (e.g. en). Empty = OS default.</small>
          </div>
        {:else if tts.provider === 'piper'}
          <div class="form-group">
            <label for="tts-model-path">Voice model (.onnx)</label>
            <input
              id="tts-model-path"
              type="text"
              bind:value={tts.modelPath}
              placeholder="/path/to/en_US-lessac-medium.onnx"
              onchange={() => handleTtsFieldChange('modelPath')}
            />
            <small class="field-hint">`PIPER_MODEL` env var wins when set.</small>
          </div>
        {:else if tts.provider === 'edge'}
          <div class="form-group">
            <label for="tts-edge-voice">Voice (optional)</label>
            <input
              id="tts-edge-voice"
              type="text"
              bind:value={tts.voice}
              placeholder="e.g., en-US-AriaNeural"
              onchange={() => handleTtsFieldChange('voice')}
            />
            <small class="field-hint">Needs the `edge-tts` CLI (`pip install edge-tts`). Empty = Edge default.</small>
          </div>
        {:else if tts.provider === 'openai'}
          <div class="form-group">
            <label for="tts-openai-url">Base URL</label>
            <input
              id="tts-openai-url"
              type="text"
              bind:value={tts.baseUrl}
              placeholder="https://api.openai.com/v1"
              onchange={() => handleTtsFieldChange('baseUrl')}
            />
            <small class="field-hint">Any OpenAI-compatible `/audio/speech` endpoint (e.g. Kokoro).</small>
          </div>
          <div class="form-group">
            <label for="tts-openai-model">Model</label>
            <input
              id="tts-openai-model"
              type="text"
              bind:value={tts.model}
              placeholder="gpt-4o-mini-tts"
              onchange={() => handleTtsFieldChange('model')}
            />
          </div>
          <div class="form-group">
            <label for="tts-openai-voice">Voice</label>
            <input
              id="tts-openai-voice"
              type="text"
              bind:value={tts.voice}
              placeholder="alloy"
              onchange={() => handleTtsFieldChange('voice')}
            />
          </div>
          <div class="form-group">
            <label for="tts-openai-key">
              API Key
              {#if ttsKeySaved}
                <span class="key-saved">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                  </svg>
                  saved on server
                </span>
              {/if}
            </label>
            <input
              id="tts-openai-key"
              type="password"
              bind:value={tts.apiKey}
              placeholder={ttsKeySaved ? '•••••••• (stored on the server)' : 'sk-...'}
              onchange={handleTtsApiKeyChange}
            />
          </div>
        {:else}
          <div class="form-group">
            <label for="tts-eleven-model">Model</label>
            <input
              id="tts-eleven-model"
              type="text"
              bind:value={tts.model}
              placeholder="eleven_multilingual_v2"
              onchange={() => handleTtsFieldChange('model')}
            />
          </div>
          <div class="form-group">
            <label for="tts-eleven-voice">Voice ID</label>
            <input
              id="tts-eleven-voice"
              type="text"
              bind:value={tts.voice}
              placeholder="e.g., pNInz6obpgDQGcFmaJgB (Adam)"
              onchange={() => handleTtsFieldChange('voice')}
            />
          </div>
          <div class="form-group">
            <label for="tts-eleven-key">
              API Key
              {#if ttsKeySaved}
                <span class="key-saved">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5"></path>
                  </svg>
                  saved on server
                </span>
              {/if}
            </label>
            <input
              id="tts-eleven-key"
              type="password"
              bind:value={tts.apiKey}
              placeholder={ttsKeySaved ? '•••••••• (stored on the server)' : 'sk-...'}
              onchange={handleTtsApiKeyChange}
            />
          </div>
        {/if}

        <button class="btn-bracket gold save-btn" onclick={toggle}>Save &amp; Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-btn {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 46px;
    height: 46px;
    border-radius: var(--r-md);
    background: rgba(5, 11, 26, 0.6);
    border: 1px solid var(--hud-line);
    color: #ffffff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      background 0.2s ease;
    backdrop-filter: blur(12px);
  }

  .settings-btn:hover {
    background: rgba(125, 249, 255, 0.08);
    border-color: var(--hud-line-strong);
    box-shadow: 0 0 14px rgba(125, 249, 255, 0.35);
  }

  /* Translucent scrim over the globe — a wash, never a plate */
  .backdrop {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    padding: 0;
    margin: 0;
    border: none;
    background: radial-gradient(
      ellipse at center,
      rgba(5, 11, 26, 0.78) 0%,
      rgba(5, 11, 26, 0.64) 60%,
      rgba(5, 11, 26, 0.52) 100%
    );
    backdrop-filter: blur(2px);
    z-index: 95;
    cursor: default;
  }

  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(760px, 94vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, rgba(5, 11, 26, 0.92), rgba(5, 11, 26, 0.84));
    border: 1px solid var(--hud-line-strong);
    border-radius: 0;
    z-index: 96;
    backdrop-filter: blur(10px);
    box-shadow:
      0 0 44px rgba(125, 249, 255, 0.14),
      inset 0 0 60px rgba(5, 11, 26, 0.6);
    animation: modalIn 0.18s ease-out;
  }

  /* Cut-corner brackets — the panel reads as a reticle, not a dialog box */
  .corner {
    position: absolute;
    width: 20px;
    height: 20px;
    border: 1px solid var(--hud-cyan);
    box-shadow: 0 0 8px rgba(125, 249, 255, 0.35);
    z-index: 2;
    pointer-events: none;
  }
  .corner.tl {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .corner.tr {
    top: -1px;
    right: -1px;
    border-left: 0;
    border-bottom: 0;
  }
  .corner.bl {
    bottom: -1px;
    left: -1px;
    border-right: 0;
    border-top: 0;
  }
  .corner.br {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }

  .modal-scroll {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  @keyframes modalIn {
    from {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--hud-line);
    flex-shrink: 0;
  }

  .modal-title {
    display: flex;
    align-items: center;
    gap: 9px;
    font-family: var(--font-hud);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 2.2px;
    text-transform: uppercase;
    color: var(--hud-cyan);
    margin: 0;
  }

  /* Every icon in the app is plain white */
  .title-mark {
    display: flex;
    color: #ffffff;
  }

  .close-btn {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--hud-line);
    border-radius: 0;
    color: #ffffff;
    cursor: pointer;
    padding: 0;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      background 0.2s ease;
  }
  .close-btn:hover {
    border-color: var(--hud-line-strong);
    background: rgba(125, 249, 255, 0.08);
    box-shadow: 0 0 10px rgba(125, 249, 255, 0.3);
  }

  .provider-list {
    padding: 14px 18px;
    display: grid;
    gap: 6px;
  }

  /* Uplink mode switch: two tabs, active one carries the cyan edge. The
     inactive tab stays legible — mode must survive without colour. */
  .uplink-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    padding: 14px 18px 0;
  }

  .uplink-tab {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 9px 12px;
    background: transparent;
    border: 1px solid var(--hud-line);
    border-radius: 0;
    cursor: pointer;
    text-align: left;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      background 0.2s ease;
  }

  .uplink-tab:hover {
    background: rgba(125, 249, 255, 0.05);
    border-color: var(--hud-line-strong);
  }

  .uplink-tab.active {
    background: rgba(125, 249, 255, 0.06);
    border-color: var(--hud-cyan);
    box-shadow:
      0 0 14px rgba(125, 249, 255, 0.25),
      inset 0 0 22px rgba(125, 249, 255, 0.05);
  }

  .uplink-tab-key {
    font-family: var(--font-hud);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 1.8px;
    color: #e8f6ff;
  }

  .uplink-tab.active .uplink-tab-key {
    color: var(--hud-cyan);
  }

  .uplink-tab-hint {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.5px;
    color: var(--hud-steel);
  }

  .section-label {
    font-family: var(--font-hud);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.8px;
    text-transform: uppercase;
    color: var(--hud-steel);
    margin-bottom: 2px;
  }

  /* Hairline rows — outline only, never a filled or rounded card */
  .provider-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: transparent;
    border: 1px solid var(--hud-line);
    border-radius: 0;
    color: #e8f6ff;
    cursor: pointer;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      background 0.2s ease;
    text-align: left;
    width: 100%;
  }

  .provider-card:hover {
    background: rgba(125, 249, 255, 0.05);
    border-color: var(--hud-line-strong);
  }

  .provider-card.active {
    background: rgba(125, 249, 255, 0.06);
    border-color: var(--hud-cyan);
    box-shadow:
      0 0 14px rgba(125, 249, 255, 0.25),
      inset 0 0 22px rgba(125, 249, 255, 0.05);
  }

  .provider-icon {
    display: flex;
    color: #ffffff;
    flex-shrink: 0;
  }

  .provider-name {
    font-family: var(--font-body);
    font-size: 13.5px;
    font-weight: 500;
    color: #e8f6ff;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-badge {
    margin-left: auto;
    font-family: var(--font-hud);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #ffffff;
    border: 1px solid var(--hud-cyan);
    box-shadow: 0 0 10px rgba(125, 249, 255, 0.28);
    padding: 2px 7px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .config-section {
    padding: 14px 18px 18px;
    border-top: 1px solid var(--hud-line);
    display: grid;
    gap: 14px;
  }

  .config-title {
    font-family: var(--font-hud);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1.4px;
    color: var(--hud-cyan);
    margin: 0;
  }

  .form-group {
    display: grid;
    gap: 5px;
  }

  .form-group label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-hud);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--hud-steel);
  }

  .key-saved {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 400;
    letter-spacing: 0.4px;
    text-transform: none;
    color: var(--hud-steel);
  }
  .key-saved svg {
    color: #ffffff;
  }

  /* Underline inputs, exactly like the composer: no filled box, no radius */
  .form-group input,
  .form-group textarea {
    width: 100%;
    padding: 7px 2px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--hud-line-strong);
    border-radius: 0;
    color: #eaf7ff;
    font-family: var(--font-body);
    font-size: 14px;
    outline: none;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .form-group input:focus,
  .form-group textarea:focus {
    border-bottom-color: var(--hud-cyan);
    box-shadow: 0 10px 14px -14px rgba(125, 249, 255, 0.9);
  }

  .form-group input::placeholder,
  .form-group textarea::placeholder {
    color: rgba(110, 147, 180, 0.7);
  }

  .form-group textarea {
    resize: vertical;
    min-height: 76px;
    line-height: 1.5;
  }

  .field-hint {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.5px;
    color: var(--hud-steel);
  }

  .engine-hint {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.5px;
    color: var(--hud-steel);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Connection status: white mark + word, no colour coding ─────────── */
  .health-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--hud-line);
    background: transparent;
    flex-wrap: wrap;
  }

  .health-label {
    font-family: var(--font-hud);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--hud-steel);
  }

  .health-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1px solid var(--hud-line);
    color: #ffffff;
  }
  .health-mark[data-status='healthy'] {
    border-color: var(--hud-line-strong);
    box-shadow: 0 0 9px rgba(255, 255, 255, 0.4);
  }
  .health-mark[data-status='unhealthy'] {
    border-color: var(--hud-line-strong);
  }
  .health-mark[data-status='unknown'] {
    opacity: 0.5;
  }

  .health-word {
    font-family: var(--font-hud);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 1.6px;
    color: #ffffff;
  }

  .health-time {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.5px;
    color: var(--hud-steel);
  }

  /* Server-reported probe detail (HTTP 401, fetch failed, …) — same muted
  treatment as the timestamp, never a colour. */
  .health-error {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.5px;
    color: var(--hud-steel);
  }

  /* Bracket-end button: `[ … ]`, never a filled pill */
  .btn-bracket {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-hud);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--hud-cyan);
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 7px 14px;
    cursor: pointer;
    transition:
      color 0.2s ease,
      background 0.2s ease,
      box-shadow 0.2s ease;
  }
  .btn-bracket::before,
  .btn-bracket::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7px;
    border: 1px solid currentColor;
    opacity: 0.85;
    transition: opacity 0.2s ease;
  }
  .btn-bracket::before {
    left: 0;
    border-right: 0;
  }
  .btn-bracket::after {
    right: 0;
    border-left: 0;
  }
  .btn-bracket:hover:not(:disabled) {
    background: rgba(125, 249, 255, 0.1);
    box-shadow: 0 0 12px rgba(125, 249, 255, 0.3);
  }
  .btn-bracket:hover:not(:disabled)::before,
  .btn-bracket:hover:not(:disabled)::after {
    opacity: 1;
  }
  .btn-bracket.gold {
    color: var(--hud-gold);
  }
  .btn-bracket.gold:hover:not(:disabled) {
    background: rgba(255, 193, 77, 0.12);
    box-shadow: 0 0 12px rgba(255, 193, 77, 0.32);
  }

  .check-health-btn {
    margin-left: auto;
  }

  .save-btn {
    width: 100%;
  }

  .settings-modal::-webkit-scrollbar,
  .modal-scroll::-webkit-scrollbar {
    width: 5px;
  }
  .settings-modal::-webkit-scrollbar-track,
  .modal-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .settings-modal::-webkit-scrollbar-thumb,
  .modal-scroll::-webkit-scrollbar-thumb {
    background: rgba(125, 249, 255, 0.22);
    border-radius: 2px;
  }
</style>
