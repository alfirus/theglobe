import type { RequestHandler } from './$types';
import { assertApiRequest, readSettings, resolveTtsTimeoutMs } from '$lib/config';
import {
	MAX_TTS_TEXT,
	chunkText,
	concatWav,
	preflightTts,
	synthesizeChunk,
	ttsErrorResponse
} from '$lib/server/tts';

/**
 * POST /api/tts — synthesise a whole reply with the configured TTS engine and
 * return one audio blob.
 *
 * The engine table, the security contract (text never reaches a shell, never
 * enters `argv` for stdin-capable engines) and every engine's failure message
 * live in `$lib/server/tts`; this file is only the HTTP shape:
 * validate → preflight → chunk → synthesise sequentially → concatenate.
 *
 * P1-4 note: every chunk goes through the shared concurrency slot, so a
 * whole-reply request and a streaming session never run more than
 * `TTS_MAX_CONCURRENT` engine processes between them. Budget per chunk is the
 * global `TTS_TIMEOUT_MS` split across the remaining chunks (D5 — the old
 * hard-coded 30 s cap 504'd on ordinary long replies).
 *
 * For sentence-at-a-time synthesis while the reply is still streaming, see
 * `POST /api/tts/stream`.
 */
export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let text: unknown;
	try {
		({ text } = await request.json());
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	if (typeof text !== 'string' || text.trim().length === 0) {
		return new Response('Text is required', { status: 400 });
	}
	if (text.length > MAX_TTS_TEXT) {
		return new Response(`Text exceeds maximum length (${MAX_TTS_TEXT})`, { status: 400 });
	}

	const settings = readSettings();
	const timeoutMs = resolveTtsTimeoutMs();
	// Long replies are spoken in sentence-aware chunks; each chunk gets its own
	// synthesis call inside the shared budget (chunk i gets timeoutMs/(n-i)).
	const chunks = chunkText(text);
	if (chunks.length === 0) {
		return new Response('Text is required', { status: 400 });
	}
	const chunkTimeout = (i: number): number =>
		Math.max(5_000, Math.floor(timeoutMs / (chunks.length - i)));

	try {
		// Fail before spawning anything when the engine cannot work (missing
		// cloud key, disallowed URL, missing piper model) — the same statuses
		// the catch block below produces, just earlier.
		const pre = preflightTts(settings);
		if (pre) return new Response(pre.message, { status: pre.status });

		const parts: { audio: Buffer; contentType: string }[] = [];
		for (let i = 0; i < chunks.length; i++) {
			parts.push(await synthesizeChunk({ text: chunks[i], settings, timeoutMs: chunkTimeout(i) }));
		}

		// Single chunk: return it untouched. Multiple WAV chunks: one header +
		// joined PCM. Multiple MP3 chunks: frames concatenate natively.
		let audio: Buffer;
		const contentType = parts[0].contentType;
		if (parts.length === 1) {
			audio = parts[0].audio;
		} else if (contentType === 'audio/wav') {
			audio = concatWav(parts.map((p) => p.audio));
		} else {
			audio = Buffer.concat(parts.map((p) => p.audio));
		}
		// Fresh ArrayBuffer copy: narrows Buffer's ArrayBuffer|SharedArrayBuffer union
		// to what the DOM Response type accepts.
		const view = new Uint8Array(audio.length);
		view.set(audio);
		return new Response(view.buffer, {
			headers: { 'Content-Type': contentType, 'Content-Length': String(audio.length) }
		});
	} catch (err) {
		return ttsErrorResponse(err, timeoutMs);
	}
};
