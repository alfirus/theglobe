<script lang="ts">
	/**
	 * The composer is only an underline with bracket ends — no filled box —
	 * sitting above the footer hints. Carries the mic (voice-first), the
	 * suggestion chips and the gold send control.
	 *
	 * Voice has exactly one pipeline, in both engines:
	 *
	 *     final transcript → `input` → submit() → onsend(text)
	 *
	 * so what you spoke is always visible in the field before it leaves, and
	 * a transcript can only be lost by a failure the user is *told* about —
	 * every drop path sets `voiceError`, which renders in the label row and
	 * is mirrored to the page's ops log through `onvoiceerror` (P1-7).
	 *
	 * Engine choice (capability detection, no UA sniffing):
	 *   `web-speech` — the browser's SpeechRecognition (Chromium), primary;
	 *   `whisper`    — MediaRecorder → POST /api/stt (Firefox/Safari, and any
	 *                  browser without Web Speech) — the fallback;
	 *   `checking`   — no Web Speech, the /api/stt probe is in flight;
	 *   `none`       — no usable path; the mic says why when clicked.
	 */
	import { onMount } from 'svelte';

	let {
		disabled = false,
		onsend = () => {},
		onlisteningchange = () => {},
		onfocuschange = () => {},
		onvoiceerror = () => {}
	}: {
		disabled?: boolean;
		onsend?: (text: string) => void;
		onlisteningchange?: (listening: boolean) => void;
		onfocuschange?: (focused: boolean) => void;
		onvoiceerror?: (message: string) => void;
	} = $props();

	type VoiceMode = 'web-speech' | 'whisper' | 'checking' | 'none';

	let input = $state('');
	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let isListening = $state(false);
	let isTranscribing = $state(false);
	let voiceText = $state('');
	let voiceError = $state('');
	let voiceMode = $state<VoiceMode>('checking');
	let engineLabel = $state('');
	let sttReason = $state('');
	let focused = $state(false);

	// Voice recognition — the final transcript leaves through the same `send`
	// path as typed input, so there is only one way to reach the model.
	let recognition: {
		start: () => void;
		stop: () => void;
		onresult: ((event: unknown) => void) | null;
		onerror: ((event: unknown) => void) | null;
		onend: ((event: unknown) => void) | null;
	} | null = null;

	/** Web Speech failure codes → copy the user actually acts on. */
	function speechErrorText(code: unknown): string {
		switch (code) {
			case 'no-speech':
				return 'No speech was detected — nothing was sent.';
			case 'not-allowed':
			case 'service-not-allowed':
				return 'Microphone access was blocked by the browser — nothing was sent.';
			case 'audio-capture':
				return 'No microphone found — nothing was sent.';
			case 'network':
				return 'The speech service is unreachable — check your connection and try again.';
			case 'language-not-supported':
				return 'This language is not supported by the speech service.';
			case 'aborted':
				return '';
			default:
				return `Speech recognition failed${typeof code === 'string' && code ? ` (${code})` : ''} — nothing was sent.`;
		}
	}

	function reportError(message: string) {
		if (!message) return;
		voiceError = message;
		onvoiceerror(message);
	}

	/**
	 * The single pipeline: transcript → input → send. Empty text is a *visible*
	 * no-op (an error line), never a silent drop. When the composer is busy
	 * (`disabled`, a reply is streaming) `submit()` leaves the text in the
	 * field for the user to send — still not dropped.
	 */
	function commitTranscript(text: string) {
		const value = text.trim();
		if (!value) {
			reportError('Nothing was recognised — nothing was sent.');
			return;
		}
		input = value;
		submit();
	}

	function setListening(value: boolean) {
		if (isListening === value) return;
		isListening = value;
		onlisteningchange(value);
	}

	function buildRecognition(rawCtor: unknown) {
		const Ctor = rawCtor as new () => Record<string, unknown>;
		const instance = new Ctor();
		instance['continuous'] = false;
		instance['interimResults'] = true;
		instance['lang'] = 'en-US';
		instance['onresult'] = (event: {
			resultIndex: number;
			results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
		}) => {
			let transcript = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				transcript += event.results[i][0].transcript;
			}
			voiceText = transcript;
			const last = event.results[event.results.length - 1];
			if (last.isFinal) {
				voiceText = '';
				voiceError = '';
				commitTranscript(transcript);
			}
		};
		instance['onerror'] = (event: { error?: unknown }) => {
			setListening(false);
			voiceText = '';
			// A recognized failure must surface (P1-7): previously every error
			// silently cleared the state and the transcript vanished.
			reportError(speechErrorText(event?.error));
		};
		instance['onend'] = () => {
			setListening(false);
			voiceText = '';
		};
		recognition = instance as unknown as typeof recognition;
	}

	// ── fallback engine: record → POST /api/stt ──────────────────────────
	const MAX_RECORD_MS = 60_000;
	let mediaStream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	let chunks: BlobPart[] = [];
	let recordTimer: ReturnType<typeof setTimeout> | null = null;
	let requestingMic = false;

	function releaseMic() {
		mediaStream?.getTracks().forEach((track) => track.stop());
		mediaStream = null;
	}

	function pickMimeType(): string | undefined {
		const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
		for (const type of candidates) {
			if (MediaRecorder.isTypeSupported(type)) return type;
		}
		return undefined;
	}

	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = String(reader.result);
				resolve(result.slice(result.indexOf(',') + 1));
			};
			reader.onerror = () => reject(reader.error ?? new Error('could not read the recording'));
			reader.readAsDataURL(blob);
		});
	}

	async function startFallback() {
		if (requestingMic) return;
		if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
			reportError('This browser exposes no microphone API — nothing was sent.');
			return;
		}
		requestingMic = true;
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			mediaStream = null;
			reportError('Microphone access was denied — allow the mic and try again. Nothing was sent.');
			return;
		} finally {
			requestingMic = false;
		}

		if (typeof MediaRecorder === 'undefined') {
			releaseMic();
			reportError('This browser cannot record audio — nothing was sent.');
			return;
		}

		const mimeType = pickMimeType();
		try {
			recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
		} catch {
			releaseMic();
			reportError('Audio recording failed to start — nothing was sent.');
			return;
		}

		chunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) chunks.push(event.data);
		};
		recorder.onerror = () => {
			releaseMic();
			setListening(false);
			reportError('The recording failed — nothing was sent.');
		};
		recorder.onstop = () => {
			const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' });
			chunks = [];
			releaseMic();
			setListening(false);
			void transcribe(blob);
		};

		recorder.start();
		setListening(true);
		recordTimer = setTimeout(() => void stopFallback(), MAX_RECORD_MS);
	}

	async function stopFallback() {
		if (recordTimer) {
			clearTimeout(recordTimer);
			recordTimer = null;
		}
		if (recorder && recorder.state !== 'inactive') {
			recorder.stop(); // `onstop` hands the clip to transcribe()
		} else {
			releaseMic();
		}
	}

	async function transcribe(blob: Blob) {
		if (blob.size === 0) {
			reportError('No audio was captured — nothing was sent.');
			return;
		}
		isTranscribing = true;
		voiceError = '';
		try {
			const audio = await blobToBase64(blob);
			const language = (navigator.language ?? '').split('-')[0];
			const response = await fetch('/api/stt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ audio, mimeType: blob.type, language })
			});
			const data = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
			if (!response.ok) {
				throw new Error(data?.error || `Speech engine error (HTTP ${response.status})`);
			}
			commitTranscript(data?.text ?? '');
		} catch (err) {
			reportError(err instanceof Error && err.message ? err.message : 'Speech recognition failed — nothing was sent.');
		} finally {
			isTranscribing = false;
		}
	}

	/** No Web Speech: ask the server whether a local engine can take over. */
	async function probeServer() {
		try {
			const response = await fetch('/api/stt', { headers: { Accept: 'application/json' } });
			const data = (await response.json().catch(() => null)) as
				| { available?: boolean; engine?: string; reason?: string }
				| null;
			if (response.ok && data?.available) {
				voiceMode = 'whisper';
				engineLabel = data.engine === 'openai-whisper' ? 'WHISPER · TORCH' : 'WHISPER · LOCAL';
				sttReason = '';
			} else {
				voiceMode = 'none';
				sttReason = data?.reason || 'No speech engine on the server.';
			}
		} catch {
			voiceMode = 'none';
			sttReason = 'The Glob server is unreachable, so the local speech engine cannot start.';
		}
	}

	onMount(() => {
		const win = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
		const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
		if (Ctor) {
			voiceMode = 'web-speech';
			engineLabel = 'WEB SPEECH';
			buildRecognition(Ctor);
		} else if (
			typeof navigator.mediaDevices?.getUserMedia === 'function' &&
			typeof MediaRecorder !== 'undefined'
		) {
			void probeServer();
		} else {
			voiceMode = 'none';
			sttReason = 'This browser offers no speech recognition and no microphone recorder.';
		}
	});

	function toggleVoice() {
		if (isTranscribing) return;
		if (isListening) {
			if (voiceMode === 'whisper') {
				void stopFallback();
			} else if (recognition) {
				recognition.stop();
				setListening(false);
				voiceText = '';
			}
			return;
		}

		voiceError = '';
		if (voiceMode === 'web-speech' && recognition) {
			try {
				recognition.start();
				setListening(true);
			} catch {
				reportError('Speech recognition could not start — nothing was sent.');
			}
			return;
		}
		if (voiceMode === 'whisper') {
			void startFallback();
			return;
		}
		if (voiceMode === 'checking') {
			reportError('Still checking the local speech engine — try again in a moment.');
			return;
		}
		reportError(sttReason || 'Voice input is unavailable in this browser.');
	}

	function submit() {
		const text = input.trim();
		if (!text || disabled) return;
		onsend(text);
		input = '';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	function applySuggestion(text: string) {
		input = text;
		inputEl?.focus();
	}

	/** The icon rail (and ⌘-keys) can request focus from anywhere. */
	function focusFromChrome() {
		inputEl?.focus();
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('glob:focus-composer', focusFromChrome);
		return () => window.removeEventListener('glob:focus-composer', focusFromChrome);
	});

	// Quick-action glyphs: inline SVG, one stroke weight, plain white — never
	// emoji and never a coloured text character (owner icon standard).
	const suggestions: { label: string; glyph: 'reticle' | 'refresh' | 'rows' }[] = [
		{ label: 'Watch cluster 07', glyph: 'reticle' },
		{ label: 'Summarise the last hour', glyph: 'refresh' },
		{ label: 'Compare to yesterday', glyph: 'rows' }
	];

	const micTitle = $derived(
		isListening
			? 'Stop listening'
			: voiceMode === 'web-speech'
				? 'Voice input (browser speech recognition)'
				: voiceMode === 'whisper'
					? 'Voice input (local Whisper on the server)'
					: voiceMode === 'checking'
						? 'Voice input — checking the local speech engine…'
						: `Voice input unavailable — ${sttReason || 'no speech engine'}`
	);

	const placeholder = $derived(
		isListening
			? voiceMode === 'whisper'
				? 'Recording…'
				: 'Listening…'
			: isTranscribing
				? 'Transcribing…'
				: 'Message the Globe'
	);

	const statusText = $derived(
		isTranscribing
			? 'TRANSCRIBING…'
			: isListening
				? voiceMode === 'whisper'
					? 'RECORDING…'
					: voiceText
						? `“${voiceText}”`
						: 'LISTENING…'
				: ''
	);
</script>

<div class="composer" class:focused>
	<div class="suggestions">
		{#each suggestions as suggestion (suggestion.label)}
			<button class="chip" onclick={() => applySuggestion(suggestion.label)} {disabled}>
				<span class="chip-glyph" aria-hidden="true">
					<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6">
						{#if suggestion.glyph === 'reticle'}
							<circle cx="12" cy="12" r="7.5"></circle>
							<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"></circle>
						{:else if suggestion.glyph === 'refresh'}
							<path d="M20 12a8 8 0 1 1-2.5-5.8"></path>
							<path d="M20 4.5V10h-5.4"></path>
						{:else}
							<rect x="4" y="5.5" width="16" height="5"></rect>
							<rect x="4" y="13.5" width="16" height="5"></rect>
						{/if}
					</svg>
				</span>
				{suggestion.label}
			</button>
		{/each}
	</div>

	<div class="label-row">
		<span class="hud-label">INPUT · VOICE PRIMARY</span>
		{#if voiceError}
			<span class="voice-error" role="status" aria-live="polite">{voiceError}</span>
		{:else if statusText}
			<span class="listening">{statusText}</span>
		{:else if engineLabel}
			<span class="engine" title={micTitle}>{engineLabel}</span>
		{/if}
	</div>

	<div class="line">
		<span class="bracket left" aria-hidden="true"></span>

		<button
			class="mic"
			class:recording={isListening}
			class:unavailable={voiceMode === 'none'}
			class:pending={voiceMode === 'checking' || isTranscribing}
			onclick={toggleVoice}
			title={micTitle}
			aria-label={micTitle}
		>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<rect x="9" y="3" width="6" height="11" rx="3"></rect>
				<path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>
			</svg>
		</button>

		<input
			bind:this={inputEl}
			bind:value={input}
			onkeydown={handleKeydown}
			onfocus={() => {
				focused = true;
				onfocuschange(true);
			}}
			onblur={() => {
				focused = false;
				onfocuschange(false);
			}}
			type="text"
			placeholder={placeholder}
			aria-label="Message the Globe"
			disabled={disabled}
			oninput={() => {
				if (voiceError) voiceError = '';
			}}
		/>

		<button class="send" onclick={submit} disabled={disabled || !input.trim()} title="Send">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
				<path d="M12 19V5M6 11l6-6 6 6"></path>
			</svg>
		</button>

		<span class="bracket right" aria-hidden="true"></span>
	</div>

	<div class="hints">
		    <span class="hint">THE GLOBE · ambient listening armed</span>
		<span class="hint keys">⌘K CONVERSATIONS · ⌘, SETTINGS</span>
	</div>
</div>

<style>
	.composer {
		position: fixed;
		left: 50%;
		transform: translateX(-50%);
		bottom: 58px;
		width: min(720px, calc(100vw - 260px));
		z-index: 55;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.suggestions {
		display: flex;
		justify-content: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-hud);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.8px;
		color: #cfe9f7;
		background: transparent;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-full);
		padding: 4px 12px;
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			color 0.2s ease,
			box-shadow 0.2s ease;
	}
	.chip:hover:not(:disabled) {
		border-color: var(--hud-line-strong);
		color: var(--hud-cyan);
		box-shadow: 0 0 10px rgba(125, 249, 255, 0.25);
	}
	.chip:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.chip-glyph {
		display: flex;
		/* Chip glyphs are icons → plain white (the chip label keeps its colour) */
		color: #ffffff;
		font-size: 11px;
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 18px;
	}

	.listening {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--hud-cyan);
		max-width: 50%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Which voice engine this browser is using — the affordance for the
	 * Web Speech → Whisper handover (P1-7). Idle only; status/error take
	 * the same slot while they matter. */
	.engine {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.6px;
		color: var(--hud-steel);
		opacity: 0.85;
		white-space: nowrap;
	}

	/* Every voice failure lands here (never only in the console). */
	.voice-error {
		font-family: var(--font-mono);
		font-size: 10.5px;
		line-height: 1.35;
		color: #ff9a9a;
		max-width: 65%;
		text-align: right;
		overflow-wrap: anywhere;
	}

	/* The line: bracket ends, mic, text, send — an underline, not a box */
	.line {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 4px 9px;
		border-bottom: 1px solid var(--hud-line-strong);
		transition:
			border-color 0.25s ease,
			box-shadow 0.25s ease;
	}
	.composer.focused .line {
		border-color: var(--hud-cyan);
		box-shadow: 0 10px 18px -14px rgba(125, 249, 255, 0.8);
	}

	.bracket {
		width: 10px;
		height: 18px;
		border: 1.5px solid var(--hud-cyan);
		opacity: 0.75;
		flex-shrink: 0;
	}
	.bracket.left {
		border-right: 0;
	}
	.bracket.right {
		border-left: 0;
	}

	.mic {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--hud-line);
		border-radius: var(--r-full);
		/* The mic glyph stays plain white in every state; the border carries
		 * the recording signal (owner icon standard). */
		color: #ffffff;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			border-color 0.2s ease,
			color 0.2s ease;
	}
	.mic:hover {
		border-color: var(--hud-line-strong);
	}
	.mic.recording {
		border-color: rgba(255, 107, 107, 0.6);
		animation: mic-pulse 1.5s ease-in-out infinite;
	}
	/* Engine still being probed, or a clip being transcribed. */
	.mic.pending {
		opacity: 0.6;
		cursor: progress;
	}
	/* Mic stays visible so the user can click it and be told *why* voice is
	 * unavailable — an invisible control explains nothing. */
	.mic.unavailable {
		opacity: 0.45;
		border-style: dashed;
	}

	@keyframes mic-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.4);
		}
		50% {
			box-shadow: 0 0 0 6px rgba(255, 107, 107, 0);
		}
	}

	input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		color: #eaf7ff;
		font-family: var(--font-body);
		font-size: 15px;
		letter-spacing: 0.3px;
	}
	input::placeholder {
		color: rgba(110, 147, 180, 0.75);
	}
	input:disabled {
		opacity: 0.5;
	}

	.send {
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--hud-line-gold);
		border-radius: var(--r-full);
		/* Send arrow is an icon → plain white; the gold ring marks it as the action */
		color: #ffffff;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.2s ease,
			box-shadow 0.2s ease,
			opacity 0.2s ease;
	}
	.send:hover:not(:disabled) {
		background: rgba(255, 193, 77, 0.15);
		box-shadow: 0 0 14px rgba(255, 193, 77, 0.45);
	}
	.send:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.hints {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 18px;
		gap: 16px;
	}

	.hint {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.6px;
		color: var(--hud-steel);
		opacity: 0.85;
	}
	.keys {
		white-space: nowrap;
	}

	@media (max-width: 980px) {
		.composer {
			width: calc(100vw - 120px);
		}
	}
	@media (max-width: 720px) {
		.composer {
			width: calc(100vw - 32px);
			left: 16px;
			transform: none;
			bottom: 24px;
		}
		.suggestions {
			justify-content: flex-start;
		}
		.hint.keys {
			display: none;
		}
	}
</style>
