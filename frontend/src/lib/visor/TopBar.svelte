<script module lang="ts">
	/** The three agent states the top-bar chips mirror. */
	export type HudState = 'listening' | 'thinking' | 'speaking';
</script>

<script lang="ts">
	/**
	 * Top status bar: identity chip, live CPU/RAM/LINK readouts, the three
	 * state chips (LISTENING / THINKING / SPEAKING) wired to the real app
	 * state, and the Settings entry.
	 */
	let {
		hudState = 'listening',
		provider = 'hermes',
		onSettings = () => {}
	}: {
		hudState?: HudState;
		provider?: string;
		onSettings?: () => void;
	} = $props();

	type Stats = {
		cpu: number;
		ram: { percent: number; used: string; total: string };
		gpu?: { percent: number; mem: string; total: string };
		uptime?: string;
	};

	let stats = $state<Stats>({ cpu: 0, ram: { percent: 0, used: '0', total: '0' } });
	let sweepSeconds = $state(0);

	$effect(() => {
		let cancelled = false;

		async function fetchStats() {
			try {
				const res = await fetch('/api/stats');
				if (!cancelled && res.ok) stats = (await res.json()) as Stats;
			} catch {
				/* the bar simply holds its last value */
			}
		}

		void fetchStats();
		const poll = setInterval(fetchStats, 3000);
		const tick = setInterval(() => {
			sweepSeconds = (sweepSeconds + 1) % 600;
		}, 1000);

		return () => {
			cancelled = true;
			clearInterval(poll);
			clearInterval(tick);
		};
	});

	const chips: { id: HudState; label: string }[] = [
		{ id: 'listening', label: 'Listening' },
		{ id: 'thinking', label: 'Thinking' },
		{ id: 'speaking', label: 'Speaking' }
	];
</script>

<header class="topbar">
	<div class="identity">
		<span class="mark" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="22" height="22">
				<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1" />
				<circle cx="12" cy="12" r="3" fill="currentColor" />
			</svg>
		</span>
		<span class="wordmark">THE GLOB</span>
		<span class="direction">VISOR · HUD</span>
	</div>

	<div class="center">
		<div class="metrics">
			<div class="metric">
				<span class="key">CPU</span>
				<span class="bar"><span class="fill cpu" style="width: {stats.cpu}%"></span></span>
				<span class="val">{Math.round(stats.cpu)}%</span>
			</div>
			<div class="metric">
				<span class="key">RAM</span>
				<span class="bar"><span class="fill ram" style="width: {stats.ram.percent}%"></span></span>
				<span class="val">{stats.ram.used}/{stats.ram.total} GB</span>
			</div>
			<div class="metric link">
				<span class="key">LINK</span>
				<span class="value-link">
					<span class="dot"></span>
					{provider}
				</span>
			</div>
		</div>

		<div class="chips" role="group" aria-label="Agent state">
			{#each chips as chip (chip.id)}
				<span class="chip" class:active={hudState === chip.id} data-state={chip.id}>
					<span class="chip-dot"></span>
					{chip.label.toUpperCase()}
				</span>
			{/each}
		</div>

		<span class="sweep">CLUSTER 07 SWEEP {(sweepSeconds / 10).toFixed(1)}S</span>
	</div>

	<button class="settings" onclick={onSettings} title="Settings">
		<span class="gear" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6">
				<circle cx="12" cy="12" r="3"></circle>
				<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"></path>
			</svg>
		</span>
		SETTINGS
		<span class="glyph" aria-hidden="true">⌘,</span>
	</button>
</header>

<style>
	.topbar {
		position: fixed;
		top: 16px;
		left: 16px;
		right: 16px;
		height: 48px;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 0 16px;
		border-bottom: 1px solid var(--hud-line);
		background: linear-gradient(to bottom, rgba(5, 11, 26, 0.75), rgba(5, 11, 26, 0));
		font-family: var(--font-hud);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.mark {
		color: var(--hud-cyan);
		display: flex;
		filter: drop-shadow(0 0 4px rgba(125, 249, 255, 0.6));
	}

	.wordmark {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 3px;
		color: #eafcff;
	}

	.direction {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 1.6px;
		color: var(--hud-gold);
		border: 1px solid var(--hud-line-gold);
		border-radius: var(--r-full);
		padding: 2px 8px;
		white-space: nowrap;
	}

	.center {
		display: flex;
		align-items: center;
		gap: 16px;
		min-width: 0;
	}

	.metrics {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.metric {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.key {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 1.4px;
		color: var(--hud-cyan);
		opacity: 0.75;
	}

	.bar {
		width: 64px;
		height: 4px;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-full);
		overflow: hidden;
		display: inline-block;
	}

	.fill {
		display: block;
		height: 100%;
		transition: width 0.5s ease;
	}
	.fill.cpu {
		background: var(--hud-cyan);
		box-shadow: 0 0 6px rgba(125, 249, 255, 0.7);
	}
	.fill.ram {
		background: var(--hud-gold);
		box-shadow: 0 0 6px rgba(255, 193, 77, 0.6);
	}

	.val {
		font-family: var(--font-mono);
		font-size: 10px;
		color: #d6f6ff;
		min-width: 52px;
	}

	.value-link {
		display: flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--hud-green);
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--hud-green);
		box-shadow: 0 0 6px var(--hud-green);
	}

	.chips {
		display: flex;
		gap: 4px;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-full);
		padding: 3px;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 1.2px;
		color: var(--hud-steel);
		padding: 3px 9px;
		border-radius: var(--r-full);
		transition:
			background 0.35s ease,
			color 0.35s ease,
			box-shadow 0.35s ease;
		white-space: nowrap;
	}

	.chip-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: currentColor;
		opacity: 0.5;
	}

	.chip.active {
		color: #04121b;
		background: var(--hud-cyan);
		box-shadow: 0 0 12px rgba(125, 249, 255, 0.55);
	}
	.chip.active .chip-dot {
		opacity: 1;
		animation: blink 1.4s ease-in-out infinite;
	}
	.chip.active[data-state='thinking'] {
		background: var(--hud-gold);
		box-shadow: 0 0 12px rgba(255, 193, 77, 0.55);
	}
	.chip.active[data-state='speaking'] {
		background: #baf5ff;
	}

	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.25;
		}
	}

	.sweep {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 1px;
		color: var(--hud-steel);
		white-space: nowrap;
	}

	.settings {
		display: flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-hud);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 1.4px;
		color: var(--hud-gold);
		background: transparent;
		border: 1px solid var(--hud-line-gold);
		border-radius: var(--r-full);
		padding: 5px 10px;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.2s ease,
			box-shadow 0.2s ease;
	}

	.settings:hover {
		background: rgba(255, 193, 77, 0.12);
		box-shadow: 0 0 12px rgba(255, 193, 77, 0.35);
	}

	.gear {
		display: flex;
	}

	.glyph {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--hud-steel);
		border-left: 1px solid var(--hud-line-gold);
		padding-left: 7px;
	}

	@media (max-width: 1180px) {
		.sweep {
			display: none;
		}
	}
	@media (max-width: 1020px) {
		.metrics {
			display: none;
		}
	}
	@media (max-width: 720px) {
		.topbar {
			top: 8px;
			left: 8px;
			right: 8px;
			padding: 0 8px;
		}
		.direction,
		.glyph {
			display: none;
		}
		.chip {
			padding: 3px 6px;
			font-size: 8px;
		}
	}
</style>
