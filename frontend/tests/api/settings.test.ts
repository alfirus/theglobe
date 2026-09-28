import { beforeEach, describe, expect, it } from 'vitest';
import { GET as getSettings, POST as postSettings } from '../../src/routes/api/settings/+server';
import {
	call,
	clearSettingsFile,
	getRequest,
	postJson,
	readSettingsFile,
	writeSettingsFile
} from '../helpers';

const SECRET = 'sk-hidden-key-never-echoed-0123456789';

describe('GET /api/settings — key-free server prefill (QA defect D1 / M14)', () => {
	beforeEach(() => clearSettingsFile());

	it('returns a settings view with hasKey flags on a fresh profile', async () => {
		const res = await call(getSettings, getRequest('/api/settings'));
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		// Every provider is present with a hasKey flag — and nothing else secret.
		const configs = body.configs as Record<string, Record<string, unknown>>;
		expect(Object.keys(configs).length).toBeGreaterThan(0);
		expect(configs['lmstudio']).toEqual({
			baseUrl: expect.any(String),
			model: expect.any(String),
			hasKey: false,
			timeoutMs: 120_000
		});
		expect((body.keySource as Record<string, string>)['lmstudio']).toBe('none');
		expect(JSON.stringify(body)).not.toContain('apiKey');
	});

	it('never returns stored key material — hasKey only, value absent, key absent', async () => {
		writeSettingsFile({
			provider: 'lmstudio',
			systemPrompt: 'You are terse.',
			configs: {
				lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'stub-model', apiKey: SECRET }
			},
			tts: { provider: 'openai', apiKey: SECRET }
		});

		const res = await call(getSettings, getRequest('/api/settings'));
		const raw = await res.text();
		const body = JSON.parse(raw) as Record<string, unknown>;

		// The secret is stored server-side (checked below) but never reaches the wire.
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain('apiKey');

		expect(body.provider).toBe('lmstudio');
		expect(body.systemPrompt).toBe('You are terse.');
		const configs = body.configs as Record<string, Record<string, unknown>>;
		expect(configs['lmstudio']).toEqual({
			baseUrl: 'http://127.0.0.1:1234/v1',
			model: 'stub-model',
			hasKey: true,
			timeoutMs: 120_000
		});
		expect((body.keySource as Record<string, string>)['lmstudio']).toBe('file');
		// The TTS view is whitelisted the same way: hasKey, never the key.
		expect((body.tts as Record<string, unknown>).hasKey).toBe(true);
	});

	it('rejects a cross-origin caller before touching the file', async () => {
		const res = await call(
			getSettings,
			getRequest('/api/settings', { headers: { origin: 'https://evil.example.com' } })
		);
		expect(res.status).toBe(403);
	});
});

describe('POST /api/settings — validate, sanitise, store, echo nothing secret', () => {
	beforeEach(() => clearSettingsFile());

	it('saves a provider and echoes the key-free view back', async () => {
		const res = await call(
			postSettings,
			postJson('/api/settings', {
				provider: 'lmstudio',
				configs: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'stub-model' } }
			})
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; settings: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.settings.provider).toBe('lmstudio');
		expect(JSON.stringify(body)).not.toContain('apiKey');
		expect(readSettingsFile().provider).toBe('lmstudio');
	});

	it('stores an API key but never echoes it back', async () => {
		const res = await call(
			postSettings,
			postJson('/api/settings', {
				provider: 'lmstudio',
				configs: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: SECRET } }
			})
		);
		const raw = await res.text();
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain('apiKey');

		const stored = readSettingsFile() as { configs?: Record<string, Record<string, string>> };
		// The key persists server-side (the uplink needs it) — only the wire view is key-free.
		expect(stored.configs?.['lmstudio']?.apiKey).toBe(SECRET);
	});

	it('rejects a non-allow-listed upstream URL with 400 and stores nothing', async () => {
		const res = await call(
			postSettings,
			postJson('/api/settings', { configs: { lmstudio: { baseUrl: 'https://evil.example.com' } } })
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('URL not allowed');
		expect(readSettingsFile()).not.toHaveProperty('configs');
	});

	it('rejects an unknown provider instead of persisting it', async () => {
		const res = await call(postSettings, postJson('/api/settings', { provider: 'not-a-provider' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('Unknown provider');
		expect(readSettingsFile()).not.toHaveProperty('provider');
	});

	it('rejects a malformed JSON body', async () => {
		const res = await call(postSettings, postJson('/api/settings', '{"provider": '));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('Invalid JSON');
	});

	it('strips unknown fields instead of rejecting the whole client blob', async () => {
		const res = await call(
			postSettings,
			postJson('/api/settings', { provider: 'deepseek', evilField: 'exfiltrate-me' })
		);
		expect(res.status).toBe(200);
		expect(readSettingsFile()).not.toHaveProperty('evilField');
		const body = (await res.json()) as { settings: Record<string, unknown> };
		expect(body.settings).not.toHaveProperty('evilField');
	});

	it('merges a patch instead of clobbering the stored config', async () => {
		writeSettingsFile({
			provider: 'lmstudio',
			configs: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'keep-me', apiKey: SECRET } }
		});

		await call(postSettings, postJson('/api/settings', { provider: 'deepseek' }));

		const stored = readSettingsFile() as {
			provider?: string;
			configs?: Record<string, Record<string, string>>;
		};
		expect(stored.provider).toBe('deepseek');
		expect(stored.configs?.['lmstudio']).toEqual({
			baseUrl: 'http://127.0.0.1:1234/v1',
			model: 'keep-me',
			apiKey: SECRET
		});
	});

	it('rejects a cross-origin write', async () => {
		const res = await call(
			postSettings,
			postJson('/api/settings', { provider: 'deepseek' }, { headers: { origin: 'https://evil.example.com' } })
		);
		expect(res.status).toBe(403);
		expect(readSettingsFile()).toEqual({});
	});
});
