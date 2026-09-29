import { createSplitter } from './ttsSplit';

/**
 * Streaming TTS client: feed it the reply as it arrives, it synthesises each
 * sentence as soon as it is complete and plays the results from an ordered
 * queue (P1-4).
 *
 * Three independent moving parts, deliberately decoupled:
 *
 *   chat deltas → `TtsSplitter` (complete sentences, markdown stripped)
 *              → synthesis queue (≤ 2 in flight, matching `TTS_MAX_CONCURRENT`)
 *              → playback queue (strictly in index order, hard-cut handoff)
 *
 * Synthesis runs *while* the reply streams, so the first sentence is already
 * being spoken when the model is still writing paragraph three, and a long
 * reply no longer stalls for tens of seconds at the end. Chunk N can finish
 * before N-1 when two are in flight, so playback holds a `Map` keyed by index
 * and only ever plays the next expected one — audio order is stable even
 * though synthesis order is not.
 *
 * Interruption: `stop()` aborts every in-flight request (the server kills the
 * engine process on disconnect), drops both queues, stops playback and revokes
 * every blob URL, so stop-generation is silent immediately and nothing keeps
 * running in the background.
 *
 * Every URL handed out is revoked — on completion, on error and on stop. L1
 * was exactly this leak in the whole-reply path.
 */

/** Client-side in-flight cap: mirrors the server's default concurrency slot. */
const MAX_INFLIGHT = 2;
/** Synthesis budget for one sentence — matches the client's `/api/tts` budget. */
const REQUEST_TIMEOUT_MS = 130_000;
/** No boundary for this long while the reply stalls → speak at a clause break. */
const STALL_MS = 2_000;

export type TtsOutcome =
	/** Every chunk synthesised and played to the end. */
	| 'played'
	/** The stream route is unusable (404/503/…) — caller should fall back. */
	| 'unavailable'
	/** Stopped by the user before anything played. */
	| 'stopped'
	/** Nothing to speak (empty reply / no utterances produced). */
	| 'silent';

export interface TtsStreamCallbacks {
	/** Globe/HUD speaking state — true from first play to last end. */
	onSpeaking?: (speaking: boolean) => void;
	/** First audio frame reached the browser, ms since `begin()`. */
	onFirstFrame?: (ms: number) => void;
	/** First chunk became audible, ms since `begin()` — the BLUEPRINT metric. */
	onFirstAudio?: (ms: number) => void;
	/** A sentence finished synthesising (index, ms since `begin()`). */
	onChunk?: (index: number, ms: number) => void;
	/** Non-fatal failure; the message already names the fix. */
	onError?: (message: string) => void;
}

interface Job {
	index: number;
	text: string;
}

interface Ready {
	url: string;
}

type Frame = {
	index?: unknown;
	contentType?: unknown;
	audio?: unknown;
	error?: unknown;
};

export class TtsStream {
	private readonly callbacks: TtsStreamCallbacks;
	private splitter = createSplitter();
	private jobs: Job[] = [];
	private ready = new Map<number, Ready>();
	private nextJob = 0;
	private nextPlay = 0;
	private inFlight = 0;
	private current: HTMLAudioElement | null = null;
	private currentUrl: string | null = null;
	private abortCtl: AbortController | null = null;
	private stallTimer: ReturnType<typeof setTimeout> | null = null;
	private startedAt = 0;
	private delivered = 0;
	private routeUnavailable = false;
	private stopped = false;
	private finishing = false;
	private settled = false;
	private waiters: ((outcome: TtsOutcome) => void)[] = [];

	constructor(callbacks: TtsStreamCallbacks = {}) {
		this.callbacks = callbacks;
	}

	/** Reset for a new reply. Call `stop()` first if one is still running. */
	begin(): void {
		this.reset();
		// One controller for every request this reply starts — `stop()` aborts
		// it, and each `synthesize` links its own timeout to it.
		this.abortCtl = new AbortController();
		this.startedAt = performance.now();
	}

	/** Feed a chat delta. Completed sentences start synthesising immediately. */
	push(delta: string): void {
		if (this.stopped || !delta) return;
		for (const text of this.splitter.push(delta)) this.enqueue(text);
		this.armStallTimer();
	}

	/**
	 * The reply ended. Flushes the trailing sentence and resolves once
	 * everything has been synthesised *and* played — callers hang the `speak`
	 * lifecycle step on it.
	 */
	finish(): Promise<TtsOutcome> {
		if (this.settled) return Promise.resolve(this.outcome());
		if (!this.finishing && !this.stopped) {
			this.finishing = true;
			for (const text of this.splitter.flush()) this.enqueue(text);
			this.clearStallTimer();
		}
		if (this.stopped) {
			this.settle();
			return Promise.resolve(this.outcome());
		}
		if (this.waiters.length === 0 && this.isIdle()) {
			this.settle();
			return Promise.resolve(this.outcome());
		}
		return new Promise<TtsOutcome>((resolve) => this.waiters.push(resolve));
	}

	/** Stop everything: in-flight requests, queued work, playback, blob URLs. */
	stop(): void {
		if (this.stopped && this.settled) return;
		this.stopped = true;
		this.abortCtl?.abort();
		this.abortCtl = null;
		this.clearStallTimer();
		this.jobs = [];
		for (const item of this.ready.values()) URL.revokeObjectURL(item.url);
		this.ready.clear();
		this.releaseCurrent();
		this.callbacks.onSpeaking?.(false);
		this.settle();
	}

	/** How many sentences are waiting to be synthesised (diagnostics/tests). */
	get queued(): number {
		return this.jobs.length + this.inFlight;
	}

	// ── synthesis ────────────────────────────────────────────────────────

	private enqueue(text: string): void {
		this.jobs.push({ index: this.nextJob++, text });
		this.pump();
	}

	private pump(): void {
		while (!this.stopped && this.inFlight < MAX_INFLIGHT && this.jobs.length > 0) {
			const job = this.jobs.shift()!;
			this.inFlight += 1;
			void this.synthesize(job).finally(() => {
				this.inFlight -= 1;
				this.pump();
				this.maybeSettle();
			});
		}
		this.maybeSettle();
	}

	private async synthesize(job: Job): Promise<void> {
		const control = new AbortController();
		const onAbort = (): void => control.abort();
		// One controller per reply: `stop()` aborts it, and that abort reaches
		// every request in flight, which is what makes stop-generation instant.
		this.abortCtl?.signal.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);

		try {
			const response = await fetch('/api/tts/stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: job.text, index: job.index }),
				signal: control.signal
			});

			if (!response.ok) {
				const detail = (await response.text().catch(() => '')).trim();
				// A preflight 503/404 means the whole route is unusable, which is
				// the one case worth falling back to the whole-reply endpoint.
				if (response.status >= 500 || response.status === 404) this.routeUnavailable = true;
				this.fail(detail || `TTS stream HTTP ${response.status}`);
				return;
			}

			await this.readFrames(response, job.index);
		} catch (err) {
			if (this.stopped || this.abortCtl?.signal.aborted) return;
			if (control.signal.aborted) {
				this.fail('TTS request timed out');
				return;
			}
			this.fail(err instanceof Error && err.message ? err.message : 'TTS request failed');
		} finally {
			clearTimeout(timer);
			this.abortCtl?.signal.removeEventListener('abort', onAbort);
		}
	}

	/** Parse the SSE body: one audio frame per chunk, then `data: [DONE]`. */
	private async readFrames(response: Response, fallbackIndex: number): Promise<void> {
		const body = response.body;
		if (!body) {
			this.fail('TTS stream returned no body');
			return;
		}
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const before = this.delivered;
		let reported = false;

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const data = line.slice(6).trim();
				if (data === '[DONE]') continue;

				let frame: Frame;
				try {
					frame = JSON.parse(data) as Frame;
				} catch {
					continue; // malformed frame — keep the stream alive
				}

				if (typeof frame.error === 'string' && frame.error) {
					reported = true;
					this.fail(frame.error);
					continue;
				}
				if (typeof frame.audio !== 'string' || !frame.audio) continue;

				const index =
					typeof frame.index === 'number' && Number.isInteger(frame.index)
						? frame.index
						: fallbackIndex;
				const contentType = typeof frame.contentType === 'string' ? frame.contentType : 'audio/wav';
				this.accept(index, frame.audio, contentType);
			}
		}

		// A connection that dies between headers and the first frame otherwise
		// looks like "the reply had nothing to say" — say so instead.
		if (!this.stopped && !reported && this.delivered === before) {
			this.fail('TTS stream closed without audio');
		}
	}

	private accept(index: number, base64: string, contentType: string): void {
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			const binary = atob(base64);
			// Explicit ArrayBuffer (not a bare Uint8Array) so the Blob part type
			// can never widen to SharedArrayBuffer under TS 6's lib defaults.
			bytes = new Uint8Array(new ArrayBuffer(binary.length));
			for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		} catch {
			this.fail('TTS stream returned unreadable audio');
			return;
		}

		const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
		this.ready.set(index, { url });
		this.delivered += 1;

		const ms = performance.now() - this.startedAt;
		if (this.delivered === 1) this.callbacks.onFirstFrame?.(ms);
		this.callbacks.onChunk?.(index, ms);

		this.playNext();
		this.maybeSettle();
	}

	private fail(message: string): void {
		this.callbacks.onError?.(message);
	}

	// ── playback ─────────────────────────────────────────────────────────

	/** Play the lowest-numbered chunk that has arrived. Ordered, never racing. */
	private playNext(): void {
		if (this.stopped || this.current) return;
		const next = this.ready.get(this.nextPlay);
		if (!next) return;

		this.ready.delete(this.nextPlay);
		this.nextPlay += 1;

		const url = next.url;
		const audio = new Audio(url);
		this.current = audio;
		this.currentUrl = url;
		this.callbacks.onSpeaking?.(true);

		let announced = false;
		audio.addEventListener(
			'playing',
			() => {
				if (announced) return;
				announced = true;
				this.callbacks.onFirstAudio?.(performance.now() - this.startedAt);
			},
			{ once: true }
		);
		audio.addEventListener('ended', () => this.retireCurrent(url));
		audio.addEventListener('error', () => {
			this.fail('TTS playback failed');
			this.retireCurrent(url);
		});

		audio.play().catch(() => {
			// Autoplay policy or a decode failure: skip this chunk rather than
			// wedging the queue behind an element that will never play.
			this.fail('TTS playback was blocked by the browser');
			this.retireCurrent(url);
		});
	}

	private retireCurrent(url: string): void {
		if (this.currentUrl !== url) return; // already replaced or stopped
		this.releaseCurrent();
		this.playNext();
		this.maybeSettle();
	}

	private releaseCurrent(): void {
		const audio = this.current;
		const url = this.currentUrl;
		this.current = null;
		this.currentUrl = null;
		if (audio) {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		}
		if (url) URL.revokeObjectURL(url);
	}

	// ── stall timer ──────────────────────────────────────────────────────

	/**
	 * The model sometimes goes quiet mid-sentence. After `STALL_MS` of no
	 * boundary, speak what we have at the last clause break instead of holding
	 * the first audible chunk hostage to a pause.
	 */
	private armStallTimer(): void {
		if (this.stallTimer || this.stopped || this.splitter.pending === 0) return;
		this.stallTimer = setTimeout(() => {
			this.stallTimer = null;
			const text = this.splitter.nudge();
			if (text) this.enqueue(text);
			this.armStallTimer();
		}, STALL_MS);
	}

	private clearStallTimer(): void {
		if (this.stallTimer !== null) {
			clearTimeout(this.stallTimer);
			this.stallTimer = null;
		}
	}

	// ── completion ───────────────────────────────────────────────────────

	private isIdle(): boolean {
		return this.jobs.length === 0 && this.inFlight === 0 && this.ready.size === 0 && !this.current;
	}

	private outcome(): TtsOutcome {
		// A stop outranks everything: whatever played already played, and the
		// caller must not mistake it for a completed reply (or fall back).
		if (this.stopped) return 'stopped';
		if (this.delivered === 0) return this.routeUnavailable ? 'unavailable' : 'silent';
		return 'played';
	}

	private maybeSettle(): void {
		if (!this.finishing || this.settled) return;
		if (this.stopped || this.isIdle()) this.settle();
	}

	private settle(): void {
		if (this.settled) return;
		// A late frame can arrive after `stop()`; the queue is already cleared.
		if (!this.stopped && this.finishing && !this.isIdle()) return;
		this.settled = true;
		this.clearStallTimer();
		const outcome = this.outcome();
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve(outcome);
	}

	private reset(): void {
		this.stop();
		this.splitter = createSplitter();
		this.jobs = [];
		this.ready.clear();
		this.nextJob = 0;
		this.nextPlay = 0;
		this.inFlight = 0;
		this.delivered = 0;
		this.routeUnavailable = false;
		this.stopped = false;
		this.finishing = false;
		this.settled = false;
		this.waiters = [];
		this.startedAt = 0;
	}
}
