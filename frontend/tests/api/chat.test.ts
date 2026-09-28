import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postChat } from '../../src/routes/api/chat/+server';
import {
	call,
	clearSettingsFile,
	postJson,
	providerSettings,
	readSse,
	sseBody,
	stubFetch,
	writeSettingsFile
} from '../helpers';

const SECRET = 'sk-upstream-secret-never-log-me';
const AGENT_KEY = 'agent-key';

/** Assembled at runtime so the expectation can never drift from the fixture. */
const expectedAuthorization = (): string => `Bearer ${SECRET}`;
const expectedAgentAuthorization = (): string => `Bearer ${AGENT_KEY}`;

function chatRequest(body: unknown, init: RequestInit = {}): Request {
	return postJson('/api/chat', body, init);
}

/** Capture every console channel — key material must never reach a log line. */
function captureConsole(): { lines: string[] } {
	const lines: string[] = [];
	const record =
		(level: 'log' | 'error' | 'warn' | 'info') =>
		(...args: unknown[]) => {
			lines.push(`${level}: ${args.map(String).join(' ')}`);
		};
	vi.spyOn(console, 'log').mockImplementation(record('log'));
	vi.spyOn(console, 'error').mockImplementation(record('error'));
	vi.spyOn(console, 'warn').mockImplementation(record('warn'));
	vi.spyOn(console, 'info').mockImplementation(record('info'));
	return { lines };
}

describe('POST /api/chat — request contract', () => {
	beforeEach(() => clearSettingsFile());

	it('rejects a malformed JSON body with 400', async () => {
		const res = await call(postChat, chatRequest('{"message": '));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('Invalid JSON');
	});

	it('rejects a missing or non-string message with 400', async () => {
		const missing = await call(postChat, chatRequest({}));
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toContain('Message is required');

		const wrongType = await call(postChat, chatRequest({ message: 42 }));
		expect(wrongType.status).toBe(400);
	});

	it('rejects an oversized message with 413', async () => {
		const res = await call(postChat, chatRequest({ message: 'x'.repeat(32_001) }));
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toContain('32000');
	});

	it('rejects an unknown provider and an unknown uplink mode', async () => {
		const badProvider = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'not-a-provider' } })
		);
		expect(badProvider.status).toBe(400);
		expect(((await badProvider.json()) as { error: string }).error).toContain('Invalid provider');

		const badMode = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-uplink-mode': 'sideways' } })
		);
		expect(badMode.status).toBe(400);
		expect(((await badMode.json()) as { error: string }).error).toContain('Invalid uplink mode');
	});

	it('rejects a cross-origin caller without contacting any upstream', async () => {
		const fetchStub = stubFetch();
		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { origin: 'https://evil.example.com' } })
		);
		expect(res.status).toBe(403);
		expect(fetchStub.calls).toHaveLength(0);
	});

	it('answers 502 when the selected uplink has no base URL configured', async () => {
		const fetchStub = stubFetch();
		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'hermes' } })
		);
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toContain('No base URL configured');
		expect(fetchStub.calls).toHaveLength(0);
	});

	it('refuses a non-allow-listed upstream stored in settings (400, no fetch)', async () => {
		writeSettingsFile(providerSettings({ baseUrl: 'https://evil.example.com/v1' }));
		const fetchStub = stubFetch();

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('URL not allowed');
		expect(fetchStub.calls).toHaveLength(0);
	});
});

describe('POST /api/chat — provider uplink (stubbed at the network layer)', () => {
	beforeEach(() => {
		clearSettingsFile();
		writeSettingsFile(
			providerSettings({ baseUrl: 'http://127.0.0.1:9999/v1', model: 'stub-model', apiKey: SECRET })
		);
	});

	it('relays the upstream SSE stream as `data:` frames and keeps [DONE]', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(
			() =>
				new Response(
					sseBody([
						'{"choices":[{"delta":{"content":"Hello"}}]}',
						'{"choices":[{"delta":{"content":" from the stub"}}]}'
					]),
					{ status: 200, headers: { 'Content-Type': 'text/event-stream' } }
				)
		);

		const res = await call(
			postChat,
			chatRequest({ message: 'ping' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		const text = await readSse(res);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		expect(text).toContain('data: {"content":"Hello"}');
		expect(text).toContain('data: {"content":" from the stub"}');
		expect(text).toContain('data: [DONE]');
	});

	it('posts the OpenAI-compatible payload with the resolved model and key', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		await call(
			postChat,
			chatRequest({ message: 'ping' }, { headers: { 'x-provider': 'lmstudio' } })
		);

		expect(fetchStub.calls).toHaveLength(1);
		const call0 = fetchStub.calls[0];
		expect(call0.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
		const headers = call0.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(expectedAuthorization());
		expect(headers['Content-Type']).toBe('application/json');

		const payload = JSON.parse(String(call0.init.body)) as {
			model: string;
			stream: boolean;
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.model).toBe('stub-model');
		expect(payload.stream).toBe(true);
		expect(payload.messages).toEqual([{ role: 'user', content: 'ping' }]);
	});

	it('sends history before the message and the system prompt first (H5/H6 contract)', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		await call(
			postChat,
			chatRequest(
				{
					message: 'third question',
					systemPrompt: 'You are terse.',
					history: [
						{ role: 'user', content: 'first question' },
						{ role: 'assistant', content: 'first answer' }
					]
				},
				{ headers: { 'x-provider': 'lmstudio' } }
			)
		);

		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.messages).toEqual([
			{ role: 'system', content: 'You are terse.' },
			{ role: 'user', content: 'first question' },
			{ role: 'assistant', content: 'first answer' },
			{ role: 'user', content: 'third question' }
		]);
	});

	it('still accepts the legacy X-System-Prompt header (half-migrated client)', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		await call(
			postChat,
			chatRequest(
				{ message: 'hi' },
				{
					headers: {
						'x-provider': 'lmstudio',
						'x-system-prompt': 'Header prompt wins when body is empty'
					}
				}
			)
		);

		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.messages[0]).toEqual({
			role: 'system',
			content: 'Header prompt wins when body is empty'
		});
	});

	it('caps history to the most recent 40 entries and 16 000 chars each', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		const history = Array.from({ length: 60 }, (_, i) => ({
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: `turn ${i} ${'y'.repeat(20_000)}`
		}));

		await call(
			postChat,
			chatRequest({ message: 'now', history }, { headers: { 'x-provider': 'lmstudio' } })
		);

		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		// 40 history entries + the live message, oldest turns dropped.
		expect(payload.messages).toHaveLength(41);
		expect(payload.messages[0].content).toContain('turn 20 ');
		expect(payload.messages[39].content).toContain('turn 59 ');
		expect(payload.messages[39].content).toHaveLength(16_000);
		expect(payload.messages[40]).toEqual({ role: 'user', content: 'now' });
	});

	it('caps the system prompt to 8 000 chars', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		await call(
			postChat,
			chatRequest(
				{ message: 'hi', systemPrompt: 'p'.repeat(9_000) },
				{ headers: { 'x-provider': 'lmstudio' } }
			)
		);

		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.messages[0].content).toHaveLength(8_000);
	});

	it('drops malformed history entries instead of forwarding them', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		await call(
			postChat,
			chatRequest(
				{
					message: 'hi',
					systemPrompt: 'ok',
					history: [
						null,
						42,
						{ role: 'system', content: 'injected system turn' },
						{ role: 'tool', content: 'tool output' },
						{ role: 'user', content: 42 },
						{ role: 'assistant' },
						{ role: 'user', content: 'keep me' }
					]
				},
				{ headers: { 'x-provider': 'lmstudio' } }
			)
		);

		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.messages).toEqual([
			{ role: 'system', content: 'ok' },
			{ role: 'user', content: 'keep me' },
			{ role: 'user', content: 'hi' }
		]);
	});

	it('routes the agent uplink through the agent entry and its own key', async () => {
		writeSettingsFile({
			provider: 'lmstudio',
			agents: {
				'hermes-agent': {
					baseUrl: 'http://127.0.0.1:8642/v1',
					model: 'agent-model',
					apiKey: 'agent-key'
				}
			}
		});
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('sentinel'));

		const res = await call(
			postChat,
			chatRequest(
				{ message: 'hi' },
				{ headers: { 'x-uplink-mode': 'agent', 'x-agent': 'hermes-agent' } }
			)
		);

		expect(res.status).toBe(200);
		expect(fetchStub.calls[0].url).toBe('http://127.0.0.1:8642/v1/chat/completions');
		const headers = fetchStub.calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(expectedAgentAuthorization());
		const payload = JSON.parse(String(fetchStub.calls[0].init.body)) as { model: string };
		expect(payload.model).toBe('agent-model');
	});

	it('rejects an unknown agent id', async () => {
		const res = await call(
			postChat,
			chatRequest(
				{ message: 'hi' },
				{ headers: { 'x-uplink-mode': 'agent', 'x-agent': 'hal-9000' } }
			)
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('Invalid agent');
	});
});

describe('POST /api/chat — upstream reasoning frames', () => {
	beforeEach(() => {
		clearSettingsFile();
		writeSettingsFile(providerSettings());
	});

	it('relays reasoning_content as thinking frames, separate from content', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n' +
						'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
						'data: [DONE]\n\n',
					{ status: 200, headers: { 'Content-Type': 'text/event-stream' } }
				)
		);

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		const text = await readSse(res);

		expect(text).toContain('data: {"thinking":"pondering"}');
		expect(text).toContain('data: {"content":"answer"}');
		expect(text.indexOf('thinking')).toBeLessThan(text.indexOf('"answer"'));
	});

	it('skips malformed upstream frames without killing the stream', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(
			() =>
				new Response(
					'data: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
					{
						status: 200,
						headers: { 'Content-Type': 'text/event-stream' }
					}
				)
		);

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		const text = await readSse(res);
		expect(text).toContain('data: {"content":"ok"}');
	});
});

describe('POST /api/chat — failure mapping and secret hygiene', () => {
	beforeEach(() => {
		clearSettingsFile();
		writeSettingsFile(providerSettings({ apiKey: SECRET }));
	});

	it('maps a refused connection to 503 without leaking the key', async () => {
		const fetchStub = stubFetch();
		const console0 = captureConsole();
		fetchStub.respondWith(() => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
		});

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		const raw = await res.text();

		expect(res.status).toBe(503);
		expect(raw).toContain('Cannot connect to lmstudio');
		expect(raw).not.toContain(SECRET);
		expect(console0.lines.join('\n')).not.toContain(SECRET);
	});

	it('maps an upstream 500 to 503', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('boom', { status: 500 }));

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toContain('Cannot connect');
	});

	it('maps a provider timeout to 504 with the uplink id and budget', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => {
			throw new DOMException('The operation timed out', 'TimeoutError');
		});

		const res = await call(
			postChat,
			chatRequest({ message: 'hi' }, { headers: { 'x-provider': 'lmstudio' } })
		);
		const body = (await res.json()) as { error: string };
		expect(res.status).toBe(504);
		expect(body.error).toContain('lmstudio');
		expect(body.error).toContain('timed out');
		expect(body.error).toContain('120000ms');
	});
});
