<script module lang="ts">
	/** Telemetry the WebGL globe pushes up every second. */
	export type GlobeTelemetry = {
		nodes: number;
		edges: number;
		bloom: number;
		fps: number;
		jitter: number;
	};
</script>

<script lang="ts">
	import { pushEvent } from '$lib/events';

	/**
	 * Right telemetry rail. Every number here is measured, not decorative:
	 * node/edge/bloom/fps/jitter come from the WebGL globe's own telemetry
	 * callback, latency is a round-trip to /api/health, and PROJECTION is the
	 * live viewport size.
	 */
	let {
		telemetry = null,
		hudState = 'listening',
		provider = 'hermes'
	}: {
		telemetry?: GlobeTelemetry | null;
		hudState?: 'listening' | 'thinking' | 'speaking';
		provider?: string;
	} = $props();

	let latencyMs = $state<number | null>(null);
	let viewport = $state({ w: 0, h: 0 });

	// LATENCY = measured round-trip of POST /api/health for the active provider
	// (the endpoint probes the provider server-side, so this is a real number).
	$effect(() => {
		const currentProvider = provider;
		const measureViewport = () => {
			viewport = { w: window.innerWidth, h: window.innerHeight };
		};
		measureViewport();

		let cancelled = false;
		async function probe() {
			// No provider yet (settings still hydrating) — probing the default id
			// would ask the server to hit a base URL that does not exist.
			if (!currentProvider) {
				latencyMs = null;
				return;
			}
			const started = performance.now();
			try {
				// Agent uplink ids (`*-agent`) probe the agent namespace; everything
				// else probes providers. The server answers both shapes.
				const probeBody = currentProvider.endsWith('-agent')
					? { agentId: currentProvider }
					: { providerId: currentProvider };
				const res = await fetch('/api/health', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(probeBody),
					cache: 'no-store'
				});
				if (cancelled) return;
				if (res.ok) {
					latencyMs = Math.round(performance.now() - started);
					try {
						const data: unknown = await res.json();
						const healthy =
							!!data &&
							typeof data === 'object' &&
							(data as { healthy?: unknown }).healthy === true;
						const err =
							!!data && typeof data === 'object'
								? String((data as { error?: unknown }).error ?? '')
								: '';
						if (!healthy && err) pushEvent('HEALTH', `${currentProvider}: ${err}`);
					} catch {
						/* latency still counts; the detail was unreadable */
					}
				}
			} catch {
				if (!cancelled) latencyMs = null;
			}
		}

		void probe();
		const poll = setInterval(probe, 5000);
		window.addEventListener('resize', measureViewport);

		return () => {
			cancelled = true;
			clearInterval(poll);
			window.removeEventListener('resize', measureViewport);
		};
	});

	const rows = $derived([
		{ key: 'BLOOM', value: telemetry ? telemetry.bloom.toFixed(2) : '—' },
		{ key: 'JITTER', value: telemetry ? `${telemetry.jitter.toFixed(1)} ms` : '—' },
		{ key: 'FPS', value: telemetry ? `${Math.round(telemetry.fps)}` : '—' },
		{ key: 'EDGES', value: telemetry ? telemetry.edges.toLocaleString('en-US') : '—' },
		{ key: 'NODES', value: telemetry ? `${telemetry.nodes}` : '—' },
		{ key: 'PROJECTION', value: `NEURAL · ${viewport.w}×${viewport.h}` },
		{ key: 'LATENCY', value: latencyMs === null ? '—' : `${latencyMs} ms` }
	]);
</script>

<aside class="telemetry" aria-label="Telemetry">
	<span class="caption" aria-hidden="true">TELEMETRY</span>

	<div class="rows">
		{#each rows as row (row.key)}
			<div class="row">
				<span class="key">{row.key}</span>
				<span class="value" class:hi={row.key === 'LATENCY' && latencyMs !== null}>
					{row.value}
				</span>
			</div>
		{/each}
		<div class="row">
			<span class="key">STATE</span>
			<span class="value state">{hudState.toUpperCase()}</span>
		</div>
	</div>

	<div class="ticks" aria-hidden="true"></div>
</aside>

<style>
	.telemetry {
		position: fixed;
		right: 16px;
		top: 50%;
		transform: translateY(-50%);
		z-index: 50;
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 7px;
		text-align: right;
	}

	.row {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 10px;
	}

	.key {
		font-family: var(--font-hud);
		font-size: 8.5px;
		font-weight: 600;
		letter-spacing: 1.4px;
		color: var(--hud-steel);
		opacity: 0.85;
	}

	.value {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--hud-cyan);
		min-width: 96px;
		text-align: right;
		text-shadow: 0 0 8px rgba(125, 249, 255, 0.35);
	}

	.value.hi {
		color: var(--hud-gold);
		text-shadow: 0 0 8px rgba(255, 193, 77, 0.35);
	}

	.value.state {
		color: #baf5ff;
	}

	.caption {
		writing-mode: vertical-rl;
		font-family: var(--font-hud);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 3px;
		color: var(--hud-steel);
		text-transform: uppercase;
		opacity: 0.85;
	}

	/* Far-edge ruler ticks, matching the frame treatment */
	.ticks {
		width: 7px;
		align-self: stretch;
		background-image: repeating-linear-gradient(
			to bottom,
			var(--hud-line-strong) 0 1px,
			transparent 1px 24px
		);
		opacity: 0.6;
	}

	@media (max-width: 1180px) {
		.value {
			min-width: 74px;
		}
	}
	@media (max-width: 860px) {
		.telemetry {
			display: none;
		}
	}
</style>
