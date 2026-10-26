/**
 * Basic loopback rate limiter for the process-spawning `/api/*` routes
 * (P2-4: chat/STT/TTS had no throttle — the loopback bind was the only
 * control, and a hostile local page that clears the guard could spawn
 * unbounded work; the TTS engine concurrency cap only bounds engines, not
 * requests).
 *
 * Design: one global sliding-window bucket per route. The server only binds
 * loopback, so per-client keying buys nothing — a single shared bucket is
 * the whole throttle. Limits are generous (human-paced use never notices);
 * excess returns 429 + `Retry-After`, never touches an engine or upstream.
 *
 * Module state resets per test file under Vitest (`isolate: true`); tests
 * that fire bursts within one file use `resetRateLimits()`.
 */

export type RateLimitBucket = 'chat' | 'stt' | 'tts' | 'tts-stream';

/** Requests allowed per 60 s window, per bucket. */
const LIMITS: Record<RateLimitBucket, number> = {
	chat: 90,
	stt: 30,
	tts: 60,
	'tts-stream': 180
};

const WINDOW_MS = 60_000;

/** Bucket → timestamps (ms) of admitted requests inside the current window. */
const hits = new Map<RateLimitBucket, number[]>();

function prune(bucket: RateLimitBucket, now: number): number[] {
	const seen = (hits.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);
	hits.set(bucket, seen);
	return seen;
}

/**
 * Returns `null` when the request is admitted, otherwise the 429 `Response`
 * the route must return (with `Retry-After` in whole seconds).
 */
export function checkRateLimit(bucket: RateLimitBucket, now = Date.now()): Response | null {
	const seen = prune(bucket, now);
	if (seen.length >= LIMITS[bucket]) {
		const oldest = seen[0] ?? now;
		const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
		return new Response(JSON.stringify({ error: 'Rate limit exceeded', code: 'rate_limited' }), {
			status: 429,
			headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) }
		});
	}
	seen.push(now);
	return null;
}

/** Test hook: drop all buckets (Vitest `isolate` already resets per file). */
export function resetRateLimits(): void {
	hits.clear();
}
