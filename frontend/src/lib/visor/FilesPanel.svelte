<script lang="ts">
	/**
	 * Desktop-file bridge panel (ADR-0002 Phase 1b), edge-triggered from the
	 * left rail like ConversationsPanel. Lists the viewable files in
	 * GLOBE_FILES_ROOT (default: the owner's Desktop) from same-origin
	 * GET /api/files; opening a row previews it in a new tab via
	 * GET /api/files/:name (inline disposition for viewable types).
	 *
	 * This is the bridge, not a file manager: read-only, no upload, no
	 * rename, no delete. Transport errors render as one line, never a
	 * stack trace.
	 */

	/** One row of the GET /api/files listing. */
	export type BridgeFile = {
		name: string;
		size: number;
		modified: string;
		contentType: string;
	};

	let { open = false, onclose = () => {} }: { open?: boolean; onclose?: () => void } = $props();

	let files = $state<BridgeFile[]>([]);
	let loading = $state(false);
	let failed = $state(false);

	function prettySize(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes < 0) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function stamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '—';
		const today = new Date();
		return d.toDateString() === today.toDateString()
			? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
			: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
	}

	async function load(): Promise<void> {
		loading = true;
		failed = false;
		try {
			const res = await fetch('/api/files', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data: unknown = await res.json();
			files = Array.isArray(data) ? (data as BridgeFile[]) : [];
		} catch {
			failed = true;
			files = [];
		} finally {
			loading = false;
		}
	}

	function preview(name: string): void {
		window.open(`/api/files/${encodeURIComponent(name)}`, '_blank', 'noopener');
	}

	$effect(() => {
		if (open) void load();
	});
</script>

{#if open}
	<button class="scrim" aria-label="Close files" onclick={onclose}></button>

	<aside class="panel" aria-label="Desktop files">
		<header class="head">
			<span class="title">FILES</span>
			<span class="count">{files.length}</span>
			<button
				class="refresh"
				onclick={() => void load()}
				title="Refresh"
				aria-label="Refresh files"
				disabled={loading}
			>
				<svg
					viewBox="0 0 24 24"
					width="12"
					height="12"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				>
					<path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4"></path>
				</svg>
			</button>
			<button class="close" onclick={onclose} title="Close" aria-label="Close files">
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

		<p class="hint">Desktop bridge · viewable files only</p>

		<ul class="list">
			{#if loading}
				<li class="empty">Loading…</li>
			{:else if failed}
				<li class="empty">Could not reach the file bridge.</li>
			{:else if files.length === 0}
				<li class="empty">No viewable files on the Desktop.</li>
			{/if}
			{#each files as file (file.name)}
				<li>
					<button
						class="row"
						onclick={() => preview(file.name)}
						title="Preview {file.name}"
						aria-label="Preview {file.name}"
					>
						<span class="row-main">
							<span class="row-title">{file.name}</span>
							<span class="row-meta">
								{stamp(file.modified)} · {prettySize(file.size)}
							</span>
						</span>
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
		border-radius: var(--r-sm);
		padding: 1px 7px;
	}

	.refresh,
	.close {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		color: var(--hud-steel);
		cursor: pointer;
		padding: 4px;
		border-radius: var(--r-sm);
	}

	.refresh {
		margin-left: auto;
	}

	.refresh:hover:not(:disabled),
	.close:hover {
		color: #ffffff;
	}

	.refresh:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--hud-steel);
		letter-spacing: 0.4px;
		margin: 0;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		overflow-y: auto;
	}

	.empty {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--hud-steel);
		padding: 12px 4px;
	}

	.row {
		width: 100%;
		display: flex;
		align-items: center;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		padding: 8px 10px;
		cursor: pointer;
		text-align: left;
	}

	.row:hover {
		border-color: var(--hud-line-strong);
		background: rgba(125, 249, 255, 0.05);
	}

	.row-main {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.row-title {
		font-family: var(--font-mono);
		font-size: 12px;
		color: #ffffff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-meta {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--hud-steel);
	}
</style>
