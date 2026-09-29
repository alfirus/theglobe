import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * P1-5 end-to-end smoke (card t_644b7899) — tagged `@smoke`.
 *
 *   app loads → globe canvas renders → send a message → streamed reply lands
 *   in a bubble.
 *
 * The provider is stubbed **at the network layer**: a local HTTP server stands
 * in for the LLM upstream and answers `POST /v1/chat/completions` with SSE
 * frames. No live model is ever contacted, in CI or locally. The stub is wired
 * in through `POST /api/settings` (a loopback base URL, which the upstream
 * allow-list permits), exactly the way a real provider would be configured.
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5199';
const SETTINGS_FILE = path.join(process.cwd(), '.globe-settings.json');
const TTS_TOGGLE_KEY = 'globe-tts-enabled';

/** Deliberately multi-frame so the reply can only appear by streaming. */
const REPLY_FRAMES = ['Hello', ' from', ' the', ' stub.'];
const FULL_REPLY = REPLY_FRAMES.join('');
const PROMPT = 'Smoke check 42';

type UpstreamCall = { url: string; body: Record<string, unknown> };

const upstream: UpstreamCall[] = [];
let stub: http.Server;
let previousSettings: string | null = null;

test.beforeAll(async () => {
	previousSettings = fs.existsSync(SETTINGS_FILE)
		? fs.readFileSync(SETTINGS_FILE, 'utf8')
		: null;

	stub = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const url = req.url ?? '';

			if (url.endsWith('/chat/completions')) {
				upstream.push({
					url,
					body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
				});
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache'
				});
				const frames = [
					...REPLY_FRAMES.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
					'data: [DONE]\n\n'
				];
				let index = 0;
				const pump = (): void => {
					if (index >= frames.length) {
						res.end();
						return;
					}
					res.write(frames[index++]);
					// 40 ms apart: the bubble must update per frame, not at once.
					setTimeout(pump, 40);
				};
				pump();
				return;
			}

			// /v1/models, /v1/health, … — the health probe and anything else.
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"status":"ok"}');
		});
	});

	await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
	const { port } = stub.address() as AddressInfo;

	// Point the app at the stub: loopback ⇒ allow-listed, model irrelevant.
	const response = await fetch(`${BASE_URL}/api/settings`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			provider: 'lmstudio',
			uplinkMode: 'provider',
			configs: { lmstudio: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-model' } }
		})
	});
	if (!response.ok) {
		throw new Error(`could not configure the smoke upstream: HTTP ${response.status}`);
	}
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()));
	// Leave the workspace exactly as we found it — no settings file written by CI.
	if (previousSettings === null) fs.rmSync(SETTINGS_FILE, { force: true });
	else fs.writeFileSync(SETTINGS_FILE, previousSettings, 'utf8');
});

test('@smoke app loads, globe canvas renders, message streams back', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));

	// Voice output off: a smoke test must never spawn a TTS engine.
	await page.addInitScript((key) => localStorage.setItem(key, '0'), TTS_TOGGLE_KEY);

	await page.goto('/');
	await expect(page).toHaveTitle('Globe Interface');

	// ── 1. the globe canvas renders ──────────────────────────────────────────
	const canvas = page.locator('canvas').first();
	await expect(canvas).toBeVisible();
	const box = await canvas.boundingBox();
	expect(box, 'globe canvas has a layout box').not.toBeNull();
	expect(box!.width).toBeGreaterThan(200);
	expect(box!.height).toBeGreaterThan(200);
	// A rendered frame is far bigger than an empty buffer; a canvas that never
	// drew (the old `bloomPass` ReferenceError killed every frame) stays tiny.
	const frame = await canvas.screenshot();
	// eslint-disable-next-line no-console -- calibration signal when the smoke fails
	console.log(`[smoke] canvas frame bytes = ${frame.byteLength}`);
	// A drawn frame measured ~800 KB; a canvas that never drew (the old
	// `bloomPass` ReferenceError killed every frame) compresses to a few KB.
	expect(frame.byteLength).toBeGreaterThan(20_000);

	// ── 2. send a message ────────────────────────────────────────────────────
	const composer = page.getByRole('textbox', { name: 'Message the Globe' });
	await expect(composer).toBeVisible();
	await composer.fill(PROMPT);
	await composer.press('Enter');

	const userTurn = page.locator('article.turn.user').first();
	await expect(userTurn).toContainText(PROMPT);

	// ── 3. the streamed reply appears in an assistant bubble ─────────────────
	const assistantTurn = page.locator('article.turn.assistant').first();
	await expect(assistantTurn).toContainText(FULL_REPLY);

	// ── 4. it really went through the server to the (stubbed) upstream ───────
	expect(upstream).toHaveLength(1);
	const call = upstream[0];
	expect(call.url).toBe('/v1/chat/completions');
	expect(call.body.stream).toBe(true);
	expect(call.body.model).toBe('stub-model');
	expect(call.body.messages).toEqual([{ role: 'user', content: PROMPT }]);

	// ── 5. no uncaught exceptions anywhere in the page ───────────────────────
	expect(pageErrors, 'page must not throw').toEqual([]);

	// QA calibration only: capture the post-reply screen when asked.
	if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT });
});
