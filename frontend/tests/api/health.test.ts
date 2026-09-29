import { beforeEach, describe, expect, it } from 'vitest';
import { POST as postHealth } from '../../src/routes/api/health/+server';
import {
	call,
	clearSettingsFile,
	postJson,
	providerSettings,
	stubFetch,
	writeSettingsFile
} from '../helpers';

const SECRET = 'sk-health-secret-never-echoed';

function healthRequest(body: unknown, init: RequestInit = {}): Request {
	return postJson('/api/health', body, init);
}

describe('POST /api/health — probe contract (P1-2 surfaced health / M15)', () => {
	beforeEach(() => clearSettingsFile());

	it('requires a provider or agent id', async () => {
		const res = await call(postHealth, healthRequest({}));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('Provider ID is required');
	});

	it('rejects unknown provider and agent ids', async () => {
		const provider = await call(postHealth, healthRequest({ providerId: 'not-a-provider' }));
		expect(provider.status).toBe(400);
		expect(((await provider.json()) as { error: string }).error).toContain('Invalid provider');

		const agent = await call(postHealth, healthRequest({ agentId: 'hal-9000' }));
		expect(agent.status).toBe(400);
		expect(((await agent.json()) as { error: string }).error).toContain('Invalid agent');
	});

	it('answers 400 when no base URL is configured at all', async () => {
		const fetchStub = stubFetch();
		const res = await call(postHealth, healthRequest({ providerId: 'hermes' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe('not_configured');
		expect(fetchStub.calls).toHaveLength(0);
	});

	it('never probes a non-allow-listed URL — the SSRF guard (M15)', async () => {
		const fetchStub = stubFetch();
		const hostile = [
			'https://evil.example.com',
			'http://169.254.169.254', // cloud metadata
			'file:///etc/passwd',
			'gopher://internal',
			'not-a-url'
		];

		for (const baseUrl of hostile) {
			const res = await call(postHealth, healthRequest({ providerId: 'lmstudio', baseUrl }));
			expect(res.status, baseUrl).toBe(400);
			expect(((await res.json()) as { error: string }).error, baseUrl).toContain('URL not allowed');
		}
		// Not one of those URLs was ever fetched.
		expect(fetchStub.calls).toHaveLength(0);
	});

	it('still allows the documented private ranges (local-first app)', async () => {
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('{}', { status: 200 }));

		const res = await call(
			postHealth,
			healthRequest({ providerId: 'lmstudio', baseUrl: 'http://192.168.7.7:1234/v1' })
		);
		expect(res.status).toBe(200);
		expect(fetchStub.calls).toHaveLength(1);
	});

	it('does probe an allow-listed supplied URL and reports health', async () => {
		writeSettingsFile(providerSettings({ apiKey: SECRET }));
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('{}', { status: 200 }));

		const res = await call(
			postHealth,
			healthRequest({ providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:9999/v1' })
		);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body.providerId).toBe('lmstudio');
		expect(body.baseUrl).toBe('http://127.0.0.1:9999/v1');
		expect(body.healthy).toBe(true);
		expect(typeof body.responseTime).toBe('number');
		expect(new Date(String(body.checkedAt)).toISOString()).toBe(body.checkedAt);
		// First probe already answered 200 → one request, then stop.
		expect(fetchStub.calls).toHaveLength(1);
		expect(fetchStub.calls[0].url).toBe('http://127.0.0.1:9999/v1/models');
		expect(fetchStub.calls[0].init.redirect).toBe('manual');
		// The upstream gets the key; the caller never does.
		const headers = fetchStub.calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});

	it('walks both probes and accepts the health endpoint as a fallback', async () => {
		writeSettingsFile(providerSettings());
		const fetchStub = stubFetch();
		fetchStub.respondWith((call0) =>
			call0.url.endsWith('/models')
				? new Response('nope', { status: 404 })
				: new Response('{"status":"ok"}', { status: 200 })
		);

		const res = await call(postHealth, healthRequest({ providerId: 'lmstudio' }));
		const body = (await res.json()) as { healthy: boolean; error: string; baseUrl: string };

		expect(body.baseUrl).toBe('http://127.0.0.1:9999/v1');
		expect(fetchStub.calls.map((c) => c.url)).toEqual([
			'http://127.0.0.1:9999/v1/models',
			'http://127.0.0.1:9999/v1/health'
		]);
		expect(body.healthy).toBe(true);
		expect(body.error).toBe('');
	});

	it('probes `/v1/models` only once when the base URL already ends in /v1', async () => {
		writeSettingsFile(providerSettings({ baseUrl: 'http://127.0.0.1:9999/v1/' }));
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('{}', { status: 200 }));

		await call(postHealth, healthRequest({ providerId: 'lmstudio' }));
		// No `/v1/v1/models` — the classic double-version probe bug (QA D2 note).
		expect(fetchStub.calls[0].url).toBe('http://127.0.0.1:9999/v1/models');
	});

	it('reports unhealthy with the HTTP status when every probe fails', async () => {
		writeSettingsFile(providerSettings());
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('down', { status: 503 }));

		const res = await call(postHealth, healthRequest({ providerId: 'lmstudio' }));
		const body = (await res.json()) as { healthy: boolean; error: string };

		expect(res.status).toBe(200);
		expect(body.healthy).toBe(false);
		expect(body.error).toContain('HTTP 503');
	});

	it('reports unhealthy with the transport error when nothing answers', async () => {
		writeSettingsFile(providerSettings());
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => {
			throw new TypeError('fetch failed');
		});

		const res = await call(postHealth, healthRequest({ providerId: 'lmstudio' }));
		const body = (await res.json()) as { healthy: boolean; error: string };

		expect(body.healthy).toBe(false);
		expect(body.error).toContain('fetch failed');
	});

	it('probes an agent uplink through its own configuration', async () => {
		writeSettingsFile({
			agents: { 'hermes-agent': { baseUrl: 'http://127.0.0.1:8642/v1', apiKey: 'agent-key' } }
		});
		const fetchStub = stubFetch();
		fetchStub.respondWith(() => new Response('{}', { status: 200 }));

		const res = await call(postHealth, healthRequest({ agentId: 'hermes-agent' }));
		const body = (await res.json()) as { providerId: string; baseUrl: string; healthy: boolean };

		expect(res.status).toBe(200);
		expect(body.providerId).toBe('hermes-agent');
		expect(body.baseUrl).toBe('http://127.0.0.1:8642/v1');
		expect(body.healthy).toBe(true);
		expect(fetchStub.calls[0].url).toBe('http://127.0.0.1:8642/v1/models');
	});

	it('rejects a malformed JSON body and a cross-origin caller', async () => {
		const bad = await call(postHealth, healthRequest('{oops'));
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { code: string }).code).toBe('invalid_request');

		const crossOrigin = await call(
			postHealth,
			healthRequest({ providerId: 'lmstudio' }, { headers: { origin: 'https://evil.example.com' } })
		);
		expect(crossOrigin.status).toBe(403);
	});
});
