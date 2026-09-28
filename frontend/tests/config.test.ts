import { afterEach, describe, expect, it } from 'vitest';
import {
	PROVIDERS,
	SettingsValidationError,
	assertApiRequest,
	isAllowedUrl,
	mergeSettings,
	resolveConfig,
	resolveProviderTimeoutMs,
	sanitizeSettingsBody,
	settingsToPublic
} from '$lib/config';
import { apiRequest } from './helpers';

/**
 * Unit tests for `$lib/config` — the security kernel every `/api/*` route
 * shares (P1-5, card t_644b7899). Covers the P0 security contract:
 * upstream allow-list, key-free public settings view, `/api/*` request guard.
 */

describe('isAllowedUrl — upstream allow-list (M15 / §4.1-2)', () => {
	it('allows loopback, private ranges and the documented public hosts', () => {
		const allowed = [
			'http://localhost:1234/v1',
			'http://127.0.0.1:9999/v1',
			'https://[::1]:8080',
			'http://10.0.0.5:1234/v1',
			'http://192.168.1.10:1234/v1',
			'http://172.16.0.1:1234/v1',
			'http://172.31.255.255/v1',
			'http://100.64.0.7:1234/v1', // Tailscale / CGNAT
			'https://openrouter.ai/api/v1',
			'https://api.deepseek.com/v1',
			'https://api.xiaomimimo.com/v1',
			'https://token-plan-sgp.xiaomimimo.com/v1',
			'https://api.openai.com/v1',
			'https://api.elevenlabs.io/v1'
		];
		for (const url of allowed) expect(isAllowedUrl(url), url).toBe(true);
	});

	it('rejects non-allow-listed, metadata and non-http upstreams', () => {
		const rejected = [
			'https://evil.example.com/v1',
			'https://openrouter.ai.evil.example.com/v1', // suffix spoof
			'http://169.254.169.254/latest/meta-data', // cloud metadata
			'http://172.32.0.1/v1', // just outside 172.16/12
			'http://100.63.0.1/v1', // just outside 100.64/10
			'http://999.1.1.1/v1',
			'ftp://openrouter.ai/v1',
			'javascript:alert(1)',
			'not-a-url',
			''
		];
		for (const url of rejected) expect(isAllowedUrl(url), url).toBe(false);
	});

	it('honours GLOB_ALLOWED_ORIGINS for an extra documented host', () => {
		// The env var is a comma-separated list of *hosts*, not URLs.
		process.env.GLOB_ALLOWED_ORIGINS = 'team-llm.internal.example';
		try {
			expect(isAllowedUrl('https://team-llm.internal.example/v1')).toBe(true);
			expect(isAllowedUrl('https://other.internal.example/v1')).toBe(false);
		} finally {
			delete process.env.GLOB_ALLOWED_ORIGINS;
		}
	});
});

describe('settingsToPublic — GET /api/settings never returns key material', () => {
	it('whitelists to hasKey/keySource, with no apiKey key anywhere in the tree', () => {
		const secret = 'sk-super-secret-do-not-leak-0123456789';
		const publicView = settingsToPublic({
			provider: 'lmstudio',
			systemPrompt: 'You are terse.',
			configs: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: secret } },
			agents: { 'hermes-agent': { baseUrl: 'http://127.0.0.1:8642/v1', apiKey: secret } },
			tts: { provider: 'openai', apiKey: secret }
		});

		const serialised = JSON.stringify(publicView);
		expect(serialised).not.toContain(secret);
		expect(serialised).not.toContain('apiKey');
		expect(JSON.stringify(publicView).includes('"apiKey"')).toBe(false);

		expect(publicView.provider).toBe('lmstudio');
		expect(publicView.configs['lmstudio']).toEqual({
			baseUrl: 'http://127.0.0.1:1234/v1',
			model: 'm',
			hasKey: true,
			timeoutMs: 120_000
		});
		expect(publicView.keySource['lmstudio']).toBe('file');
		expect(publicView.agents['hermes-agent']?.hasKey).toBe(true);
		expect(publicView.tts?.hasKey).toBe(true);
		// Nothing stored ⇒ hasKey is exactly false, no partial key material.
		expect(settingsToPublic({}).configs['hermes']?.hasKey).toBe(false);
	});

	it('never leaks an env-provided key either', () => {
		process.env.HERMES_API_KEY_MIMO = 'env-secret-value';
		try {
			const view = settingsToPublic({});
			expect(JSON.stringify(view)).not.toContain('env-secret-value');
			expect(view.keySource['mimo']).toBe('env');
			expect(view.configs['mimo']?.hasKey).toBe(true);
		} finally {
			delete process.env.HERMES_API_KEY_MIMO;
		}
	});
});

describe('resolveConfig — key precedence (settings file → per-provider env → generic env)', () => {
	afterEach(() => {
		delete process.env.HERMES_API_KEY_LMSTUDIO;
		delete process.env.HERMES_API_KEY;
	});

	it('prefers the file, then the per-provider env, then the generic env', () => {
		const file = { configs: { lmstudio: { apiKey: 'file-key' } } };

		process.env.HERMES_API_KEY_LMSTUDIO = 'provider-env-key';
		process.env.HERMES_API_KEY = 'generic-env-key';
		expect(resolveConfig('lmstudio', file).apiKey).toBe('file-key');
		expect(resolveConfig('lmstudio', {}).apiKey).toBe('provider-env-key');

		delete process.env.HERMES_API_KEY_LMSTUDIO;
		expect(resolveConfig('lmstudio', {}).apiKey).toBe('generic-env-key');

		delete process.env.HERMES_API_KEY;
		expect(resolveConfig('lmstudio', {}).apiKey).toBe('');
		expect(resolveConfig('lmstudio', {}).keySource).toBe('none');
	});

	it('falls back to DEFAULTS for baseUrl/model and reports the key source', () => {
		const resolved = resolveConfig('deepseek', {});
		expect(resolved.baseUrl).toBe('https://api.deepseek.com/v1');
		expect(resolved.model).toBe('deepseek-chat');
		expect(resolved.keySource).toBe('none');
		// No key anywhere ⇒ the resolved key is the empty string, never a default.
		expect(resolveConfig('hermes', {}).apiKey).toBe('');
		expect(resolveConfig('hermes', {}).keySource).toBe('none');
	});
});

describe('resolveProviderTimeoutMs — per-uplink budget clamping', () => {
	it('defaults on junk and clamps to the documented 5 s – 10 min window', () => {
		expect(resolveProviderTimeoutMs(undefined)).toBe(120_000);
		expect(resolveProviderTimeoutMs('nope')).toBe(120_000);
		expect(resolveProviderTimeoutMs(Number.NaN)).toBe(120_000);
		expect(resolveProviderTimeoutMs(-1)).toBe(120_000);
		expect(resolveProviderTimeoutMs(1)).toBe(5_000);
		expect(resolveProviderTimeoutMs(999_999_999)).toBe(600_000);
		expect(resolveProviderTimeoutMs(30_000.6)).toBe(30_001);
	});
});

describe('sanitizeSettingsBody + mergeSettings — POST /api/settings', () => {
	it('rejects a hostile upstream URL instead of storing it (§4.1-2)', () => {
		expect(() =>
			sanitizeSettingsBody({ configs: { lmstudio: { baseUrl: 'https://evil.example.com' } } })
		).toThrow(SettingsValidationError);
		try {
			sanitizeSettingsBody({ configs: { lmstudio: { baseUrl: 'http://169.254.169.254' } } });
			expect.unreachable('hostile metadata URL must be rejected');
		} catch (err) {
			expect(err).toBeInstanceOf(SettingsValidationError);
			expect((err as Error).message).toContain('URL not allowed');
		}
	});

	it('rejects unknown providers/agents/modes and wrong types', () => {
		expect(() => sanitizeSettingsBody({ provider: 'not-a-provider' })).toThrow('Unknown provider');
		expect(() => sanitizeSettingsBody({ agent: 'hal-9000' })).toThrow('Unknown agent');
		expect(() => sanitizeSettingsBody({ uplinkMode: 'sideways' })).toThrow('Unknown uplink mode');
		expect(() => sanitizeSettingsBody({ configs: { hermes: { model: 42 } } })).toThrow(
			'must be a string'
		);
		expect(() => sanitizeSettingsBody('nope')).toThrow('Body must be a JSON object');
	});

	it('drops unknown fields instead of rejecting the client blob', () => {
		const patch = sanitizeSettingsBody({
			provider: 'deepseek',
			evilField: 'exfiltrate-me',
			configs: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', nested: true } }
		});
		expect(patch.provider).toBe('deepseek');
		expect(patch).not.toHaveProperty('evilField');
		expect(patch.configs?.['lmstudio']).toEqual({ baseUrl: 'http://127.0.0.1:1234/v1' });
	});

	it('treats an empty apiKey as an explicit clear (rotation path)', () => {
		const patch = sanitizeSettingsBody({ configs: { lmstudio: { apiKey: '' } } });
		expect(patch.configs?.['lmstudio']).toEqual({ apiKey: '' });
		const merged = mergeSettings(
			{ configs: { lmstudio: { apiKey: 'old-key', model: 'keep-me' } } },
			patch
		);
		expect(merged.configs?.['lmstudio']).toEqual({ apiKey: '', model: 'keep-me' });
	});
});

describe('assertApiRequest — shared-secret guard for /api/*', () => {
	afterEach(() => {
		delete process.env.API_SERVER_KEY;
	});

	it('admits a loopback same-origin request with no secret configured', () => {
		expect(assertApiRequest(apiRequest('/api/stats'))).toBeNull();
	});

	it('rejects cross-origin, null-origin and cross-site requests outright', () => {
		const foreign = apiRequest('/api/chat', { headers: { origin: 'https://evil.example.com' } });
		expect(assertApiRequest(foreign)?.status).toBe(403);

		const nullOrigin = apiRequest('/api/chat', { headers: { origin: 'null' } });
		expect(assertApiRequest(nullOrigin)?.status).toBe(403);

		const crossSite = apiRequest('/api/chat', { headers: { 'sec-fetch-site': 'cross-site' } });
		expect(assertApiRequest(crossSite)?.status).toBe(403);
	});

	it('requires the shared secret off-loopback once API_SERVER_KEY is set', () => {
		process.env.API_SERVER_KEY = 'shared-secret-value';
		const offLoopback = apiRequest('/api/chat', { headers: { host: 'globe.example.com' } });
		const denied = assertApiRequest(offLoopback);
		expect(denied?.status).toBe(401);

		const withSecret = apiRequest('/api/chat', {
			headers: { host: 'globe.example.com', authorization: 'Bearer shared-secret-value' }
		});
		expect(assertApiRequest(withSecret)).toBeNull();

		const wrongSecret = apiRequest('/api/chat', {
			headers: { host: 'globe.example.com', authorization: 'Bearer nope' }
		});
		expect(assertApiRequest(wrongSecret)?.status).toBe(401);
	});

	it('rejects a loopback host with no browser evidence when a secret is set', () => {
		process.env.API_SERVER_KEY = 'shared-secret-value';
		// Loopback Host, but neither Origin nor Sec-Fetch-Site nor Referer.
		expect(assertApiRequest(apiRequest('/api/chat'))?.status).toBe(401);

		const withEvidence = apiRequest('/api/chat', {
			headers: { 'sec-fetch-site': 'same-origin' }
		});
		expect(assertApiRequest(withEvidence)).toBeNull();
	});
});

describe('PROVIDERS table', () => {
	it('exposes exactly the seven documented providers, no key field in DEFAULTS', async () => {
		const { DEFAULTS } = await import('$lib/config');
		expect([...PROVIDERS]).toEqual([
			'hermes',
			'lmstudio',
			'opencode',
			'openrouter',
			'deepseek',
			'openclaw',
			'mimo'
		]);
		for (const provider of PROVIDERS) {
			expect(DEFAULTS[provider]).not.toHaveProperty('apiKey');
		}
	});
});
