import type { RequestHandler } from './$types';
import { assertApiRequest, readSettings, resolveTtsTimeoutMs } from '$lib/config';
import {
	MAX_TTS_STREAM_TEXT,
	TTS_STREAM_CHUNK_TEXT,
	chunkText,
	isTtsAbort,
	preflightTts,
	synthesizeChunk,
	ttsErrorMessage
} from '$lib/server/tts';

/**
 * POST /api/tts/stream — synthesise one sentence at a time, framed exactly like
 * `POST /api/chat` (SSE), so the client can speak a reply while it is still
 * streaming in instead of waiting for the whole thing to be generated (P1-4,
 * BLUEPRINT TTS latency < 2 s first chunk).
 *
 * Request:  `{ "text": "<one utterance>", "index": <n> }`
 * Response: `data: {"index":n,"contentType":"audio/wav","audio":"<base64>"}`
 *           …one frame per synthesised sub-chunk, as it completes…
 *           `data: [DONE]`
 *           or `data: {"index":n,"error":"<engine message>"}` before `[DONE]`.
 *
 * Why one request per sentence rather than a client-pumped text stream: a
 * streaming request body needs `fetch(..., { duplex: 'half' })`, which not every
 * browser the owner may run supports — a plain JSON POST plus an SSE response
 * degrades to "one round trip per sentence" everywhere instead of failing
 * outright, and the server still owns concurrency.
 *
 * Concurrency: each sub-chunk takes a slot from the shared `TTS_MAX_CONCURRENT`
 * (default 2) pool in `$lib/server/tts`, so a burst of sentence requests queues
 * instead of spawning a process each — the client keeps at most two in flight
 * for the same reason.
 *
 * Interruption: aborting the fetch (stop-generation) aborts `request.signal`,
 * which kills the running engine process and drops queued work, so silence is
 * immediate and no piper keeps running to the end of its budget.
 *
 * Preflight failures (no model, no key, disallowed URL) return a normal HTTP
 * status *before* the SSE starts, which is what lets the client fall back to
 * the whole-reply `POST /api/tts`.
 */
export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: { text?: unknown; index?: unknown };
	try {
		body = (await request.json()) as { text?: unknown; index?: unknown };
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { text, index } = body;
	if (typeof text !== 'string' || text.trim().length === 0) {
		return new Response('Text is required', { status: 400 });
	}
	if (text.length > MAX_TTS_STREAM_TEXT) {
		return new Response(`Text exceeds maximum length (${MAX_TTS_STREAM_TEXT})`, { status: 400 });
	}
	const baseIndex =
		typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 1_000_000
			? index
			: 0;

	const settings = readSettings();
	// Before committing to an SSE response: a 503 here is a real status the
	// client can branch on, where an error frame inside the stream is not.
	const pre = preflightTts(settings);
	if (pre) return new Response(pre.message, { status: pre.status });

	const timeoutMs = resolveTtsTimeoutMs();
	// A well-behaved client sends one sentence (one chunk); the split only
	// guards a client that posts a paragraph, and keeps frames sentence-sized.
	const chunks = chunkText(text, TTS_STREAM_CHUNK_TEXT);
	if (chunks.length === 0) {
		return new Response('Text is required', { status: 400 });
	}

	// One cancellation source for both disconnect paths: `request.signal` when
	// the runtime reports it, and the stream's own `cancel()` when it does not.
	const cancel = new AbortController();
	const onCancel = (): void => cancel.abort();
	request.signal.addEventListener('abort', onCancel, { once: true });

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (payload: unknown): void => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				} catch {
					/* client already gone — cancellation does the rest */
				}
			};
			try {
				for (let i = 0; i < chunks.length; i++) {
					if (cancel.signal.aborted) break;
					const { audio, contentType } = await synthesizeChunk({
						text: chunks[i],
						settings,
						timeoutMs,
						signal: cancel.signal
					});
					send({ index: baseIndex + i, contentType, audio: audio.toString('base64') });
				}
			} catch (err) {
				// An abort is the client's own stop button: silence, no error.
				if (!isTtsAbort(err)) {
					console.error('TTS stream error:', ttsErrorMessage(err));
					send({ index: baseIndex, error: ttsErrorMessage(err) });
				}
			} finally {
				request.signal.removeEventListener('abort', onCancel);
				try {
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					controller.close();
				} catch {
					/* cancelled before we got here */
				}
			}
		},
		cancel() {
			cancel.abort();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
