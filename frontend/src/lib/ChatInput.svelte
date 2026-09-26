<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // Voice results go out through the same `send` event as typed input — there is
  // deliberately no second `onVoice` callback (L9: two paths, one of them a dead
  // `console.log` stub in the parent).
  let { visible = $bindable(false) }: {
    visible?: boolean;
  } = $props();

  const dispatch = createEventDispatcher<{ send: string }>();

  let input = $state('');
  let inputEl: HTMLInputElement;
  
  // Voice recognition state
  let isListening = $state(false);
  let recognition: any = null;
  let voiceText = $state('');
  let hasVoiceSupport = $state(false);

  // Check for Speech Recognition support
  if (typeof window !== 'undefined') {
    const SpeechRecognition = 
      (window as any).SpeechRecognition || 
      (window as any).webkitSpeechRecognition;
    
    if (SpeechRecognition) {
      hasVoiceSupport = true;
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        voiceText = transcript;
        
        // If final result, send it
        if (event.results[event.results.length - 1].isFinal) {
          const finalText = transcript.trim();
          if (finalText) {
            dispatch('send', finalText);
            input = '';
            voiceText = '';
            isListening = false;
          }
        }
      };

      recognition.onerror = () => {
        isListening = false;
        voiceText = '';
      };

      recognition.onend = () => {
        isListening = false;
        voiceText = '';
      };
    }
  }

  function startListening() {
    if (recognition && !isListening) {
      try {
        recognition.start();
        isListening = true;
      } catch (err) {
        console.error('Speech recognition error:', err);
      }
    }
  }

  function stopListening() {
    if (recognition && isListening) {
      recognition.stop();
      isListening = false;
      voiceText = '';
    }
  }

  function toggleVoice() {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && input.trim()) {
      dispatch('send', input.trim());
      input = '';
    }
    if (e.key === 'Escape') {
      visible = false;
      input = '';
    }
  }

  function handleSend() {
    if (input.trim()) {
      dispatch('send', input.trim());
      input = '';
    }
  }

  function handleBackdropClick() {
    visible = false;
    input = '';
  }

  $effect(() => {
    if (visible && inputEl) {
      inputEl.focus();
    }
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="backdrop" onclick={handleBackdropClick}></div>
  <div class="chat-input-container">
    <div class="chat-input-wrapper">
      {#if hasVoiceSupport}
        <button 
          class="voice-btn {isListening ? 'listening' : ''}" 
          onclick={toggleVoice}
          title={isListening ? 'Stop listening...' : 'Voice input'}
        >
          {#if isListening}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          {/if}
        </button>
      {/if}

      <input
        bind:this={inputEl}
        bind:value={input}
        onkeydown={handleKeydown}
        type="text"
        placeholder={isListening ? 'Listening...' : 'Ask the glob something...'}
        class="chat-input"
      />
      
      {#if voiceText && isListening}
        <div class="voice-preview">
          "{voiceText}"
        </div>
      {/if}

      <button class="send-btn" onclick={handleSend} disabled={!input.trim()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13" />
        </svg>
      </button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 99;
  }

  .chat-input-container {
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    width: min(600px, calc(100vw - 320px));
    animation: slideUp 0.2s ease-out;
  }

  .chat-input-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(10, 15, 30, 0.85);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 16px;
    padding: 6px 8px 6px 12px;
    backdrop-filter: blur(12px);
    box-shadow:
      0 0 20px rgba(68, 136, 255, 0.15),
      inset 0 0 20px rgba(68, 136, 255, 0.05);
  }

  .voice-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(68, 136, 255, 0.1);
    border: 1px solid rgba(68, 136, 255, 0.3);
    color: #4488ff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .voice-btn:hover {
    background: rgba(68, 136, 255, 0.2);
    border-color: #4488ff;
  }

  .voice-btn.listening {
    background: rgba(255, 107, 107, 0.2);
    border-color: #ff6b6b;
    color: #ff6b6b;
    animation: pulse-listen 1.5s ease-in-out infinite;
  }

  @keyframes pulse-listen {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.4); }
    50% { box-shadow: 0 0 0 8px rgba(255, 107, 107, 0); }
  }

  .voice-preview {
    font-size: 13px;
    color: #4ade80;
    padding: 4px 8px;
    background: rgba(74, 222, 128, 0.1);
    border-radius: 6px;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .chat-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #e0e8ff;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    letter-spacing: 0.3px;
  }

  .chat-input::placeholder {
    color: rgba(136, 170, 255, 0.4);
  }

  .send-btn {
    background: rgba(68, 136, 255, 0.15);
    border: 1px solid rgba(68, 136, 255, 0.3);
    border-radius: 10px;
    padding: 8px;
    cursor: pointer;
    color: #4488ff;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .send-btn:hover:not(:disabled) {
    background: rgba(68, 136, 255, 0.3);
    border-color: rgba(68, 136, 255, 0.6);
    box-shadow: 0 0 12px rgba(68, 136, 255, 0.3);
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateX(-50%) translateY(10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
