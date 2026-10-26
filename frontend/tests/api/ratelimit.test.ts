import { describe, expect, it } from 'vitest';
import { POST as postChat } from '../../src/routes/api/chat/+server';
import { POST as postStt } from '../../src/routes/api/stt/+server';
import { POST as postTts } from '../../src/routes/api/tts/+server';
import { POST as postTtsStream } from '../../src/routes/api/tts/stream/+server';
import { call, clearSettingsFile, postJson, writeSettingsFile } from '../helpers';

/**
 * P2-4: every process-spawning route throttles before doing work. Each
 * `it` owns its bucket (one bucket per route), and Vitest `isolate`
 * gives this file a fresh limiter, so bursts here never affect other files.
 */
describe('POST /api/* — loopback rate limits (P2-4)', () => {
	it('throttles POST /api/chat past 90 req/min with 429 + Retry-After', async () => {
		let last: Response | null = null;
		for (let i = 0; i < 91; i++) {
			last = await call(postChat, postJson('/api/chat', { message: 'hi' }));
		}
		expect(last!.status).toBe(429);
		expect(last!.headers.get('Retry-After')).toBeTruthy();
		expect(((await last!.json()) as { code: string }).code).toBe('rate_limited');
	});

	it('throttles POST /api/stt past 30 req/min', async () => {
		let last: Response | null = null;
		for (let i = 0; i < 31; i++) {
			last = await call(postStt, postJson('/api/stt', { audio: '!!!not-base64!!!' }));
		}
		expect(last!.status).toBe(429);
		expect(last!.headers.get('Retry-After')).toBeTruthy();
	});

	it('throttles POST /api/tts past 60 req/min', async () => {
		// Cloud engine with no key: preflight 503s fast with zero spawns, so
		// the burst measures the limiter, not engine timeouts.
		clearSettingsFile();
		writeSettingsFile({ tts: { provider: 'openai' } });
		let last: Response | null = null;
		for (let i = 0; i < 61; i++) {
			last = await call(postTts, postJson('/api/tts', { text: 'hello' }));
		}
		expect(last!.status).toBe(429);
		expect(last!.headers.get('Retry-After')).toBeTruthy();
	});

	it('throttles POST /api/tts/stream past 180 req/min', async () => {
		clearSettingsFile();
		writeSettingsFile({ tts: { provider: 'openai' } });
		let last: Response | null = null;
		for (let i = 0; i < 181; i++) {
			last = await call(postTtsStream, postJson('/api/tts/stream', { text: 'hello' }));
		}
		expect(last!.status).toBe(429);
		expect(last!.headers.get('Retry-After')).toBeTruthy();
	});
});
