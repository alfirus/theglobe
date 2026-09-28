<script lang="ts">
	/**
	 * The composer is only an underline with bracket ends — no filled box —
	 * sitting above the footer hints. Carries the mic (voice-first), the
	 * suggestion chips and the gold send control.
	 */
	let {
		disabled = false,
		onsend = () => {},
		onlisteningchange = () => {},
		onfocuschange = () => {}
	}: {
		disabled?: boolean;
		onsend?: (text: string) => void;
		onlisteningchange?: (listening: boolean) => void;
		onfocuschange?: (focused: boolean) => void;
	} = $props();

	let input = $state('');
	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let isListening = $state(false);
	let voiceText = $state('');
	let hasVoiceSupport = $state(false);
	let focused = $state(false);

	// Voice recognition — the final transcript leaves through the same `send`
	// path as typed input, so there is only one way to reach the model.
	let recognition: {
		start: () => void;
		stop: () => void;
		onresult: ((event: unknown) => void) | null;
		onerror: (() => void) | null;
		onend: (() => void) | null;
	} | null = null;

	if (typeof window !== 'undefined') {
		const SpeechRecognition =
			(window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
				.SpeechRecognition ??
			(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

		if (SpeechRecognition) {
			hasVoiceSupport = true;
			const Ctor = SpeechRecognition as new () => Record<string, unknown>;
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
					const finalText = transcript.trim();
					if (finalText) onsend(finalText);
					voiceText = '';
				}
			};
			instance['onerror'] = () => {
				setListening(false);
				voiceText = '';
			};
			instance['onend'] = () => {
				setListening(false);
				voiceText = '';
			};
			recognition = instance as unknown as typeof recognition;
		}
	}

	function setListening(value: boolean) {
		if (isListening === value) return;
		isListening = value;
		onlisteningchange(value);
	}

	function toggleVoice() {
		if (!recognition) return;
		if (isListening) {
			recognition.stop();
			setListening(false);
			voiceText = '';
		} else {
			try {
				recognition.start();
				setListening(true);
			} catch (err) {
				console.error('Speech recognition error:', err);
				setListening(false);
			}
		}
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
</script>

<div class="composer" class:focused>
	<div class="suggestions">
		{#each suggestions as suggestion (suggestion.label)}
			<button class="chip" onclick={() => applySuggestion(suggestion.label)} {disabled}>
				<span class="chip-glyph" aria-hidden="true">
					<svg
						viewBox="0 0 24 24"
						width="13"
						height="13"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
					>
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
		{#if isListening}
			<span class="listening">{voiceText ? `“${voiceText}”` : 'LISTENING…'}</span>
		{/if}
	</div>

	<div class="line">
		<span class="bracket left" aria-hidden="true"></span>

		{#if hasVoiceSupport}
			<button
				class="mic"
				class:recording={isListening}
				onclick={toggleVoice}
				title={isListening ? 'Stop listening' : 'Voice input'}
				aria-label={isListening ? 'Stop listening' : 'Voice input'}
			>
				<svg
					viewBox="0 0 24 24"
					width="16"
					height="16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				>
					<rect x="9" y="3" width="6" height="11" rx="3"></rect>
					<path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>
				</svg>
			</button>
		{/if}

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
			placeholder={isListening ? 'Listening…' : 'Message the Globe'}
			aria-label="Message the Globe"
			{disabled}
		/>

		<button
			class="send"
			onclick={submit}
			disabled={disabled || !input.trim()}
			title="Send"
			aria-label="Send message"
		>
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
			>
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
