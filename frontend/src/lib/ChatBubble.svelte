<script module lang="ts">
  import DOMPurify from 'dompurify';
  import { logEvent } from '$lib/log';

  /**
   * DOMPurify whitelists `data:` URIs for a few tags (`img`, `audio`, `video`, …)
   * *in addition to* `ALLOWED_URI_REGEXP`, so `![x](data:image/svg+xml;base64,…)`
   * would otherwise sail through sanitisation. Such images are inert inside an
   * `<img>`, but the security review asks for every `data:`/`javascript:` URL to
   * be gone, so they are stripped here as well. The hook is installed once per
   * page because `DOMPurify` is a module-level singleton and repeated installs
   * would stack up.
   */
  const hookState = globalThis as typeof globalThis & { __globePurifyHooked?: boolean };
  if (
    !hookState.__globePurifyHooked &&
    typeof document !== 'undefined' &&
    typeof DOMPurify.addHook === 'function'
  ) {
    hookState.__globePurifyHooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
      if (!node || node.nodeType !== 1) return;
      for (const attr of ['src', 'href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value && /^\s*(?:data|javascript|vbscript):/i.test(value)) node.removeAttribute(attr);
      }
    });
  }
</script>

<script lang="ts">
  import { marked } from 'marked';
  import { createEventDispatcher } from 'svelte';

  /**
   * The classified failure riding on a turn (P1-2). Mirrors the fields of
   * `ChatError` the UI is allowed to show — `code`/`status`/`upstream`/`reason`
   * stay in the logs, never in the bubble.
   */
  export type MessageError = {
  	title: string;
  	detail: string;
  	retryable: boolean;
  };

  export type Message = {
  	/** Client-only identity used to target the right bubble while streaming (see +page.svelte). */
  	id?: string;
  	role: 'user' | 'assistant';
  	text: string;
  	/** Client-only timestamp — the Visor HUD prints it in the turn header. */
  	ts?: number;
  	/** Set from Send until the first byte: renders the pending skeleton. */
  	pending?: boolean;
  	/** Present when this turn ended in a classified failure — drives the error box. */
  	error?: MessageError;
  };

  let { message }: { message: Message } = $props();
  let bubbleRef: HTMLDivElement;

  // Retry dispatches a custom event so the parent can walk back to this message's user prompt
  const retryDispatch = createEventDispatcher<{ retry: { messageId: string } }>();

  function handleRetry() {
    if (message.id) {
      retryDispatch('retry', { messageId: message.id });
    }
  }

  /**
   * Sanitizer configuration for rendered markdown.
   *
   * `marked` passes raw HTML through untouched, so everything it produces has to
   * survive this before it is injected with `{@html}`. The explicit allow-lists
   * are what make the hostile payloads inert: `<img src=x onerror=…>` loses the
   * handler attribute (no `on*` is ever allow-listed), `<iframe …>` is not a
   * permitted tag at all, and `[x](javascript:…)` loses its `href` because the
   * URI allow-list only accepts http(s)/mailto/tel/ftp and relative URLs — no
   * `javascript:`, no `data:`. `data:` URIs that DOMPurify whitelists for images
   * by default are removed by the module-level hook above.
   */
  const SANITIZE_OPTIONS = {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'blockquote', 'pre', 'code',
      'em', 'strong', 'del', 's', 'sub', 'sup', 'mark',
      'ul', 'ol', 'li',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td'
    ],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'target', 'rel'],
    FORBID_TAGS: [
      'style', 'script', 'iframe', 'object', 'embed', 'form', 'input',
      'button', 'textarea', 'select', 'option', 'svg', 'math', 'frame'
    ],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  };

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Render markdown, then sanitize before it ever reaches {@html}.
  function renderMarkdown(text: string): string {
    // No DOM (SSR) → plain escaped text, never unsanitized HTML.
    if (typeof window === 'undefined') return escapeHtml(text);

    try {
      const html = marked.parse(text, { async: false, breaks: true, gfm: true });
      return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
    } catch (err) {
      // Returning the raw text here would reopen the injection hole — escape it.
      logEvent('render', 'markdown_failed', { errName: err instanceof Error ? err.name : String(err) }, 'warn');
      return escapeHtml(text);
    }
  }
</script>

<div class="message {message.role}">
  <span class="role">{message.role === 'user' ? 'You' : 'Globe'}</span>
  {#if message.pending}
    <!-- Send-time placeholder: three pulsing dots until the first byte lands. -->
    <div class="skeleton" role="status" aria-label="Generating a reply">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
  {:else if message.role === 'assistant'}
    <div class="text markdown-content">{@html renderMarkdown(message.text)}</div>
    {#if message.error}
      <!-- Classified failure: its own title + detail, and a Retry only when
           the class is actually retryable (P1-2 / QA-11-01). -->
      <div class="error-box" role="alert">
        <span class="error-title">{message.error.title}</span>
        <span class="error-detail">{message.error.detail}</span>
        {#if message.error.retryable}
          <button type="button" class="retry-btn" onclick={handleRetry} title="Send this message again">
            Retry
          </button>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- Svelte escapes interpolated text, so this renders inert by construction. -->
    <div class="text plain-text">{message.text}</div>
  {/if}
</div>

<style>
  .message {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(68, 136, 255, 0.08);
    animation: fadeIn 0.3s ease-out;
  }

  .message:last-child {
    border-bottom: none;
  }

  .role {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .message.user .role {
    color: rgba(68, 136, 255, 0.6);
  }

  .message.assistant .role {
    color: rgba(100, 180, 255, 0.5);
  }

  .text {
    font-size: 13px;
    line-height: 1.6;
    color: #c0d4ff;
    text-align: left;
    word-wrap: break-word;
  }

  /* Markdown styling */
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3) {
    color: #e0e8ff;
    margin: 16px 0 8px 0;
    font-weight: 600;
  }

  .markdown-content :global(h1) { font-size: 20px; }
  .markdown-content :global(h2) { font-size: 17px; }
  .markdown-content :global(h3) { font-size: 15px; }

  .markdown-content :global(p) {
    margin: 8px 0;
  }

  .markdown-content :global(strong) {
    color: #e0e8ff;
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
    color: #a0b4dd;
  }

  .markdown-content :global(code) {
    background: rgba(68, 136, 255, 0.1);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    color: #88aaff;
  }

  .markdown-content :global(pre) {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(68, 136, 255, 0.2);
    border-radius: 8px;
    padding: 12px;
    margin: 12px 0;
    overflow-x: auto;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 8px 0;
    padding-left: 24px;
  }

  .markdown-content :global(li) {
    margin: 4px 0;
  }

  .markdown-content :global(blockquote) {
    border-left: 3px solid rgba(68, 136, 255, 0.4);
    padding-left: 12px;
    margin: 8px 0;
    color: #a0b4dd;
    font-style: italic;
  }

  .markdown-content :global(a) {
    color: #4488ff;
    text-decoration: underline;
  }

  .markdown-content :global(hr) {
    border: none;
    border-top: 1px solid rgba(68, 136, 255, 0.2);
    margin: 16px 0;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Pending skeleton (P1-2) */
  .skeleton {
    display: flex;
    gap: 4px;
    padding: 8px 0;
  }

  .skeleton .dot {
    width: 6px;
    height: 6px;
    background: rgba(68, 136, 255, 0.4);
    border-radius: 50%;
    animation: pulse 1.2s ease-in-out infinite;
  }

  .skeleton .dot:nth-child(2) { animation-delay: 0.2s; }
  .skeleton .dot:nth-child(3) { animation-delay: 0.4s; }

  /* Error bubble (P1-2) */
  .error-box {
    padding: 8px 12px;
    background: rgba(255, 107, 107, 0.08);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 8px;
    margin-top: 4px;
  }

  .error-title {
    font-size: 13px;
    font-weight: 600;
    color: #ff6b6b;
    display: block;
  }

  .error-detail {
    font-size: 12px;
    color: #c0d4ff;
    margin: 4px 0 8px 0;
    line-height: 1.5;
  }

  .retry-btn {
    padding: 4px 12px;
    background: rgba(255, 107, 107, 0.15);
    border: 1px solid rgba(255, 107, 107, 0.5);
    border-radius: 6px;
    color: #ff6b6b;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .retry-btn:hover {
    background: rgba(255, 107, 107, 0.3);
    box-shadow: 0 0 12px rgba(255, 107, 107, 0.3);
  }

  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1.2); }
  }
</style>
