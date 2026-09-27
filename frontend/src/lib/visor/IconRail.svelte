<script lang="ts">
	/**
	 * Left icon rail: every secondary surface collapses to this edge —
	 * conversation list, new thread, focus the composer, jump to the live
	 * transcript — plus the vertical CONVERSATIONS caption.
	 */
	let {
		count = 0,
		active = false,
		onToggleConversations = () => {},
		onNew = () => {},
		onFocusComposer = () => {},
		onFocusTranscript = () => {}
	}: {
		count?: number;
		active?: boolean;
		onToggleConversations?: () => void;
		onNew?: () => void;
		onFocusComposer?: () => void;
		onFocusTranscript?: () => void;
	} = $props();
</script>

<nav class="rail" aria-label="Conversation tools">
	<div class="buttons">
		<button
			class="rail-btn"
			class:active
			onclick={onToggleConversations}
			title="Conversations (⌘1)"
			aria-pressed={active}
		>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<circle cx="12" cy="12" r="7"></circle>
				<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"></circle>
			</svg>
		</button>

		<button class="rail-btn" onclick={onNew} title="New conversation">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<path d="M12 5v14M5 12h14"></path>
			</svg>
		</button>

		<button class="rail-btn" onclick={onFocusComposer} title="Focus composer">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"></path>
			</svg>
		</button>

		<button class="rail-btn" onclick={onFocusTranscript} title="Jump to latest">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<path d="M5 7h14M5 12h14M5 17h9"></path>
			</svg>
		</button>
	</div>

	<span class="shortcut">⌘1</span>

	<span class="caption" aria-hidden="true">CONVERSATIONS · {count}</span>
</nav>

<style>
	.rail {
		position: fixed;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		z-index: 50;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.buttons {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.rail-btn {
		width: 34px;
		height: 34px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-md);
		color: var(--hud-cyan);
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			box-shadow 0.2s ease,
			background 0.2s ease;
	}

	.rail-btn:hover {
		border-color: var(--hud-line-strong);
		box-shadow: 0 0 10px rgba(125, 249, 255, 0.3);
		background: rgba(125, 249, 255, 0.07);
	}

	.rail-btn.active {
		border-color: var(--hud-cyan);
		box-shadow: 0 0 12px rgba(125, 249, 255, 0.45);
	}

	.shortcut {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--hud-steel);
		letter-spacing: 1px;
	}

	/* Vertical caption running up the left edge, as in the mockup */
	.caption {
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		font-family: var(--font-hud);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 3px;
		color: var(--hud-steel);
		text-transform: uppercase;
		margin-top: 4px;
		opacity: 0.85;
	}

	@media (max-width: 720px) {
		.rail {
			left: 10px;
		}
		.caption {
			display: none;
		}
	}
</style>
