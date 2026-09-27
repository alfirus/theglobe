<script lang="ts">
	import ChatBubble from '$lib/ChatBubble.svelte';
	import type { Message } from '$lib/ChatBubble.svelte';

	/**
	 * The transcript zone: four corner brackets + mid-edge ticks frame the
	 * conversation as a HUD target rather than a card. Turns split left
	 * (assistant, cyan glow) / right (user, gold header rule), and the live
	 * thinking/streaming row carries the Stop control.
	 */
	let {
		messages = [],
		isThinking = false,
		isStreaming = false,
		provider = 'hermes',
		jumpTick = 0,
		onStop = () => {}
	}: {
		messages?: Message[];
		isThinking?: boolean;
		isStreaming?: boolean;
		provider?: string;
		jumpTick?: number;
		onStop?: () => void;
	} = $props();

	let listEl: HTMLDivElement;

	function fmt(ts?: number): string {
		if (!ts) return '';
		return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
	}

	const range = $derived.by(() => {
		const stamped = messages.filter((m) => m.ts);
		if (stamped.length === 0) return 'AWAITING FIRST TRANSMISSION';
		const first = fmt(stamped[0].ts);
		const last = fmt(stamped[stamped.length - 1].ts);
		return first === last ? first : `${first} → ${last}`;
	});

	function scrollToBottom() {
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	}

	// Keep the newest turn in view: any message change (or explicit jump)
	// re-runs this effect; the frame delay lets layout settle first.
	$effect(() => {
		void jumpTick;
		const count = messages.length;
		const tail = count > 0 ? messages[count - 1].text : '';
		void tail;
		requestAnimationFrame(scrollToBottom);
	});
</script>

<section class="transcript" aria-label="Transcript">
	<span class="corner tl" aria-hidden="true"></span>
	<span class="corner tr" aria-hidden="true"></span>
	<span class="corner bl" aria-hidden="true"></span>
	<span class="corner br" aria-hidden="true"></span>
	<span class="tick top" aria-hidden="true"></span>
	<span class="tick bottom" aria-hidden="true"></span>
	<span class="tick left" aria-hidden="true"></span>
	<span class="tick right" aria-hidden="true"></span>

	<header class="zone-head">
		<span class="live"><span class="pulse"></span>TRANSCRIPT · LIVE</span>
		<span class="range">{range}</span>
	</header>

	<div class="turns" bind:this={listEl}>
		{#if messages.length === 0 && !isThinking}
			<div class="empty">
				<span class="empty-key">RETICLE LOCK</span>
				<span class="empty-text">Awaiting first transmission — speak or type below.</span>
			</div>
		{/if}

		{#each messages as msg, i (msg.id ?? i)}
			<article class="turn {msg.role}">
				<div class="turn-head">
					<span class="role">{msg.role === 'user' ? 'YOU' : 'THE GLOBE'}</span>
					<span class="ts">{fmt(msg.ts)}</span>
				</div>
				<div class="rule"></div>
				<div class="body">
					<ChatBubble message={msg} />
				</div>
			</article>
		{/each}

		{#if isThinking || isStreaming}
			<div class="status-row" role="status">
				<span class="status-left">
					<span class="status-dot" class:streaming={isStreaming}></span>
					<span class="status-label">{isStreaming ? 'SPEAKING' : 'THINKING'}</span>
					<span class="status-sub">
						{isStreaming ? `streaming from ${provider}` : `connecting to ${provider}`}
					</span>
				</span>
				<button class="stop" onclick={onStop} title="Stop generating">
					<span class="stop-glyph" aria-hidden="true"></span>
					Stop
				</button>
			</div>
		{/if}
	</div>
</section>

<style>
	.transcript {
		position: fixed;
		top: 84px;
		bottom: 218px;
		left: 50%;
		transform: translateX(-50%);
		width: min(760px, calc(100vw - 320px));
		z-index: 30;
		display: flex;
		flex-direction: column;
		/* Soft radial scrim, never a plate: text reads without a box */
		background: radial-gradient(
			ellipse at center,
			rgba(5, 11, 26, 0.72) 0%,
			rgba(5, 11, 26, 0.5) 55%,
			rgba(5, 11, 26, 0) 100%
		);
	}

	/* Corner-bracket reticle */
	.corner {
		position: absolute;
		width: 26px;
		height: 26px;
		border: 1.5px solid var(--hud-cyan);
		box-shadow: 0 0 10px rgba(125, 249, 255, 0.45);
		opacity: 0.9;
	}
	.corner.tl {
		top: 0;
		left: 0;
		border-right: 0;
		border-bottom: 0;
	}
	.corner.tr {
		top: 0;
		right: 0;
		border-left: 0;
		border-bottom: 0;
	}
	.corner.bl {
		bottom: 0;
		left: 0;
		border-right: 0;
		border-top: 0;
	}
	.corner.br {
		bottom: 0;
		right: 0;
		border-left: 0;
		border-top: 0;
	}

	/* Mid-edge ticks */
	.tick {
		position: absolute;
		background: var(--hud-line-strong);
	}
	.tick.top,
	.tick.bottom {
		left: 50%;
		transform: translateX(-50%);
		width: 18px;
		height: 1.5px;
	}
	.tick.top {
		top: 0;
	}
	.tick.bottom {
		bottom: 0;
	}
	.tick.left,
	.tick.right {
		top: 50%;
		transform: translateY(-50%);
		width: 1.5px;
		height: 18px;
	}
	.tick.left {
		left: 0;
	}
	.tick.right {
		right: 0;
	}

	.zone-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 34px 8px;
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

	/* Live-state dots stay coloured only on the LISTENING/THINKING/SPEAKING
	 * chips (owner carve-out). Everywhere else — including this pulse — the dot
	 * is an icon and is plain white. */
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 0 8px rgba(255, 255, 255, 0.9);
		animation: live 2s ease-in-out infinite;
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

	.range {
		font-family: var(--font-mono);
		letter-spacing: 1px;
		font-size: 9.5px;
	}

	.turns {
		flex: 1;
		overflow-y: auto;
		padding: 8px 34px 16px;
		display: flex;
		flex-direction: column;
		gap: 18px;
		scroll-behavior: smooth;
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
		font-size: 13px;
		color: var(--hud-steel);
	}

	.turn {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.turn.user {
		align-items: flex-end;
	}
	.turn.assistant {
		align-items: flex-start;
	}

	.turn-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		font-family: var(--font-hud);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 1.8px;
	}

	.turn.user .turn-head {
		flex-direction: row-reverse;
	}

	.role {
		color: var(--hud-gold);
	}
	.turn.assistant .role {
		color: var(--hud-cyan);
	}

	.ts {
		font-family: var(--font-mono);
		font-weight: 400;
		letter-spacing: 1px;
		color: var(--hud-steel);
		opacity: 0.85;
	}

	/* Colour-coded header rules */
	.rule {
		width: 100%;
		height: 1px;
		background: linear-gradient(to right, var(--hud-line-gold), transparent);
	}
	.turn.assistant .rule {
		background: linear-gradient(to right, var(--hud-line-strong), transparent);
	}
	.turn.user .rule {
		background: linear-gradient(to left, var(--hud-line-gold), transparent);
	}

	.body {
		max-width: 100%;
	}

	/* ── ChatBubble restyled for the HUD (specificity beats its own scope) ── */
	.turn .body :global(.message) {
		padding: 0;
		border-bottom: none;
		gap: 0;
	}
	.turn .body :global(.role) {
		display: none;
	}
	.turn .body :global(.text) {
		font-family: var(--font-body);
		font-size: 15px;
		line-height: 1.65;
		color: #dff3ff;
	}
	.turn.assistant .body :global(.text) {
		font-size: 19px;
		line-height: 1.6;
		color: #ecfdff;
		text-shadow:
			0 0 14px rgba(125, 249, 255, 0.45),
			0 0 34px rgba(125, 249, 255, 0.2);
	}
	.turn.user .body :global(.text) {
		text-align: right;
		color: #d7e9fb;
	}
	.turn .body :global(.markdown-content p) {
		margin: 6px 0;
	}
	.turn .body :global(code) {
		background: rgba(125, 249, 255, 0.08);
		border: 1px solid var(--hud-line);
		border-radius: var(--r-sm);
		padding: 1px 6px;
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--hud-cyan);
	}
	.turn .body :global(pre) {
		background: rgba(5, 11, 26, 0.7);
		border: 1px solid var(--hud-line);
		border-radius: var(--r-md);
	}
	.turn .body :global(a) {
		color: var(--hud-cyan);
	}
	.turn .body :global(strong) {
		color: var(--hud-gold);
	}

	/* Live thinking / streaming row */
	.status-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding-top: 4px;
		border-top: 1px solid var(--hud-line);
	}

	.status-left {
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		/* Thinking/streaming indicator → plain white; the label carries the state */
		background: #ffffff;
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.9);
		animation: live 1s ease-in-out infinite;
	}
	.status-dot.streaming {
		background: #ffffff;
		box-shadow: 0 0 10px rgba(255, 255, 255, 0.9);
	}

	.status-label {
		font-family: var(--font-hud);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 2px;
		color: var(--hud-cyan);
	}

	.status-sub {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--hud-steel);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stop {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-hud);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 1.4px;
		color: var(--hud-red);
		background: transparent;
		border: 1px solid rgba(255, 107, 107, 0.5);
		border-radius: var(--r-md);
		padding: 4px 10px;
		cursor: pointer;
		transition:
			background 0.2s ease,
			box-shadow 0.2s ease;
		flex-shrink: 0;
	}
	.stop:hover {
		background: rgba(255, 107, 107, 0.15);
		box-shadow: 0 0 12px rgba(255, 107, 107, 0.35);
	}
	.stop-glyph {
		width: 8px;
		height: 8px;
		/* Stop glyph is an icon → plain white; the red border/text stay the signal */
		background: #ffffff;
	}

	@media (max-width: 980px) {
		.transcript {
			width: calc(100vw - 120px);
			bottom: 168px;
		}
	}
	@media (max-width: 720px) {
		.transcript {
			top: 66px;
			width: calc(100vw - 32px);
			left: 16px;
			transform: none;
		}
		.turns {
			padding: 8px 20px 16px;
		}
		.zone-head {
			padding: 0 20px 8px;
		}
		.turn.assistant .body :global(.text) {
			font-size: 17px;
		}
	}
</style>
