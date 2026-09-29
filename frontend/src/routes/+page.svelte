<script lang="ts">
  import { browser } from '$app/environment';
  import NeuralGlobe from '$lib/glob/NeuralGlobe.svelte';
  import ChatInput from '$lib/ChatInput.svelte';
  import ChatBubble from '$lib/ChatBubble.svelte';
  import DeviceStats from '$lib/DeviceStats.svelte';
  import Settings from '$lib/Settings.svelte';
  import type { Provider } from '$lib/Settings.svelte';
  import ConversationSidebar from '$lib/ConversationSidebar.svelte';
  import type { Message } from '$lib/ChatBubble.svelte';
  import * as db from '$lib/db';

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
  let showInput = $state(false);
  let isThinking = $state(false);
  let isSpeaking = $state(false);
  let currentAudio: HTMLAudioElement | null = null;
  let currentAudioUrl: string | null = null;
  let selectedProvider = $state<Provider>(DEFAULT_PROVIDER);
  let systemPrompt = $state('');

  // In-flight chat request: the controller backs the stop button and the timeout.
  let chatController: AbortController | null = null;
  let chatTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopRequested = false;
  let timedOut = false;

  interface LocalSettings {
    provider?: unknown;
    systemPrompt?: unknown;
  }

  function readLocalSettings(): LocalSettings {
    try {
      return JSON.parse(localStorage.getItem('globe-settings') || '{}');
    } catch {
      return {};
    }
  }

  /** Accept only real provider ids — a corrupt/garbage value falls back (H4). */
  function normalizeProvider(value: unknown): Provider {
    return typeof value === 'string' && (PROVIDERS as string[]).includes(value)
      ? (value as Provider)
      : DEFAULT_PROVIDER;
  }

  function toUiMessages(stored: db.Conversation['messages']): Message[] {
    return stored.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: m.content
    }));
  }

  function toStoredMessages(messages: Message[]): db.Conversation['messages'] {
    return messages.map((m) => ({ role: m.role, content: m.text }));
  }

  // Load conversations from IndexedDB on mount
  async function loadConversations() {
    if (!browser) return;

    try {
      const settings = readLocalSettings();
      selectedProvider = normalizeProvider(settings.provider);
      systemPrompt = typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '';

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
    showInput = true;

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

    showInput = true;
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

  function handleGlobeClick() {
    if (!activeConversationId) {
      createNewConversation();
    } else {
      showInput = true;
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

  async function handleSend(e: CustomEvent<string>) {
    const text = e.detail;
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
        ? { ...c, messages: [...c.messages, { role: 'user', text }], updatedAt: Date.now() }
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
          ? { ...c, messages: [...c.messages, { id: replyId, role: 'assistant', text: '' }] }
          : c
      );

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
      let note: string;
      if (aborted && stopRequested) note = assistantText ? '' : '⏹ Generation stopped.';
      else if (aborted && timedOut) note = `⚠️ ${selectedProvider} timed out. Try again.`;
      else if (aborted) note = '⏹ Generation stopped.';
      else note = `⚠️ Cannot connect to ${selectedProvider}. Check settings.`;

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
              messages: [...c.messages, { id: replyId, role: 'assistant' as const, text: bubbleText }]
            };
      });

      await saveCurrentConversation();
    } finally {
      clearChatTimeout();
      chatController = null;
      isThinking = false;
    }
  }

  function handleProviderChange(e: CustomEvent<Provider>) {
    // The dispatcher delivers the CustomEvent, not the id (H4). Reading the event
    // object itself made `selectedProvider` an event and `X-Provider` garbage.
    selectedProvider = normalizeProvider(e.detail);
    saveCurrentConversation();
  }

  // Initialize on mount
  if (browser) {
    loadConversations();
  }
</script>

<svelte:head>
  <title>Glob Interface</title>
  <meta name="description" content="Neural Electric Globe — AI Interface" />
</svelte:head>

{#if browser}
  <!-- Conversation Sidebar -->
  {#if conversations.length > 0}
    <ConversationSidebar 
      {conversations}
      activeId={activeConversationId}
      onSelect={selectConversation}
      onNew={createNewConversation}
      onDelete={deleteConversation}
    />
  {/if}

  <!-- Globe centered -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="globe-wrapper" onclick={handleGlobeClick}>
    <NeuralGlobe {isSpeaking} {isThinking} audioElement={currentAudio ?? undefined} />
  </div>

  <!-- Chat history: single card on the LEFT side -->
  {#if activeConversationId && conversations.length > 0}
    {#each conversations as conv (conv.id)}
      {#if conv.id === activeConversationId && conv.messages.length > 0}
        <div class="chat-card">
          {#each conv.messages as msg}
            <ChatBubble message={msg} />
          {/each}
          {#if isThinking}
            <div class="thinking">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
              <button class="stop-btn" onclick={stopGeneration} title="Stop generating">
                ■ Stop
              </button>
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}

  <!-- Chat input at the BOTTOM CENTER -->
  {#if activeConversationId && showInput}
    <ChatInput 
      bind:visible={showInput} 
      on:send={handleSend}
    />
  {/if}

  <!-- Device stats at the TOP RIGHT -->
  <DeviceStats />

  <!-- Settings button at bottom right -->
  <Settings 
    initialProvider={selectedProvider} 
    on:change={handleProviderChange} 
  />
{/if}

<style>
  .globe-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    cursor: pointer;
    z-index: 1;
  }

  .chat-card {
    position: fixed;
    top: 50%;
    left: calc(280px + 40px);
    transform: translateY(-50%);
    z-index: 50;
    width: min(320px, calc(100vw - 360px));
    max-height: 70vh;
    overflow-y: auto;
    background: rgba(10, 15, 30, 0.8);
    border: 1px solid rgba(68, 136, 255, 0.15);
    border-radius: 16px;
    padding: 16px;
    backdrop-filter: blur(12px);
    box-shadow: 0 0 30px rgba(68, 136, 255, 0.08);
  }

  .chat-card :global(::-webkit-scrollbar) {
    width: 4px;
  }

  .chat-card :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  .chat-card :global(::-webkit-scrollbar-thumb) {
    background: rgba(68, 136, 255, 0.2);
    border-radius: 2px;
  }

  .chat-card :global(::-webkit-scrollbar-thumb:hover) {
    background: rgba(68, 136, 255, 0.4);
  }

  .thinking {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
  }

  .dot {
    width: 6px;
    height: 6px;
    background: rgba(68, 136, 255, 0.5);
    border-radius: 50%;
    animation: pulse 1.2s ease-in-out infinite;
  }

  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }

  .stop-btn {
    margin-left: auto;
    padding: 4px 10px;
    background: rgba(255, 107, 107, 0.15);
    border: 1px solid rgba(255, 107, 107, 0.5);
    border-radius: 8px;
    color: #ff6b6b;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .stop-btn:hover {
    background: rgba(255, 107, 107, 0.3);
    box-shadow: 0 0 12px rgba(255, 107, 107, 0.3);
  }

  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1.2); }
  }
</style>
