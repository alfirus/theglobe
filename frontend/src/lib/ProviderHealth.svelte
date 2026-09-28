<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { logEvent, errorFields } from '$lib/log';

  export type HealthStatus = 'unknown' | 'healthy' | 'unhealthy' | 'checking';

  /**
   * `provider` is the uplink id on display — a provider id or, in agent mode,
   * an agent id. `mode` picks which field `/api/health` expects; the two are
   * validated by separate guards server-side.
   */
  let {
    provider,
    mode = 'provider'
  }: { provider: string; mode?: 'provider' | 'agent' } = $props();
  const dispatch = createEventDispatcher<{ recheck: void }>();

  let status = $state<HealthStatus>('unknown');
  let lastChecked = $state<number | null>(null);
  let responseTime = $state<number | null>(null);
  let error = $state<string>('');
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;

  const POLL_INTERVAL_MS = 60_000; // 60s per card spec

  async function checkHealth() {
    status = 'checking';
    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'agent' ? { agentId: provider } : { providerId: provider })
      });

      if (!res.ok) {
        status = 'unhealthy';
        error = `API returned ${res.status}`;
        logEvent('health', 'chip_probe_failed', { provider, status: res.status }, 'warn');
        return;
      }

      const data = await res.json();
      // The server returns { healthy, responseTime, error, checkedAt }
      if (data.healthy) {
        status = 'healthy';
        responseTime = data.responseTime ?? null;
        error = '';
      } else {
        status = 'unhealthy';
        error = data.error || `HTTP ${res.status}`;
        responseTime = null;
      }
      lastChecked = Date.now();

      logEvent('health', 'chip_probe_ok', { provider, healthy: status === 'healthy' }, 'debug');
    } catch (err) {
      status = 'unhealthy';
      error = err instanceof Error ? err.message : 'Probe failed';
      responseTime = null;
      lastChecked = Date.now();
      logEvent('health', 'chip_probe_error', errorFields(err), 'error');
    }

    // Dispatch recheck so the parent can propagate to other chips
    dispatch('recheck');
  }

  function startPolling() {
    stopPolling();
    pollingTimer = setTimeout(() => {
      void checkHealth();
      startPolling(); // chain: next poll after another interval
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollingTimer !== null) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
  }

  $effect(() => {
    // Initial check on mount + when provider changes
    void checkHealth();
    startPolling();
    return () => stopPolling();
  });

  function formatMs(ms: number): string {
    if (ms == null) return '';
    return `${ms}ms`;
  }

  function dotColor(): string {
    switch (status) {
      case 'healthy': return '#4ade80';
      case 'unhealthy': return '#ff6b6b';
      case 'checking': return '#fbbf24';
      default: return '#667799';
    }
  }

  function dotLabel(): string {
    switch (status) {
      case 'healthy': return `${provider} healthy`;
      case 'unhealthy': return `${provider} unhealthy — ${error}`;
      case 'checking': return `Checking ${provider}…`;
      default: return `${provider} status unknown`;
    }
  }

  function handleClick() {
    void checkHealth(); // manual re-check on click
  }
</script>

<div
  class="health-chip"
  onclick={handleClick}
  title={dotLabel()}
  role="status"
  aria-label={dotLabel()}
>
  <span class="dot" style="background-color: {dotColor()}" />
  <span class="label">{provider}</span>
  {#if responseTime != null && status === 'healthy'}
    <span class="ms">{formatMs(responseTime)}</span>
  {/if}
  {#if status === 'checking'}
    <span class="spinner" />
  {/if}
  {#if status === 'unhealthy' && error}
    <!-- The reason is on the chip itself — no Settings round-trip to find out why. -->
    <span class="why">{error}</span>
  {/if}
</div>

<style>
  .health-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(10, 15, 30, 0.7);
    border: 1px solid rgba(68, 136, 255, 0.2);
    border-radius: 12px;
    font-size: 12px;
    color: #c0d4ff;
    cursor: pointer;
    transition: all 0.2s ease;
    user-select: none;
    backdrop-filter: blur(8px);
  }

  .health-chip:hover {
    background: rgba(68, 136, 255, 0.15);
    border-color: rgba(68, 136, 255, 0.4);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .label {
    font-weight: 600;
    letter-spacing: 0.3px;
  }

  .ms {
    color: #4ade80;
    font-size: 11px;
    margin-left: 2px;
  }

  .why {
    max-width: min(44vw, 340px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #ff6b6b;
    font-size: 11px;
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(68, 136, 255, 0.3);
    border-top-color: #4488ff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
