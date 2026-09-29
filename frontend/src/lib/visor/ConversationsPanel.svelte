<script module lang="ts">
	/** Shape the panel needs from a conversation (kept lighter than the page type). */
	export type PanelConversation = {
		id: string;
		title: string;
		messageCount: number;
		updatedAt: number;
	};
</script>

<script lang="ts">
	/**
	 * Conversation management, edge-triggered from the left rail. Hairline
	 * outline only — it slides over the globe rather than pushing a panel
	 * into the layout, so the default view keeps zero filled surfaces.
	 */
	let {
		open = false,
		conversations = [],
		activeId = null,
		onclose = () => {},
		onselect = () => {},
		onnew = () => {},
		ondelete = () => {}
	}: {
		open?: boolean;
		conversations?: PanelConversation[];
		activeId?: string | null;
		onclose?: () => void;
		onselect?: (id: string) => void;
		onnew?: () => void;
		ondelete?: (id: string) => void;
	} = $props();

	function stamp(ts: number): string {
		const d = new Date(ts);
		const today = new Date();
		const sameDay = d.toDateString() === today.toDateString();
		return sameDay
			? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
			: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
	}
</script>

{#if open}
	<button class="scrim" aria-label="Close conversations" onclick={onclose}></button>

	<aside class="panel" aria-label="Conversations">
		<header class="head">
			<span class="title">CONVERSATIONS</span>
			<span class="count">{conversations.length}</span>
			<button class="close" onclick={onclose} title="Close (⌘1)" aria-label="Close conversations">
				<svg
					viewBox="0 0 24 24"
					width="12"
					height="12"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				>
					<path d="M6 6l12 12M18 6L6 18"></path>
				</svg>
			</button>
		</header>

		<button class="new" onclick={onnew}>
			<span class="new-mark" aria-hidden="true">
				<svg
					viewBox="0 0 24 24"
					width="13"
					height="13"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				>
					<path d="M12 5v14M5 12h14"></path>
				</svg>
			</span>
			New thread
		</button>

		<ul class="list">
			{#if conversations.length === 0}
				<li class="empty">No threads yet.</li>
			{/if}
			{#each conversations as conv (conv.id)}
				<li>
					<button class="row" class:active={conv.id === activeId} onclick={() => onselect(conv.id)}>
						<span class="row-main">
							<span class="row-title">{conv.title}</span>
							<span class="row-meta">
								{stamp(conv.updatedAt)} · {conv.messageCount} msg
							</span>
						</span>
					</button>
					<button
						class="del"
						title="Delete conversation"
						onclick={() => ondelete(conv.id)}
						aria-label="Delete {conv.title}"
					>
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
					</button>
				</li>
			{/each}
		</ul>
	</aside>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 65;
		background: rgba(5, 11, 26, 0.45);
		border: none;
		cursor: default;
	}

	.panel {
		position: fixed;
		left: 16px;
		top: 76px;
		bottom: 34px;
		width: 296px;
		z-index: 70;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: rgba(5, 11, 26, 0.82);
		border: 1px solid var(--hud-line-strong);
		border-radius: var(--r-lg);
		box-shadow: 0 0 30px rgba(125, 249, 255, 0.12);
		backdrop-filter: blur(10px);
		animation: slide-in 0.18s ease-out;
	}

	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateX(-10px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		border-bottom: 1px solid var(--hud-line);
		padding-bottom: 10px;
	}

	.title {
		font-family: var(--font-hud);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 2.4px;
		color: var(--hud-cyan);
	}

	.count {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--hud-steel);
		border: 1px solid var(--hud-line);
		border-radius: var(--r-full);
		padding: 1px 7px;
	}

	.close {
		margin-left: auto;
		background: transparent;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-sm);
		/* Close X is an icon → plain white */
		color: #ffffff;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
		width: 22px;
		height: 22px;
		padding: 0;
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			background 0.2s ease;
	}
	.close:hover {
		border-color: var(--hud-line-strong);
		background: rgba(125, 249, 255, 0.08);
	}

	.new {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		font-family: var(--font-hud);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 1.6px;
		text-transform: uppercase;
		color: var(--hud-gold);
		background: transparent;
		border: 1px dashed var(--hud-line-gold);
		border-radius: var(--r-md);
		padding: 8px;
		cursor: pointer;
		transition: background 0.2s ease;
	}
	.new:hover {
		background: rgba(255, 193, 77, 0.1);
	}

	.new-mark {
		display: flex;
		/* The plus is an icon → plain white (the label stays gold, per palette) */
		color: #ffffff;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
	}

	.list li {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.empty {
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--hud-steel);
		padding: 8px 2px;
	}

	.row {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		padding: 8px 10px;
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			background 0.2s ease;
	}
	.row:hover {
		border-color: var(--hud-line);
		background: rgba(125, 249, 255, 0.05);
	}
	.row.active {
		border-color: var(--hud-cyan);
		background: rgba(125, 249, 255, 0.08);
	}

	.row-main {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.row-title {
		font-family: var(--font-body);
		font-size: 13px;
		color: #e2f4ff;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row-meta {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--hud-steel);
	}

	.del {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		/* Delete X is an icon → plain white; the hover glow carries the danger */
		color: #ffffff;
		cursor: pointer;
		opacity: 0.6;
		transition:
			opacity 0.2s ease,
			border-color 0.2s ease;
	}
	.del:hover {
		border-color: rgba(255, 107, 107, 0.5);
		opacity: 1;
	}

	@media (max-width: 720px) {
		.panel {
			left: 8px;
			right: 8px;
			width: auto;
			top: 64px;
		}
	}
</style>
