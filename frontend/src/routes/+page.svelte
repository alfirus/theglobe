<script lang="ts">
	import { browser } from '$app/environment';
	import NeuralGlobe, { type GlobeState } from '$lib/glob/NeuralGlobe.svelte';
	import type { Message } from '$lib/ChatBubble.svelte';
	import Settings, { type UplinkSelection } from '$lib/Settings.svelte';
	import type { Provider } from '$lib/Settings.svelte';
	import type { Agent, UplinkMode } from '$lib/Settings.svelte';
	import * as db from '$lib/db';
	import { loadEffectiveSettings, readLocalSettings } from '$lib/settingsSync';

	// Visor HUD (Direction B)
	import Frame from '$lib/visor/Frame.svelte';
	import LensOverlay from '$lib/visor/LensOverlay.svelte';
	import TopBar, { type HudState } from '$lib/visor/TopBar.svelte';
	import IconRail from '$lib/visor/IconRail.svelte';
	import TelemetryRail, { type GlobeTelemetry } from '$lib/visor/TelemetryRail.svelte';
	import TranscriptZone from '$lib/visor/TranscriptZone.svelte';
	import Composer from '$lib/visor/Composer.svelte';
	import ConversationsPanel from '$lib/visor/ConversationsPanel.svelte';
	import ThoughtRail, { type ThoughtStep } from '$lib/visor/ThoughtRail.svelte';
	import OpsLog from '$lib/visor/OpsLog.svelte';
	import { pushEvent } from '$lib/events';

	/**
	 * In-memory conversation. Carries `createdAt`/`updatedAt` alongside the
	 * messages so the sidebar can format a real date (it used to render
	 * "Invalid Date" because the type never had `updatedAt` — M6).
	 */
	type Conversation = {
		id: string;
		title: string;
		messages: Message[];
		createdAt: number;
		updatedAt: number;
	};

	const DEFAULT_PROVIDER: Provider = 'hermes';
	const PROVIDERS: Provider[] = [
		'hermes',
		'lmstudio',
		'opencode',
		'openrouter',
		'deepseek',
		'openclaw',
		'mimo'
	];
	const DEFAULT_AGENT: Agent = 'hermes-agent';
	const AGENTS: Agent[] = ['hermes-agent', 'openclaw-agent'];

	/**
	 * Idle watchdog fallback (P0-3): no byte from the server for this long →
	 * abort the request. The per-provider `timeoutMs` (from effective settings,
	 * default 120 s) replaces this whenever it resolves — the constant only
	 * covers the window before hydration.
	 */
	const CHAT_TIMEOUT_MS = 120_000;
	const MIN_CHAT_TIMEOUT_MS = 5_000;
	const MAX_CHAT_TIMEOUT_MS = 600_000;

	// Per-uplink wall-clock budget in ms, from effective settings (`configs.*.
	// timeoutMs` / `agents.*.timeoutMs`; server fills what this browser never
	// set). Starts at the fallback and is replaced on hydration and on every
	// uplink switch.
	let uplinkTimeouts = $state<Record<string, number>>({});

	function clampTimeoutMs(raw: unknown): number {
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return CHAT_TIMEOUT_MS;
		return Math.min(Math.max(Math.round(raw), MIN_CHAT_TIMEOUT_MS), MAX_CHAT_TIMEOUT_MS);
	}

	function chatTimeoutMs(id: string): number {
		return clampTimeoutMs(uplinkTimeouts[id]);
	}

	function adoptTimeouts(settings: {
		configs?: Record<string, { timeoutMs?: unknown }>;
		agents?: Record<string, { timeoutMs?: unknown }>;
	}): void {
		for (const section of [settings.configs, settings.agents]) {
			if (!section || typeof section !== 'object') continue;
			for (const [id, cfg] of Object.entries(section)) {
				if (!cfg || typeof cfg !== 'object') continue;
				const ms = (cfg as { timeoutMs?: unknown }).timeoutMs;
				if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
					uplinkTimeouts[id] = clampTimeoutMs(ms);
				}
			}
		}
	}

	// State management for multi-conversation support
	let conversations: Conversation[] = $state([]);
	let activeConversationId: string | null = $state(null);
	let isThinking = $state(false);
	let isStreaming = $state(false); // a reply is arriving chunk by chunk
	let isSpeaking = $state(false); // TTS playback
	let currentAudio: HTMLAudioElement | null = null;
	let currentAudioUrl: string | null = null;
	let selectedProvider = $state<Provider>(DEFAULT_PROVIDER);
	let selectedAgent = $state<Agent>(DEFAULT_AGENT);
	let uplinkMode = $state<UplinkMode>('provider');
	let systemPrompt = $state('');

	/** Id shown in the HUD + thought rail for the active uplink. */
	const activeUplinkId = $derived<string>(
		uplinkMode === 'agent' ? selectedAgent : selectedProvider
	);

	// THOUGHT rail: one step per chat lifecycle stage, pushed from handleSend.
	let thoughtSteps = $state<ThoughtStep[]>([]);
	let thoughtPhase = $state('');
	let thoughtTokens = $state(0);
	// Provider reasoning (`reasoning_content` on MiMo/DeepSeek), rendered in the
	// THOUGHT card under the lifecycle steps. Reset per request like the rest.
	let thoughtThinking = $state('');
	let thoughtStart = 0;
	let thoughtElapsedMs = $state(0);

	function setStep(id: string, status: ThoughtStep['status'], detail?: string) {
		thoughtSteps = thoughtSteps.map((s) =>
			s.id === id ? { ...s, status, detail: detail ?? s.detail } : s
		);
	}

	// HUD chrome state
	let settingsReady = $state(false); // server settings resolved at least once
	let settingsOpen = $state(false);
	let conversationsOpen = $state(false);
	let jumpTick = $state(0);
	let globeTelemetry = $state<GlobeTelemetry | null>(null);

	// In-flight chat request: the controller backs the stop button and the timeout.
	let chatController: AbortController | null = null;
	let chatTimeout: ReturnType<typeof setTimeout> | null = null;
	let stopRequested = false;
	let timedOut = false;

	/**
	 * The chips and the globe both mirror these three real states:
	 * listening (idle / mic live) → thinking (request out, no bytes yet) →
	 * speaking (reply streaming, or TTS playing). Streaming outranks thinking
	 * because `isThinking` stays true for the whole request.
	 */
	const hudState = $derived<HudState>(
		isStreaming || isSpeaking ? 'speaking' : isThinking ? 'thinking' : 'listening'
	);
	const globeState = $derived<GlobeState>(
		isStreaming || isSpeaking ? 'speaking' : isThinking ? 'thinking' : 'idle'
	);

	const activeConversation = $derived(
		conversations.find((c) => c.id === activeConversationId) ?? null
	);
	const activeMessages = $derived(activeConversation?.messages ?? []);
	const panelConversations = $derived(
		conversations.map((c) => ({
			id: c.id,
			title: c.title,
			messageCount: c.messages.length,
			updatedAt: c.updatedAt
		}))
	);

	/** Accept only real provider ids — a corrupt/garbage value falls back (H4). */
	function normalizeProvider(value: unknown): Provider {
		return typeof value === 'string' && (PROVIDERS as string[]).includes(value)
			? (value as Provider)
			: DEFAULT_PROVIDER;
	}

	/** Accept only real agent ids — same fallback contract as providers. */
	function normalizeAgent(value: unknown): Agent {
		return typeof value === 'string' && (AGENTS as string[]).includes(value)
			? (value as Agent)
			: DEFAULT_AGENT;
	}

	function normalizeUplinkMode(value: unknown): UplinkMode {
		return value === 'agent' ? 'agent' : 'provider';
	}

	function toUiMessages(stored: db.Conversation['messages']): Message[] {
		return stored.map((m) => ({
			role: m.role === 'assistant' ? 'assistant' : 'user',
			text: m.content,
			ts: typeof m.ts === 'number' ? m.ts : undefined
		}));
	}

	function toStoredMessages(messages: Message[]): db.Conversation['messages'] {
		return messages.map((m) => ({ role: m.role, content: m.text, ts: m.ts }));
	}

	// Load conversations from IndexedDB on mount
	async function loadConversations() {
		if (!browser) return;

		try {
			// D1: localStorage is not the only source of truth. On a fresh profile it
			// is empty, and without the server's prefill the first message went out
			// against an unconfigured provider (`502 Cannot connect to hermes`).
			// Local values still win — this only fills what the browser never set.
			const settings = await loadEffectiveSettings();
			selectedProvider = normalizeProvider(settings.provider);
			selectedAgent = normalizeAgent(settings.agent);
			uplinkMode = normalizeUplinkMode(settings.uplinkMode);
			systemPrompt = typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '';
			// Per-provider uplink budgets for the chat watchdog (server prefill fills
			// what this browser never set, same as provider/base URL/model).
			adoptTimeouts(settings);
			// Only now may the telemetry rail probe the active provider — before this
			// the page still holds the default id, which has no base URL (a 400).
			settingsReady = true;

			const stored = await db.getConversations();

			conversations = stored.map((conv) => ({
				id: conv.id,
				title: conv.title,
				messages: toUiMessages(conv.messages),
				createdAt: conv.createdAt,
				updatedAt: conv.updatedAt
			}));

			// Restore active conversation or create new one
			if (stored.length > 0) {
				activeConversationId = stored[0].id;
			} else {
				await createNewConversation();
			}
		} catch (err) {
			console.error('Failed to load conversations:', err);
			settingsReady = true;
			await createNewConversation();
		}
	}

	async function createNewConversation() {
		const id = crypto.randomUUID();
		const now = Date.now();
		const newConv: Conversation = {
			id,
			title: 'New Conversation',
			messages: [],
			createdAt: now,
			updatedAt: now
		};

		conversations = [newConv, ...conversations];
		activeConversationId = id;

		// Save to IndexedDB
		try {
			await db.saveConversation({
				id,
				title: newConv.title,
				messages: [],
				provider: selectedProvider,
				systemPrompt,
				createdAt: now,
				updatedAt: now
			});
		} catch (err) {
			console.error('Failed to create conversation:', err);
		}
	}

	async function selectConversation(id: string) {
		activeConversationId = id;
		conversationsOpen = false;

		const conv = conversations.find((c) => c.id === id);
		if (conv) {
			conversations = conversations.map((c) =>
				c.id === id ? { ...c, messages: [...conv.messages] } : c
			);
		}

		// Load full conversation from IndexedDB (messages, title and timestamps)
		try {
			const stored = await db.getConversation(id);
			if (stored) {
				conversations = conversations.map((c) =>
					c.id === id
						? {
								...c,
								title: stored.title,
								messages: toUiMessages(stored.messages),
								createdAt: stored.createdAt,
								updatedAt: stored.updatedAt
							}
						: c
				);
			}
		} catch (err) {
			console.warn('Could not load conversation:', err);
		}

		jumpTick++;
	}

	async function deleteConversation(id: string) {
		conversations = conversations.filter((c) => c.id !== id);
		if (activeConversationId === id) {
			activeConversationId = null;

			if (conversations.length > 0) {
				await selectConversation(conversations[0].id);
			} else {
				await createNewConversation();
			}
		}

		// Delete from IndexedDB
		try {
			await db.deleteConversation(id);
		} catch (err) {
			console.error('Failed to delete conversation:', err);
		}
	}

	async function saveCurrentConversation() {
		if (!activeConversationId) return;

		const conv = conversations.find((c) => c.id === activeConversationId);
		if (!conv) return;
		// Auto-generate the title from the first user message. The condition used to
		// be inverted (M9): it only renamed conversations that already had a custom
		// title, so fresh chats stayed "New Conversation" forever while titled chats
		// were overwritten on every save.
		let title = conv.title;
		if (conv.messages.length > 0 && title.startsWith('New Conversation')) {
			const firstUserMsg = conv.messages.find((m) => m.role === 'user');
			if (firstUserMsg) {
				title = firstUserMsg.text.substring(0, 50);
			}
		}

		try {
			const saved = await db.saveConversation({
				id: conv.id,
				title,
				messages: toStoredMessages(conv.messages),
				provider: selectedProvider,
				systemPrompt,
				// createdAt is only ever set at creation time; only updatedAt moves (L10).
				createdAt: conv.createdAt,
				updatedAt: Date.now()
			});

			// Update local state with the new title and freshness
			conversations = conversations.map((c) =>
				c.id === conv.id ? { ...c, title, updatedAt: saved.updatedAt } : c
			);
		} catch (err) {
			console.error('Failed to save conversation:', err);
		}
	}

	// Read-replies-aloud toggle: persisted locally (it is a device preference, not
	// provider config), default ON. Toggling off stops any in-flight playback.
	const TTS_TOGGLE_KEY = 'globe-tts-enabled';
	let ttsEnabled = $state(true);

	function loadTtsToggle(): void {
		try {
			const raw = localStorage.getItem(TTS_TOGGLE_KEY);
			// Absent key = first run = ON; only an explicit "0" disables.
			ttsEnabled = raw !== '0';
		} catch {
			ttsEnabled = true;
		}
	}

	function toggleTts(): void {
		ttsEnabled = !ttsEnabled;
		if (!ttsEnabled) stopSpeaking();
		pushEvent('TTS', ttsEnabled ? 'voice output on' : 'voice output off');
		try {
			localStorage.setItem(TTS_TOGGLE_KEY, ttsEnabled ? '1' : '0');
		} catch {
			/* private window — the toggle still works for this session */
		}
	}

	/** Stop playback and release the blob URL (L1: every interrupted clip leaked one). */
	function stopSpeaking() {
		if (currentAudio) {
			currentAudio.onended = null;
			currentAudio.onerror = null;
			currentAudio.pause();
			currentAudio = null;
		}
		if (currentAudioUrl) {
			URL.revokeObjectURL(currentAudioUrl);
			currentAudioUrl = null;
		}
		isSpeaking = false;
	}

	async function speak(text: string) {
		if (!ttsEnabled) return;
		stopSpeaking();
		isSpeaking = true;
		// Log length, never content.
		pushEvent('TTS', `synthesising ${text.length} chars`);

		try {
			const response = await fetch('/api/tts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text }),
				// Synthesis budget: the global TTS cap (server enforces the same).
				signal: AbortSignal.timeout(130_000)
			});

			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				throw new Error(detail || 'TTS failed');
			}

			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			currentAudio = audio;
			currentAudioUrl = url;

			audio.onended = () => stopSpeaking();
			audio.onerror = () => stopSpeaking();

			await audio.play();
		} catch (err) {
			const reason = err instanceof Error && err.message ? err.message : 'TTS failed';
			console.error('TTS error:', reason);
			// The server message names the fix (`edge-tts CLI not found — install…`,
			// `TTS API key not configured — set…`); surfacing it in the rail beats a
			// bare "tts failed" that sends the owner hunting.
			pushEvent('ERROR', `tts failed · ${reason.slice(0, 160)}`);
			setStep('speak', 'failed', reason.slice(0, 80));
			// Covers both "play() rejected" and "fetch failed" — nothing leaks.
			stopSpeaking();
		}
	}

	function armChatTimeout(controller: AbortController, uplinkId: string) {
		clearChatTimeout();
		chatTimeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, chatTimeoutMs(uplinkId));
	}

	function clearChatTimeout() {
		if (chatTimeout !== null) {
			clearTimeout(chatTimeout);
			chatTimeout = null;
		}
	}

	/** Stop-generation button (P0-3). */
	function stopGeneration() {
		if (!chatController) return;
		stopRequested = true;
		pushEvent('CHAT', 'stop requested');
		chatController.abort();
	}

	function focusComposer() {
		window.dispatchEvent(new Event('glob:focus-composer'));
	}

	async function handleSend(text: string) {
		if (!text.trim() || !activeConversationId || isThinking) return;

		const convId = activeConversationId;

		// Everything already in this conversation is the history for the request —
		// everything except the message we are about to send (H6, API contract).
		const existing = conversations.find((c) => c.id === convId);
		const history = (existing?.messages ?? []).map((m) => ({ role: m.role, content: m.text }));

		// Identified placeholders: streaming and error handling target these by id
		// instead of slicing by position (M10 — that could delete the user's message).
		const replyId = crypto.randomUUID();

		conversations = conversations.map((c) =>
			c.id === convId
				? {
						...c,
						messages: [...c.messages, { role: 'user', text, ts: Date.now() }],
						updatedAt: Date.now()
					}
				: c
		);

		isThinking = true;
		stopRequested = false;
		timedOut = false;
		stopSpeaking();

		// THOUGHT rail: fresh run, one step per lifecycle stage.
		thoughtStart = Date.now();
		thoughtTokens = 0;
		thoughtThinking = '';
		thoughtElapsedMs = 0;
		thoughtSteps = [
			{
				id: 'dispatch',
				label: 'Dispatch',
				detail: `${activeUplinkId} · ${history.length} history`,
				status: 'active'
			},
			{ id: 'wait', label: 'Uplink wait', detail: 'awaiting first byte', status: 'pending' },
			{ id: 'stream', label: 'Stream', detail: '0 tokens', status: 'pending' },
			{ id: 'speak', label: 'Speak', detail: 'tts', status: 'pending' }
		];
		thoughtPhase = `connecting to ${activeUplinkId}`;
		pushEvent('CHAT', `dispatch → ${activeUplinkId} · ${history.length} history`);

		// Read the prompt at send time: Settings writes to localStorage, and the owner
		// may have edited it after this component mounted.
		const localSettings = readLocalSettings();
		const prompt =
			typeof localSettings.systemPrompt === 'string' && localSettings.systemPrompt
				? localSettings.systemPrompt
				: systemPrompt;

		const controller = new AbortController();
		chatController = controller;
		armChatTimeout(controller, activeUplinkId);

		let assistantText = '';

		try {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Provider': selectedProvider,
					// Agent uplink: the server routes on this pair (mode + entry).
					'X-Uplink-Mode': uplinkMode,
					'X-Agent': selectedAgent
					// H5: the system prompt travels in the body, never as a header —
					// the server reads `systemPrompt` from the JSON it already parses,
					// and non-Latin-1 header values make fetch throw.
				},
				body: JSON.stringify({
					message: text,
					systemPrompt: prompt || undefined,
					history
				}),
				signal: controller.signal
			});

			if (!response.ok) {
				pushEvent('ERROR', `provider HTTP ${response.status}`);
				setStep('dispatch', 'failed', `HTTP ${response.status}`);
				setStep('wait', 'failed', 'no uplink');
				throw new Error(`HTTP ${response.status}`);
			}
			pushEvent('LINK', `${activeUplinkId} uplink ok · ${Date.now() - thoughtStart} ms`);
			setStep('dispatch', 'done', `${Date.now() - thoughtStart} ms`);
			setStep('wait', 'active', 'awaiting first byte');

			// Empty assistant message for streaming, identified by id.
			conversations = conversations.map((c) =>
				c.id === convId
					? {
							...c,
							messages: [
								...c.messages,
								{ id: replyId, role: 'assistant', text: '', ts: Date.now() }
							]
						}
					: c
			);

			// First byte arrived → the globe/chips move from THINKING to SPEAKING.
			isStreaming = true;
			setStep('wait', 'done', 'first byte');
			setStep('stream', 'active', '0 tokens');
			thoughtPhase = `streaming from ${activeUplinkId}`;
			pushEvent('STREAM', 'first byte · speaking');

			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				armChatTimeout(controller, activeUplinkId); // every chunk proves the request is still alive

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;

					let parsed: { content?: unknown; thinking?: unknown; role?: unknown };
					try {
						parsed = JSON.parse(data);
					} catch {
						continue; // malformed frame — skip it, keep the stream alive
					}
					if (!parsed || typeof parsed !== 'object') continue;

					// Reasoning frames render in the THOUGHT card — never in the bubble.
					if (typeof parsed.thinking === 'string' && parsed.thinking !== '') {
						thoughtThinking += parsed.thinking;
						thoughtElapsedMs = Date.now() - thoughtStart;
					}

					// Validate the frame: only assistant content may enter the bubble.
					// Frames without a role are the server's normal output and count as
					// assistant; anything labelled otherwise is dropped.
					if (parsed.role !== undefined && parsed.role !== 'assistant') continue;
					if (typeof parsed.content !== 'string' || parsed.content === '') continue;

					assistantText += parsed.content;
					thoughtTokens += 1;
					thoughtElapsedMs = Date.now() - thoughtStart;
					const snapshot = assistantText;
					conversations = conversations.map((c) =>
						c.id === convId
							? {
									...c,
									messages: c.messages.map((m) => (m.id === replyId ? { ...m, text: snapshot } : m))
								}
							: c
					);
				}
			}

			// Speak with the configured TTS engine after streaming completes —
			// skipped entirely when voice output is toggled off.
			setStep('stream', 'done', `${thoughtTokens} tokens`);
			const speakDetail = !assistantText ? 'empty reply' : ttsEnabled ? 'tts' : 'muted';
			setStep('speak', assistantText && ttsEnabled ? 'active' : 'done', speakDetail);
			thoughtPhase = '';
			pushEvent('STREAM', `done · ${thoughtTokens} frames`);
			if (assistantText && ttsEnabled) {
				void speak(assistantText).finally(() => setStep('speak', 'done', 'played'));
			}

			await saveCurrentConversation();
			pushEvent('CHAT', `saved · ${thoughtTokens} frames`);
		} catch (err) {
			console.error('Chat error:', err);

			const aborted = err instanceof DOMException && err.name === 'AbortError';
			// No emoji in product copy — these land verbatim in the transcript.
			let note: string;
			if (aborted && stopRequested) note = assistantText ? '' : 'Generation stopped.';
			else if (aborted && timedOut) note = `Timed out: ${activeUplinkId}. Try again.`;
			else if (aborted) note = 'Generation stopped.';
			else note = `Cannot connect to ${activeUplinkId}. Check settings.`;

			pushEvent('ERROR', aborted ? 'request aborted' : note);
			for (const s of thoughtSteps) {
				if (s.status === 'active' || s.status === 'pending')
					setStep(s.id, 'failed', s.id === 'stream' ? `${thoughtTokens} tokens` : s.detail);
			}
			thoughtPhase = '';

			const bubbleText = assistantText + (assistantText && note ? `\n\n${note}` : note);

			// Never remove anything: replace the placeholder when it exists, append when
			// the failure happened before it was created. The user's message survives
			// either way (M10).
			conversations = conversations.map((c) => {
				if (c.id !== convId) return c;
				const hasPlaceholder = c.messages.some((m) => m.id === replyId);
				return hasPlaceholder
					? {
							...c,
							messages: c.messages.map((m) => (m.id === replyId ? { ...m, text: bubbleText } : m))
						}
					: {
							...c,
							messages: [
								...c.messages,
								{ id: replyId, role: 'assistant' as const, text: bubbleText, ts: Date.now() }
							]
						};
			});

			await saveCurrentConversation();
		} finally {
			clearChatTimeout();
			chatController = null;
			isThinking = false;
			isStreaming = false;
		}
	}

	function handleProviderChange(selection: Provider | UplinkSelection) {
		// Runes callback prop (was `on:change` + CustomEvent): Settings delivers
		// the selection value directly, not an event object. Reading the event
		// itself once made `selectedProvider` an event and `X-Provider` garbage.
		// New shape carries the whole uplink (mode + both selections); the legacy
		// bare-Provider shape still arrives from older Settings builds.
		const detail = selection;
		if (detail && typeof detail === 'object') {
			uplinkMode = normalizeUplinkMode(detail.mode);
			selectedProvider = normalizeProvider(detail.provider);
			selectedAgent = normalizeAgent(detail.agent);
		} else {
			selectedProvider = normalizeProvider(detail);
		}
		saveCurrentConversation();
	}

	/** ⌘K / ⌘1 toggle the conversation rail, ⌘, opens Settings (as the hints promise). */
	$effect(() => {
		if (!browser) return;

		function onKey(e: KeyboardEvent) {
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();
			if (key === 'k' || key === '1') {
				e.preventDefault();
				conversationsOpen = !conversationsOpen;
			} else if (e.key === ',') {
				e.preventDefault();
				settingsOpen = true;
			}
		}

		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// Initialize on mount
	if (browser) {
		loadTtsToggle();
		loadConversations();
	}
</script>

<svelte:head>
	<title>Globe Interface</title>
	<meta name="description" content="Visor HUD — Neural Globe AI Interface" />
</svelte:head>

{#if browser}
	<!-- Full-bleed neuron globe: continuous 3D rotation, state-driven animation -->
	<NeuralGlobe mode={globeState} onTelemetry={(t) => (globeTelemetry = t)} />

	<!-- Soft radial focus scrim so text reads without ever drawing a box -->
	<div class="focus-scrim" aria-hidden="true"></div>

	<!-- Transcript: reticle-bounded zone, turns split left/right -->
	{#if activeConversationId}
		<TranscriptZone
			messages={activeMessages}
			{isThinking}
			{isStreaming}
			provider={activeUplinkId}
			{jumpTick}
			onStop={stopGeneration}
		/>
	{/if}

	<Frame />

	<ThoughtRail
		steps={thoughtSteps}
		phase={thoughtPhase}
		streaming={isStreaming}
		tokens={thoughtTokens}
		elapsedMs={thoughtElapsedMs}
		thinking={thoughtThinking}
	/>

	<OpsLog />

	<footer class="vis-footer">
		THE GLOBE · VISOR HUD · NEURAL PROJECTION · {activeUplinkId.toUpperCase()}
	</footer>

	<TopBar {hudState} provider={activeUplinkId} onSettings={() => (settingsOpen = true)} />

	<IconRail
		count={conversations.length}
		active={conversationsOpen}
		onToggleConversations={() => (conversationsOpen = !conversationsOpen)}
		onNew={() => void createNewConversation()}
		onFocusComposer={focusComposer}
		onFocusTranscript={() => jumpTick++}
	/>

	<TelemetryRail
		telemetry={globeTelemetry}
		{hudState}
		provider={settingsReady ? activeUplinkId : ''}
	/>

	{#if activeConversationId}
		<Composer disabled={isThinking} onsend={(text) => void handleSend(text)} />
	{/if}

	<LensOverlay />

	<ConversationsPanel
		open={conversationsOpen}
		conversations={panelConversations}
		activeId={activeConversationId}
		onclose={() => (conversationsOpen = false)}
		onselect={(id) => void selectConversation(id)}
		onnew={() => void createNewConversation()}
		ondelete={(id) => void deleteConversation(id)}
	/>

	<Settings
		hideTrigger
		bind:open={settingsOpen}
		initialProvider={selectedProvider}
		onchange={handleProviderChange}
	/>

	<!-- Voice-output toggle: bottom right HUD bracket control — sharp corners,
       bracket ends, HUD label + white speaker glyph. Waves when live, cross
       when muted: state survives in shape + word, never colour. -->
	<button
		class="tts-toggle"
		class:muted={!ttsEnabled}
		onclick={toggleTts}
		title={ttsEnabled ? 'Mute voice output' : 'Enable voice output'}
		aria-label={ttsEnabled ? 'Mute voice output' : 'Enable voice output'}
		aria-pressed={ttsEnabled}
	>
		<span class="tts-glyph" aria-hidden="true">
			<svg
				viewBox="0 0 24 24"
				width="14"
				height="14"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
			>
				<path d="M4 10v4h3l4 3.5v-11L7 10z"></path>
				{#if ttsEnabled}
					<path d="M15.5 9.5a4 4 0 0 1 0 5M18 7a7.5 7.5 0 0 1 0 10"></path>
				{:else}
					<path d="M15.5 9.5l5 5M20.5 9.5l-5 5"></path>
				{/if}
			</svg>
		</span>
		<span class="tts-word">{ttsEnabled ? 'VOICE ON' : 'MUTED'}</span>
	</button>
{/if}

<style>
	.focus-scrim {
		position: fixed;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		background: radial-gradient(
			ellipse 60% 55% at 50% 48%,
			rgba(5, 11, 26, 0.55) 0%,
			rgba(5, 11, 26, 0.28) 55%,
			rgba(5, 11, 26, 0) 100%
		);
	}

	.vis-footer {
		position: fixed;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 45;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 2.2px;
		color: var(--hud-steel);
		opacity: 0.75;
		white-space: nowrap;
		pointer-events: none;
	}

	/* Voice-output toggle — bottom right HUD bracket control, same language as
      the Settings bracket buttons and the composer line: sharp corners,
      bracket ends, HUD label, plain white glyph. */
	.tts-toggle {
		position: fixed;
		bottom: 20px;
		right: 20px;
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-hud);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 1.6px;
		color: var(--hud-cyan);
		background: transparent;
		border: none;
		border-radius: 0;
		padding: 8px 14px;
		cursor: pointer;
		z-index: 90;
		transition:
			color 0.2s ease,
			background 0.2s ease,
			box-shadow 0.2s ease,
			opacity 0.2s ease;
	}
	.tts-toggle::before,
	.tts-toggle::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 7px;
		border: 1px solid currentColor;
		opacity: 0.85;
		transition: opacity 0.2s ease;
	}
	.tts-toggle::before {
		left: 0;
		border-right: 0;
	}
	.tts-toggle::after {
		right: 0;
		border-left: 0;
	}
	.tts-toggle:hover {
		background: rgba(125, 249, 255, 0.1);
		box-shadow: 0 0 12px rgba(125, 249, 255, 0.3);
	}
	.tts-toggle:hover::before,
	.tts-toggle:hover::after {
		opacity: 1;
	}
	.tts-toggle.muted {
		color: var(--hud-steel);
		opacity: 0.8;
	}
	.tts-glyph {
		display: flex;
		color: #ffffff;
	}
	.tts-word {
		white-space: nowrap;
	}

	@media (max-width: 720px) {
		.vis-footer {
			bottom: 14px;
			font-size: 8px;
			letter-spacing: 1.4px;
		}
	}
</style>
