<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export type Provider = 
    | 'hermes'
    | 'lmstudio'
    | 'opencode'
    | 'openrouter'
    | 'deepseek'
    | 'openclaw';

  interface ProviderConfig {
    id: Provider;
    name: string;
    icon: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }

  const dispatch = createEventDispatcher<{ change: Provider }>();

  let open = $state(false);
  let { initialProvider = 'hermes' }: { initialProvider?: Provider } = $props();
  let selectedProvider = $state<Provider>(initialProvider as Provider);

  // System prompt state
  let systemPrompt = $state('');

  // Provider health state. Must be $state: mutating a plain object in runes
  // mode never re-renders, so the badge/timestamp never moved (M11).
  let providerHealth = $state<Record<string, { status: 'unknown' | 'healthy' | 'unhealthy'; lastChecked?: number }>>({});

  interface StoredSettings {
    provider?: Provider;
    systemPrompt?: string;
    configs?: Record<string, Partial<ProviderConfig>>;
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

  /**
   * Single persistence path for this modal (H3/H4: settings actually persist).
   *
   * - localStorage gets `{ provider, systemPrompt, configs }` **without** API keys:
   *   key material may only live on the server (security review §2), and the local
   *   copy is what survives a reload, so nothing secret is ever written here.
   * - the same object is POSTed to `/api/settings` **with** the key, because the
   *   server is the source of truth for `resolveConfig()`. If the key field is
   *   empty the key is omitted, so editing the base URL later cannot wipe a key
   *   that is already stored server-side.
   * - a failed POST must never break the UI, hence the catch.
   *
   * @returns true when the server accepted the update.
   */
  async function persistSettings(): Promise<boolean> {
    const stored = readStoredSettings();
    const config = providers[selectedProvider];
    if (!config) return false;

    const serverConfig: Partial<ProviderConfig> = {
      baseUrl: config.baseUrl,
      model: config.model
    };
    if (config.apiKey) serverConfig.apiKey = config.apiKey;

    const nextConfigs: NonNullable<StoredSettings['configs']> = {
      ...(stored.configs || {}),
      [selectedProvider]: serverConfig
    };

    try {
      localStorage.setItem(
        'globe-settings',
        JSON.stringify({
          ...stored,
          provider: selectedProvider,
          systemPrompt,
          configs: stripKeys(nextConfigs)
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
          systemPrompt,
          configs: nextConfigs
        })
      });
      if (res.ok && config.apiKey) keySaved = true;
      return res.ok;
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

  // Restore saved provider/system prompt/configs (called once, after `providers` exists).
  function loadSavedSettings(): void {
    const saved = readStoredSettings();
    if (saved.provider && providers[saved.provider]) selectedProvider = saved.provider;
    if (typeof saved.systemPrompt === 'string') systemPrompt = saved.systemPrompt;

    let scrubbed = false;
    for (const [id, config] of Object.entries(saved.configs || {})) {
      const target = providers[id as Provider];
      if (!target || !config) continue;
      // baseUrl/model come back; apiKey never does — the field is write-only.
      if (typeof config.baseUrl === 'string') target.baseUrl = config.baseUrl;
      if (typeof config.model === 'string') target.model = config.model;
      if (config.apiKey) {
        scrubbed = true;
        delete config.apiKey;
      }
    }

    // Older builds wrote keys into localStorage — remove them on first load.
    if (scrubbed) {
      try {
        localStorage.setItem(
          'globe-settings',
          JSON.stringify({ ...saved, configs: stripKeys(saved.configs) })
        );
      } catch (err) {
        console.error('Failed to scrub stored API keys:', err);
      }
    }
  }

  async function checkProviderHealth(providerId: Provider) {
    const config = providers[providerId];
    if (!config.baseUrl) {
      providerHealth[providerId] = { status: 'unhealthy', lastChecked: Date.now() };
      return;
    }

    try {
      // Try common health endpoints
      const urls = [
        `${config.baseUrl}/health`,
        `${config.baseUrl}/v1/models`
      ];

      let healthy = false;
      for (const url of urls) {
        try {
          const response = await fetch(url, { 
            method: 'GET',
            headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
            signal: AbortSignal.timeout(3000)
          });
          if (response.ok || response.status === 200) {
            healthy = true;
            break;
          }
        } catch {}
      }

      providerHealth[providerId] = { 
        status: healthy ? 'healthy' : 'unhealthy', 
        lastChecked: Date.now() 
      };
    } catch {
      providerHealth[providerId] = { status: 'unhealthy', lastChecked: Date.now() };
    }
  }

  function getHealthBadge(status: string): string {
    switch (status) {
      case 'healthy': return '🟢';
      case 'unhealthy': return '🔴';
      default: return '⚪';
    }
  }

  /**
   * Provider card click (H2): this function did not exist, so every click threw
   * `ReferenceError: handleSelect is not defined` and provider switching was
   * impossible. Selecting a provider updates state, tells the parent (which sets
   * the `X-Provider` header), persists the choice and re-runs the health check.
   */
  function handleSelect(id: Provider) {
    selectedProvider = id;
    dispatch('change', id);
    void persistSettings();
    void refreshKeyStatus();
    void handleHealthCheck();
  }

  function toggle() {
    open = !open;
  }

  async function handleSystemPromptChange() {
    await persistSettings();
  }

  // Base URL / API key / model edits — was `onChange={…}`, which Svelte 5 compiles
  // to `addEventListener('Change')` and therefore never fired (H3).
  async function handleProviderFieldChange() {
    await persistSettings();
  }

  // Write-only API key field: the value is POSTed to the server and then dropped
  // from component state, so it can never be written to localStorage. What the
  // UI keeps is only the fact that a key exists ("✓ saved on server").
  async function handleApiKeyChange() {
    const savedToServer = await persistSettings();
    const config = providers[selectedProvider];
    if (savedToServer && config?.apiKey) {
      config.apiKey = '';
      keySaved = true;
    }
  }

  // The badge timestamp is `number | undefined`; wrapping the `new Date(...)` call
  // keeps svelte-check happy instead of asserting inside the template.
  function formatHealthTime(lastChecked?: number): string {
    return lastChecked ? new Date(lastChecked).toLocaleTimeString() : '';
  }

  async function handleHealthCheck() {
    if (selectedProvider && providers[selectedProvider]) {
      await checkProviderHealth(selectedProvider);
    }
  }

  // `$state` so `bind:value` edits are visible to sibling reads (health check,
  // the config header) instead of living only inside the input element.
  let providers = $state<Record<Provider, ProviderConfig>>({
    hermes: {
      id: 'hermes',
      name: 'Hermes Agent AI Platform',
      icon: '🤖',
      baseUrl: '',
      apiKey: '',
      model: 'hermes-agent'
    },
    lmstudio: {
      id: 'lmstudio',
      name: 'LM Studio (Local)',
      icon: '💻',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: ''
    },
    opencode: {
      id: 'opencode',
      name: 'OpenCode Zen and Go',
      icon: '🔮',
      baseUrl: 'http://localhost:8765/v1',
      apiKey: '',
      model: ''
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      icon: '🌐',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: ''
    },
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      icon: '🔵',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat'
    },
    openclaw: {
      id: 'openclaw',
      name: 'OpenClaw AI Platform',
      icon: '🦞',
      baseUrl: '',
      apiKey: '',
      model: ''
    }
  });

  // Restore whatever the owner configured last session (provider, prompt, configs).
  // Replaces the old `providerDefaults`/`activeProviders` pair: it was a shallow
  // copy that shared every nested config object, and `activeProviders` was never
  // read again (L11).
  loadSavedSettings();
  // Whether a key exists server-side (the value itself never leaves the server).
  void refreshKeyStatus();
</script>

<!-- Settings Button (bottom right) -->
<button class="settings-btn" onclick={toggle} title="Settings">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
</button>

<!-- Settings Modal -->
{#if open}
  <div class="backdrop" onclick={toggle}></div>
  <div class="settings-modal">
    <div class="modal-header">
      <h2>⚙️ LLM Provider Settings</h2>
      <button class="close-btn" onclick={toggle}>×</button>
    </div>

    <div class="provider-list">
      {#each Object.values(providers) as provider}
        <button
          class="provider-card {selectedProvider === provider.id ? 'active' : ''}"
          onclick={() => handleSelect(provider.id)}
        >
          <span class="provider-icon">{provider.icon}</span>
          <div class="provider-info">
            <span class="provider-name">{provider.name}</span>
            {#if selectedProvider === provider.id}
              <span class="selected-badge">✓ Active</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>

    <!-- Provider Configuration -->
    {#if providers[selectedProvider]}
      <div class="config-section">
        <h3>Configure: {providers[selectedProvider].name}</h3>
        
        <!-- Health Status -->
        <div class="health-status">
          <span class="health-label">Connection Status:</span>
          <span class="health-badge">{getHealthBadge(providerHealth[selectedProvider]?.status || 'unknown')}</span>
          {#if providerHealth[selectedProvider]?.lastChecked}
            <small>{formatHealthTime(providerHealth[selectedProvider]?.lastChecked)}</small>
          {/if}
          <button class="check-health-btn" onclick={handleHealthCheck}>
            Check Connection
          </button>
        </div>

        <div class="form-group">
          <label>Base URL</label>
          <input
            type="text"
            bind:value={providers[selectedProvider].baseUrl}
            placeholder="e.g., http://localhost:1234/v1"
            onchange={handleProviderFieldChange}
          />
        </div>

        <div class="form-group">
          <label>
            API Key (optional)
            {#if keySaved}<span class="key-saved">✓ saved on server</span>{/if}
          </label>
          <!-- Write-only: the value is POSTed to the server and never kept in the browser. -->
          <input
            type="password"
            bind:value={providers[selectedProvider].apiKey}
            placeholder={keySaved ? '•••••••• (stored on the server)' : 'sk-...'}
            onchange={handleApiKeyChange}
          />
        </div>

        <div class="form-group">
          <label>Model</label>
          <input
            type="text"
            bind:value={providers[selectedProvider].model}
            placeholder="e.g., qwen3.6-35b-a3b"
            onchange={handleProviderFieldChange}
          />
        </div>

        <!-- System Prompt -->
        <div class="form-group">
          <label>System Prompt (Optional)</label>
          <textarea 
            bind:value={systemPrompt}
            placeholder="e.g., You are a helpful AI assistant that speaks in a friendly and concise manner."
            rows="4"
            onchange={handleSystemPromptChange}
          ></textarea>
        </div>

        <button class="save-btn" onclick={toggle}>Save & Close</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .settings-btn {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(10, 15, 30, 0.8);
    border: 1px solid rgba(68, 136, 255, 0.3);
    color: #4488ff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
    transition: all 0.2s ease;
    backdrop-filter: blur(12px);
  }

  .settings-btn:hover {
    background: rgba(68, 136, 255, 0.3);
    border-color: rgba(68, 136, 255, 0.6);
    box-shadow: 0 0 20px rgba(68, 136, 255, 0.4);
    transform: rotate(90deg);
  }

  .backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.7);
    z-index: 95;
  }

  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(600px, 90vw);
    max-height: 80vh;
    background: rgba(10, 15, 30, 0.95);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 16px;
    z-index: 96;
    overflow-y: auto;
    backdrop-filter: blur(20px);
    box-shadow: 0 0 40px rgba(68, 136, 255, 0.2);
    animation: modalIn 0.2s ease-out;
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px;
    border-bottom: 1px solid rgba(68, 136, 255, 0.2);
  }

  .modal-header h2 {
    font-size: 18px;
    color: #e0e8ff;
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    color: #4488ff;
    font-size: 24px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .close-btn:hover {
    background: rgba(68, 136, 255, 0.2);
  }

  .provider-list {
    padding: 16px 20px;
    display: grid;
    gap: 8px;
  }

  .provider-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: rgba(68, 136, 255, 0.05);
    border: 1px solid rgba(68, 136, 255, 0.15);
    border-radius: 12px;
    color: #e0e8ff;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: left;
    width: 100%;
  }

  .provider-card:hover {
    background: rgba(68, 136, 255, 0.1);
    border-color: rgba(68, 136, 255, 0.4);
  }

  .provider-card.active {
    background: rgba(68, 136, 255, 0.2);
    border-color: #4488ff;
    box-shadow: 0 0 15px rgba(68, 136, 255, 0.3);
  }

  .provider-icon {
    font-size: 24px;
  }

  .provider-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .provider-name {
    font-weight: 600;
    color: #e0e8ff;
  }

  .selected-badge {
    font-size: 12px;
    color: #4ade80;
    font-weight: 500;
  }

  .config-section {
    padding: 20px;
    border-top: 1px solid rgba(68, 136, 255, 0.2);
  }

  .config-section h3 {
    font-size: 16px;
    color: #e0e8ff;
    margin-bottom: 16px;
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    font-size: 13px;
    color: #8899bb;
    margin-bottom: 6px;
    font-weight: 500;
  }

  .key-saved {
    margin-left: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #4ade80;
  }

  .form-group input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 8px;
    color: #e0e8ff;
    font-size: 14px;
    outline: none;
    transition: all 0.2s ease;
  }

  .form-group input:focus {
    border-color: #4488ff;
    box-shadow: 0 0 10px rgba(68, 136, 255, 0.3);
  }

  .form-group input::placeholder {
    color: rgba(136, 170, 255, 0.4);
  }

  .form-group textarea {
    width: 100%;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 8px;
    color: #e0e8ff;
    font-size: 14px;
    outline: none;
    transition: all 0.2s ease;
    resize: vertical;
    min-height: 80px;
    font-family: inherit;
  }

  .form-group textarea:focus {
    border-color: #4488ff;
    box-shadow: 0 0 10px rgba(68, 136, 255, 0.3);
  }

  .form-group textarea::placeholder {
    color: rgba(136, 170, 255, 0.4);
  }

  /* Health Status */
  .health-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(68, 136, 255, 0.05);
    border: 1px solid rgba(68, 136, 255, 0.15);
    border-radius: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .health-label {
    font-size: 13px;
    color: #8899bb;
    font-weight: 500;
  }

  .health-badge {
    font-size: 16px;
  }

  .health-status small {
    font-size: 11px;
    color: #667799;
  }

  .check-health-btn {
    margin-left: auto;
    padding: 6px 12px;
    background: rgba(68, 136, 255, 0.1);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 6px;
    color: #4488ff;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .check-health-btn:hover {
    background: rgba(68, 136, 255, 0.2);
    border-color: #4488ff;
  }

  .save-btn {
    width: 100%;
    padding: 12px;
    background: linear-gradient(135deg, #4488ff, #2266dd);
    border: none;
    border-radius: 10px;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .save-btn:hover {
    background: linear-gradient(135deg, #5599ff, #3377ee);
    box-shadow: 0 0 20px rgba(68, 136, 255, 0.4);
  }

  .settings-modal::-webkit-scrollbar {
    width: 6px;
  }

  .settings-modal::-webkit-scrollbar-track {
    background: transparent;
  }

  .settings-modal::-webkit-scrollbar-thumb {
    background: rgba(68, 136, 255, 0.3);
    border-radius: 3px;
  }
</style>
