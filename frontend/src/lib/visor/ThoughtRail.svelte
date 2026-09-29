<script lang="ts">
	/**
	 * Left THOUGHT rail: renders what the AI is doing while a request is
	 * in flight. One step per lifecycle stage — dispatch, wait, stream,
	 * speak — with a live phase line while thinking and a token-rate tick
	 * while streaming. Idle text names the truth (brain state = standby).
	 *
	 * Stages and tick counts arrive as props pushed from the page's chat
	 * lifecycle; this component renders and animates, never fetches.
	 */
	export type ThoughtStatus = 'pending' | 'active' | 'done' | 'failed';

	export interface ThoughtStep {
		id: string;
		label: string;
		detail: string;
		status: ThoughtStatus;
	}

	let {
		steps = [],
		phase = '',
		streaming = false,
		tokens = 0,
		elapsedMs = 0,
		thinking = ''
	}: {
		steps?: ThoughtStep[];
		phase?: string;
		streaming?: boolean;
		tokens?: number;
		elapsedMs?: number;
		/** Raw reasoning streamed by the provider (`reasoning_content` on MiMo/DeepSeek). */
		thinking?: string;
	} = $props();

	/** Bounded tail of the reasoning — keeps per-frame DOM work cheap while the
		scroller holds the recent history. */
	const THINKING_TAIL = 4000;
	const thinkingTail = $derived(
		thinking.length > THINKING_TAIL ? `…${thinking.slice(-THINKING_TAIL)}` : thinking
	);

	let thinkingEl: HTMLElement | null = $state(null);

	// Live reasoning is append-only: stick to the bottom as chunks arrive, so
	// the newest thought is visible without touching the scrollbar.
	$effect(() => {
		const latest = thinkingTail;
		if (thinkingEl && latest.length > 0) thinkingEl.scrollTop = thinkingEl.scrollHeight;
	});

	const rate = $derived(() => {
		if (!streaming || elapsedMs <= 0) return '';
		const t = tokens / (elapsedMs / 1000);
		return Number.isFinite(t) ? `${t.toFixed(1)} tok/s` : '';
	});
</script>

<aside class="thought" aria-label="AI thinking">
	<header class="head">
		<span class="live"><span class="pulse" class:idle={steps.length === 0}></span>THOUGHT</span>
		{#if rate()}
			<span class="rate">{rate()}</span>
		{/if}
	</header>

	<div class="body">
		{#if steps.length === 0}
			<div class="empty">
				<span class="empty-key">STANDBY</span>
				<span class="empty-text">Brain idle — send a message to watch the Globe think.</span>
			</div>
		{/if}

		{#each steps as s (s.id)}
			<div class="step" data-status={s.status}>
				<span class="mark" aria-hidden="true">
					{#if s.status === 'active'}
						<span class="spin"></span>
					{:else if s.status === 'done'}
						<svg
							viewBox="0 0 24 24"
							width="11"
							height="11"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
						>
							<path d="M5 12.5l4.5 4.5L19 7.5"></path>
						</svg>
					{:else if s.status === 'failed'}
						<svg
							viewBox="0 0 24 24"
							width="11"
							height="11"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
						>
							<path d="M6 6l12 12M18 6L6 18"></path>
						</svg>
					{:else}
						<span class="dot"></span>
					{/if}
				</span>
				<span class="texts">
					<span class="label">{s.label}</span>
					<span class="detail">{s.detail}</span>
				</span>
			</div>
		{/each}

		{#if phase}
			<div class="phase" role="status">
				<span class="phase-dot"></span>
				<span class="phase-text">{phase}</span>
			</div>
		{/if}

		{#if thinking}
			<div class="thinking" aria-label="Model reasoning">
				<span class="thinking-key">THINKING</span>
				<span class="thinking-text" bind:this={thinkingEl}>{thinkingTail}</span>
			</div>
		{/if}
	</div>
</aside>

<style>
	.thought {
		position: fixed;
		left: 60px;
		top: 84px;
		bottom: 218px;
		width: min(300px, calc((100vw - 320px - 760px) / 2));
		min-width: 220px;
		z-index: 30;
		display: flex;
		flex-direction: column;
		background: radial-gradient(
			ellipse at center,
			rgba(5, 11, 26, 0.72) 0%,
			rgba(5, 11, 26, 0.5) 55%,
			rgba(5, 11, 26, 0) 100%
		);
		border: 1px solid var(--hud-line);
		border-radius: var(--r-md);
		overflow: hidden;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--hud-line);
		font-family: var(--font-hud);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 2px;
		color: var(--hud-steel);
		text-transform: uppercase;
	}

	.live {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--hud-cyan);
	}

	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 0 8px rgba(255, 255, 255, 0.9);
		animation: live 2s ease-in-out infinite;
	}
	.pulse.idle {
		animation: none;
		opacity: 0.35;
		box-shadow: none;
	}

	@keyframes live {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.25;
		}
	}

	.rate {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.5px;
	}

	.body {
		flex: 1;
		/* The THINKING scroller owns scrolling — the body never scrolls, so
		   the thinking block stretches to the card bottom instead of pushing
		   the card into a whole-body scroll. */
		overflow: hidden;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px;
		min-height: 0;
	}

	.empty {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		text-align: center;
	}
	.empty-key {
		font-family: var(--font-hud);
		font-size: 11px;
		letter-spacing: 3px;
		color: var(--hud-cyan);
		opacity: 0.8;
	}
	.empty-text {
		font-family: var(--font-body);
		font-size: 12px;
		line-height: 1.5;
		color: var(--hud-steel);
	}

	.step {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		flex-shrink: 0;
	}

	.mark {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #ffffff;
		margin-top: 1px;
	}

	.step[data-status='done'] .mark {
		color: var(--hud-green);
	}
	.step[data-status='failed'] .mark {
		color: var(--hud-red);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		border: 1px solid var(--hud-steel);
		opacity: 0.6;
	}

	.spin {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid rgba(255, 255, 255, 0.25);
		border-top-color: #ffffff;
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.texts {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.label {
		font-family: var(--font-hud);
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 1.6px;
		color: #e2f4ff;
		text-transform: uppercase;
	}

	.step[data-status='active'] .label {
		color: var(--hud-cyan);
	}

	.detail {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.5;
		color: var(--hud-steel);
		word-break: break-word;
	}

	.phase {
		display: flex;
		align-items: center;
		gap: 9px;
		padding-top: 8px;
		border-top: 1px solid var(--hud-line);
		flex-shrink: 0;
	}

	.phase-dot {
		width: 7px;
		height: 7px;
		flex-shrink: 0;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.9);
		animation: live 1s ease-in-out infinite;
	}

	.phase-text {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--hud-steel);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Reasoning streamed by the provider — after the steps, same HUD voice:
	     label + mono tail, scrollable, never a filled box. `flex: 1` stretches
	     it to the card bottom; the text scroller takes whatever is left. */
	.thinking {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--hud-line);
		flex: 1;
		min-height: 120px;
	}

	.thinking-key {
		font-family: var(--font-hud);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 2px;
		color: var(--hud-cyan);
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.thinking-text {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.55;
		color: var(--hud-steel);
		white-space: pre-wrap;
		word-break: break-word;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	@media (max-width: 1180px) {
		.thought {
			left: 56px;
			min-width: 0;
			width: 220px;
		}
	}
	@media (max-width: 980px) {
		.thought {
			display: none;
		}
	}
</style>
