<script lang="ts">
  import { browser } from '$app/environment';
  import NeuralGlobe, { type GlobeState } from '$lib/glob/NeuralGlobe.svelte';
  import type { Message } from '$lib/ChatBubble.svelte';
  import Settings from '$lib/Settings.svelte';
  import type { Provider } from '$lib/Settings.svelte';
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
  const PROVIDERS: Provider[] = ['hermes', 'lmstudio', 'opencode', 'openrouter', 'deepseek', 'openclaw'];

  /** No byte from the server for this long → abort the request (P0-3). */
  const CHAT_TIMEOUT_MS = 120_000;

  // State management for multi-conversation support
  let conversations: Conversation[] = $state([]);
  let activeConversationId: string | null = $state(null);
  let isThinking = $state(false);
  let isStreaming = $state(false); // a reply is arriving chunk by chunk
  let isSpeaking = $state(false); // TTS playback
  let currentAudio: HTMLAudioElement | null = null;
  let currentAudioUrl: string | null = null;
  let selectedProvider = $state<Provider>(DEFAULT_PROVIDER);
  let systemPrompt = $state('');

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
      systemPrompt = typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '';
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
    stopSpeaking();
    isSpeaking = true;

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!response.ok) throw new Error('TTS failed');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      currentAudioUrl = url;

      audio.onended = () => stopSpeaking();
      audio.onerror = () => stopSpeaking();

      await audio.play();
    } catch (err) {
      console.error('Piper TTS error:', err);
      // Covers both "play() rejected" and "fetch failed" — nothing leaks.
      stopSpeaking();
    }
  }

  function armChatTimeout(controller: AbortController) {
    clearChatTimeout();
    chatTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_TIMEOUT_MS);
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

    // Read the prompt at send time: Settings writes to localStorage, and the owner
    // may have edited it after this component mounted.
    const localSettings = readLocalSettings();
    const prompt =
      typeof localSettings.systemPrompt === 'string' && localSettings.systemPrompt
        ? localSettings.systemPrompt
        : systemPrompt;

    const controller = new AbortController();
    chatController = controller;
    armChatTimeout(controller);

    let assistantText = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Provider': selectedProvider
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

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

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

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armChatTimeout(controller); // every chunk proves the request is still alive

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let parsed: { content?: unknown; role?: unknown };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // malformed frame — skip it, keep the stream alive
          }
          if (!parsed || typeof parsed !== 'object') continue;

          // Validate the frame: only assistant content may enter the bubble.
          // Frames without a role are the server's normal output and count as
          // assistant; anything labelled otherwise is dropped.
          if (parsed.role !== undefined && parsed.role !== 'assistant') continue;
          if (typeof parsed.content !== 'string' || parsed.content === '') continue;

          assistantText += parsed.content;
          const snapshot = assistantText;
          conversations = conversations.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === replyId ? { ...m, text: snapshot } : m
                  )
                }
              : c
          );
        }
      }

      // Speak with Piper TTS after streaming completes
      if (assistantText) {
        void speak(assistantText);
      }

      await saveCurrentConversation();
    } catch (err) {
      console.error('Chat error:', err);

      const aborted = err instanceof DOMException && err.name === 'AbortError';
      // No emoji in product copy — these land verbatim in the transcript.
      let note: string;
      if (aborted && stopRequested) note = assistantText ? '' : 'Generation stopped.';
      else if (aborted && timedOut) note = `Timed out: ${selectedProvider}. Try again.`;
      else if (aborted) note = 'Generation stopped.';
      else note = `Cannot connect to ${selectedProvider}. Check settings.`;

      const bubbleText =
        assistantText + (assistantText && note ? `\n\n${note}` : note);

      // Never remove anything: replace the placeholder when it exists, append when
      // the failure happened before it was created. The user's message survives
      // either way (M10).
      conversations = conversations.map((c) => {
        if (c.id !== convId) return c;
        const hasPlaceholder = c.messages.some((m) => m.id === replyId);
        return hasPlaceholder
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === replyId ? { ...m, text: bubbleText } : m
              )
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

  function handleProviderChange(e: CustomEvent<Provider>) {
    // The dispatcher delivers the CustomEvent, not the id (H4). Reading the event
    // object itself made `selectedProvider` an event and `X-Provider` garbage.
    selectedProvider = normalizeProvider(e.detail);
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
      provider={selectedProvider}
      {jumpTick}
      onStop={stopGeneration}
    />
  {/if}

  <Frame />

  <footer class="vis-footer">
    THE GLOBE · VISOR HUD · NEURAL PROJECTION · {selectedProvider.toUpperCase()}
  </footer>

  <TopBar
    hudState={hudState}
    provider={selectedProvider}
    onSettings={() => (settingsOpen = true)}
  />

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
    hudState={hudState}
    provider={settingsReady ? selectedProvider : ''}
  />

  {#if activeConversationId}
    <Composer
      disabled={isThinking}
      onsend={(text) => void handleSend(text)}
    />
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
    on:change={handleProviderChange}
  />
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

   @media (max-width: 720px) {
   	.vis-footer {
   		bottom: 14px;
   		font-size: 8px;
   		letter-spacing: 1.4px;
   	}
   }
</style>
