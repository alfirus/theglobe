<script lang="ts">
	import { pushEvent, recentEvents, subscribe, fmtTime, type GlobTag } from '$lib/events';

	/**
	 * Right-top GLOB LOG rail: a live feed of real app events — provider
	 * handshakes, request dispatch, stream progress, TTS, health probes,
	 * errors. Subscribes to the event bus; renders newest first; auto-scrolls
	 * only while pinned to the top (a manual scroll pauses follow, clicking
	 * the head resumes). Empty state names the truth: no events yet.
	 */
	let listEl: HTMLDivElement | undefined = $state(undefined);

	let events = $state(recentEvents());
	let pinned = $state(true);

	$effect(() => {
		const off = subscribe((e) => {
			events = [e, ...events].slice(0, 120);
			if (pinned && listEl) listEl.scrollTop = 0;
		});
		return off;
	});

	function onScroll() {
		if (!listEl) return;
		pinned = listEl.scrollTop <= 4;
	}

	function tagClass(tag: GlobTag): string {
		switch (tag) {
			case 'ERROR':
				return 'tag-err';
			case 'LINK':
			case 'HEALTH':
				return 'tag-link';
			case 'STREAM':
				return 'tag-stream';
			default:
				return '';
		}
	}

	// Exposed for tests / debugging: seed one entry without a real lifecycle event.
	export function seed(tag: GlobTag, msg: string) {
		pushEvent(tag, msg);
	}
</script>

<aside class="opslog" aria-label="Globe log">
	<button
		class="head"
		onclick={() => (pinned = true)}
		title={pinned ? 'Following live' : 'Resume live follow'}
	>
		<span class="live"><span class="pulse" class:paused={!pinned}></span>GLOB LOG</span>
		<span class="count">{events.length}</span>
	</button>

	<div class="feed" bind:this={listEl} onscroll={onScroll}>
		{#if events.length === 0}
			<div class="empty">
				<span class="empty-key">NO SIGNAL LOG</span>
				<span class="empty-text">No Globe events yet — send a message or check a connection.</span>
			</div>
		{/if}
		{#each events as e (e.id)}
			<div class="line">
				<span class="ts">{fmtTime(e.ts)}</span>
				<span class="tag {tagClass(e.tag)}">{e.tag}</span>
				<span class="msg">{e.msg}</span>
			</div>
		{/each}
	</div>
</aside>

<style>
	.opslog {
		position: fixed;
		top: 84px;
		right: 16px;
		width: min(340px, calc(100vw - 32px));
		max-height: min(300px, 32vh);
		z-index: 48;
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
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--hud-line);
		cursor: pointer;
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
	.pulse.paused {
		animation: none;
		opacity: 0.3;
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

	.count {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 1px;
	}

	.feed {
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px 12px;
		min-height: 0;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		text-align: center;
		padding: 12px 4px;
	}
	.empty-key {
		font-family: var(--font-hud);
		font-size: 10px;
		letter-spacing: 3px;
		color: var(--hud-cyan);
		opacity: 0.8;
	}
	.empty-text {
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--hud-steel);
	}

	.line {
		display: grid;
		grid-template-columns: 52px 52px 1fr;
		gap: 8px;
		align-items: baseline;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.5;
	}

	.ts {
		color: var(--hud-steel);
		opacity: 0.85;
		letter-spacing: 0.5px;
	}

	/* Tags are words, never colours — except the owner carve-out: LINK/HEALTH
	 * readouts may carry the link green, ERROR the stop red. */
	.tag {
		font-family: var(--font-hud);
		font-size: 8.5px;
		font-weight: 600;
		letter-spacing: 1.2px;
		color: var(--hud-steel);
	}
	.tag-link {
		color: var(--hud-green);
	}
	.tag-stream {
		color: var(--hud-cyan);
	}
	.tag-err {
		color: var(--hud-red);
	}

	.msg {
		color: #d7e9fb;
		word-break: break-word;
	}

	@media (max-width: 1180px) {
		.opslog {
			width: min(280px, calc(100vw - 32px));
		}
	}
	@media (max-width: 860px) {
		.opslog {
			display: none;
		}
	}
</style>
