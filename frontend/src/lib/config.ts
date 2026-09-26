/**
 * Single validated config module for The Glob's `/api/*` routes.
 *
 * Every API route imports from here instead of re-declaring its own copy of the
 * provider table (it was triplicated across api/chat, api/health and api/settings).
 *
 * Secret-handling standard — ratified v2 (Alya, card t_cc46938d):
 *   apiKey = settings.configs[provider].apiKey
 *          ?? process.env[`HERMES_API_KEY_${PROVIDER}`]   // per-provider, primary
 *          ?? process.env['HERMES_API_KEY']               // generic, last resort
 *          ?? ''
 *   - `DEFAULTS` never carries an `apiKey` field (C4 removal)
 *   - `GET /api/settings` is built by whitelisting fields — never a passthrough
 *   - no credential material in responses, logs or error messages, ever
 *
 * Env vars:
 *   HERMES_API_KEY_HERMES / _LMSTUDIO / _OPENCODE / _OPENROUTER / _DEEPSEEK / _OPENCLAW
 *   HERMES_API_KEY                        generic fallback for all providers
 *   API_SERVER_KEY                        shared secret for /api/* (see assertApiRequest)
 *   PIPER_MODEL                           TTS model path
 *   GLOB_ALLOWED_ORIGINS                  optional comma-separated extra upstream hosts
 *
 * Integration decisions (Maisarah, EM — integration flags #1/#2, ratified by Alya):
 *   - the shared secret is required unless the request proves same-origin, so the
 *     shipped client (no secret header) keeps working;
 *   - `POST /api/settings` strips unknown fields instead of rejecting them — only
 *     invalid *values* are rejected (4xx).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROVIDERS = [
	'hermes',
	'lmstudio',
	'opencode',
	'openrouter',
	'deepseek',
	'openclaw'
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Non-secret provider defaults. Deliberately has no `apiKey` field (C4). */
export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
	hermes: { baseUrl: '', model: 'hermes-agent' },
	lmstudio: { baseUrl: 'http://localhost:1234/v1', model: '' },
	opencode: { baseUrl: 'http://localhost:8765/v1', model: '' },
	openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
	deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
	openclaw: { baseUrl: '', model: '' }
};

export type KeySource = 'env' | 'file' | 'none';

export interface ResolvedConfig {
	baseUrl: string;
	model: string;
	/** Resolved key — never log it, never echo it back. */
	apiKey: string;
	/** Where the key came from; `keySource !== 'none'` is exactly `hasKey`. */
	keySource: KeySource;
}

interface ProviderFileConfig {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
}

interface SettingsFile {
	provider?: Provider;
	systemPrompt?: string;
	configs?: Record<string, ProviderFileConfig>;
	tts?: { modelPath?: string };
}

const SETTINGS_FILE = path.join(process.cwd(), '.globe-settings.json');
const MAX_SETTINGS_BYTES = 64 * 1024;

// ── settings file ────────────────────────────────────────────────────────

/** Read `.globe-settings.json`. Any read/parse failure yields `{}` (never throws). */
export function readSettings(): SettingsFile {
	try {
		const stat = fs.statSync(SETTINGS_FILE);
		if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return {};
		const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as SettingsFile;
	} catch {
		return {};
	}
}

/** Write the settings file (caller must have validated/sanitised the value). */
export function writeSettings(settings: SettingsFile): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function isProvider(id: unknown): id is Provider {
	return typeof id === 'string' && (PROVIDERS as readonly string[]).includes(id);
}

// ── provider resolution ──────────────────────────────────────────────────

/** Per-provider env var: `HERMES_API_KEY_<PROVIDER>` (uppercased provider id). */
export function apiKeyEnvName(provider: Provider): string {
	return `HERMES_API_KEY_${provider.toUpperCase()}`;
}

/** Generic last-resort env var covering every provider. */
export const GENERIC_API_KEY_ENV = 'HERMES_API_KEY';

/**
 * Resolve the full config for a provider.
 *
 * apiKey precedence (ratified): settings file → per-provider env → generic env → ''.
 * The file is the user-visible source of truth — a key typed into the UI during a
 * live test must win over a stale environment value.
 *
 * baseUrl/model: settings file overrides DEFAULTS.
 */
export function resolveConfig(
	provider: Provider,
	settings: SettingsFile = readSettings()
): ResolvedConfig {
	const override = settings.configs?.[provider] ?? {};
	const fileKey = (override.apiKey ?? '').trim();
	const envKey = (process.env[apiKeyEnvName(provider)] ?? '').trim();
	const genericKey = (process.env[GENERIC_API_KEY_ENV] ?? '').trim();

	const apiKey = fileKey || envKey || genericKey || '';

	return {
		baseUrl: (override.baseUrl ?? '').trim() || DEFAULTS[provider].baseUrl,
		model: (override.model ?? '').trim() || DEFAULTS[provider].model,
		apiKey,
		keySource: apiKey === '' ? 'none' : fileKey ? 'file' : 'env'
	};
}

/** `true` when a key is available for the provider — never exposes any part of it. */
export function hasKey(provider: Provider, settings: SettingsFile = readSettings()): boolean {
	return resolveConfig(provider, settings).keySource !== 'none';
}

// ── upstream origin allow-list ───────────────────────────────────────────

const IMPLICIT_ALLOWED_HOSTS = ['openrouter.ai', 'api.deepseek.com'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function allowedExtraHosts(): string[] {
	return (process.env.GLOB_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Allow-list for upstream provider origins.
 * Allows: `http(s)` only, plus loopback / RFC1918 private ranges (this is a local
 * desktop app) and the explicit host allow-list (defaults + GLOB_ALLOWED_ORIGINS).
 * Everything else is rejected — including link-local/cloud-metadata addresses
 * (169.254.x.x), which never match a private range here.
 */
export function isAllowedUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
		return true;
	}

	if (IPV4.test(host)) {
		const [a, b] = host.split('.').map(Number);
		if (a === 10) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	const allowed = [...IMPLICIT_ALLOWED_HOSTS, ...allowedExtraHosts()];
	return allowed.some((entry) =>
		entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry
	);
}

// ── settings payload validation (POST /api/settings) ─────────────────────

const MAX_STRING = {
	baseUrl: 2048,
	model: 512,
	apiKey: 512,
	systemPrompt: 8000,
	ttsModelPath: 1024
};

export class SettingsValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SettingsValidationError';
	}
}

function assertString(value: unknown, label: string, max: number): string {
	if (typeof value !== 'string') {
		throw new SettingsValidationError(`${label} must be a string`);
	}
	if (value.length > max) {
		throw new SettingsValidationError(`${label} exceeds ${max} characters`);
	}
	return value;
}

/**
 * Validate + sanitise a `POST /api/settings` body.
 *
 * Unknown *fields* are dropped (whitelist projection) — never a blanket 400, so a
 * client that posts its whole settings blob still saves. Known fields with invalid
 * *values* (wrong type, over length cap, non-allow-listed URL) are rejected with a
 * 4xx: silently accepting a hostile upstream URL is the §4.1-2 pivot primitive.
 *
 * @throws {SettingsValidationError} on an invalid value.
 */
export function sanitizeSettingsBody(body: unknown): SettingsFile {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new SettingsValidationError('Body must be a JSON object');
	}
	const raw = body as Record<string, unknown>;
	const out: SettingsFile = {};

	if (raw.provider !== undefined && raw.provider !== null && raw.provider !== '') {
		if (!isProvider(raw.provider)) {
			throw new SettingsValidationError(`Unknown provider: ${String(raw.provider)}`);
		}
		out.provider = raw.provider;
	}

	if (raw.systemPrompt !== undefined && raw.systemPrompt !== null && raw.systemPrompt !== '') {
		out.systemPrompt = assertString(raw.systemPrompt, 'systemPrompt', MAX_STRING.systemPrompt);
	}

	if (raw.configs !== undefined && raw.configs !== null) {
		if (typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
			throw new SettingsValidationError('configs must be an object');
		}
		const configs: Record<string, ProviderFileConfig> = {};
		for (const [id, value] of Object.entries(raw.configs as Record<string, unknown>)) {
			if (!isProvider(id)) throw new SettingsValidationError(`Unknown provider: ${id}`);
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new SettingsValidationError(`configs.${id} must be an object`);
			}
			const entry = value as Record<string, unknown>;
			const clean: ProviderFileConfig = {};

			// An empty string is an explicit "clear this field" (rotation, switching
			// providers) — it must be stored so the file no longer shadows env/defaults.
			for (const key of ['baseUrl', 'model', 'apiKey'] as const) {
				const raw = entry[key];
				if (raw === undefined || raw === null) continue;
				const label = `configs.${id}.${key}`;
				const str = assertString(raw, label, MAX_STRING[key]);
				if (key === 'baseUrl' && str !== '' && !isAllowedUrl(str)) {
					throw new SettingsValidationError(`URL not allowed: ${str}`);
				}
				clean[key] = str;
			}
			if (Object.keys(clean).length > 0) configs[id] = clean;
		}
		if (Object.keys(configs).length > 0) out.configs = configs;
	}

	if (raw.tts !== undefined && raw.tts !== null) {
		if (typeof raw.tts !== 'object' || Array.isArray(raw.tts)) {
			throw new SettingsValidationError('tts must be an object');
		}
		const tts = raw.tts as Record<string, unknown>;
		if (tts.modelPath !== undefined && tts.modelPath !== null && tts.modelPath !== '') {
			out.tts = {
				modelPath: assertString(tts.modelPath, 'tts.modelPath', MAX_STRING.ttsModelPath)
			};
		}
	}

	return out;
}

/** Merge a sanitised payload into stored settings (field-by-field, no clobbering). */
export function mergeSettings(current: SettingsFile, patch: SettingsFile): SettingsFile {
	const merged: SettingsFile = { ...current };

	if (patch.provider !== undefined) merged.provider = patch.provider;
	if (patch.systemPrompt !== undefined) merged.systemPrompt = patch.systemPrompt;
	if (patch.tts !== undefined) merged.tts = { ...merged.tts, ...patch.tts };

	if (patch.configs) {
		const configs: Record<string, ProviderFileConfig> = { ...merged.configs };
		for (const [id, value] of Object.entries(patch.configs)) {
			configs[id] = { ...configs[id], ...value };
		}
		merged.configs = configs;
	}

	return merged;
}

// ── public (key-free) settings view ──────────────────────────────────────

export interface PublicSettings {
	provider?: Provider;
	systemPrompt?: string;
	configs: Record<string, { baseUrl: string; model: string; hasKey: boolean }>;
	keySource: Record<string, KeySource>;
	tts?: { modelPath?: string };
}

/**
 * Build the `GET /api/settings` response by whitelisting fields.
 * There is no `apiKey` key anywhere in the returned tree — nothing to delete.
 */
export function settingsToPublic(settings: SettingsFile = readSettings()): PublicSettings {
	const out: PublicSettings = { configs: {}, keySource: {} };

	if (settings.provider !== undefined && isProvider(settings.provider)) out.provider = settings.provider;
	if (typeof settings.systemPrompt === 'string') out.systemPrompt = settings.systemPrompt;
	if (settings.tts && typeof settings.tts.modelPath === 'string') {
		out.tts = { modelPath: settings.tts.modelPath };
	}

	for (const provider of PROVIDERS) {
		const resolved = resolveConfig(provider, settings);
		out.configs[provider] = {
			baseUrl: resolved.baseUrl,
			model: resolved.model,
			hasKey: resolved.keySource !== 'none'
		};
		out.keySource[provider] = resolved.keySource;
	}

	return out;
}

// ── TTS model resolution (M4) ────────────────────────────────────────────

/** Resolve the Piper model path from `PIPER_MODEL` or settings, validating existence. */
export function resolveTtsModelPath(settings: SettingsFile = readSettings()): {
	modelPath: string | null;
	error: string | null;
} {
	const fromEnv = (process.env.PIPER_MODEL ?? '').trim();
	const fromFile = (settings.tts?.modelPath ?? '').trim();
	const modelPath = fromEnv || fromFile;

	if (!modelPath) {
		return {
			modelPath: null,
			error: 'TTS model not configured — set the PIPER_MODEL env var or tts.modelPath in settings'
		};
	}

	try {
		const stat = fs.statSync(modelPath);
		if (!stat.isFile()) throw new Error('not a file');
	} catch {
		return { modelPath: null, error: `TTS model file not found: ${modelPath}` };
	}

	return { modelPath, error: null };
}

// ── shared-secret guard for /api/* (P0-4) ────────────────────────────────

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'utf-8');
	const bufB = Buffer.from(b, 'utf-8');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(host: string | null): boolean {
	if (!host) return false;
	const name = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function headerKeyMatches(request: Request, key: string): boolean {
	const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
	if (bearer && safeEqual(bearer, key)) return true;
	const apiKeyHeader = request.headers.get('x-api-key')?.trim();
	if (apiKeyHeader && safeEqual(apiKeyHeader, key)) return true;
	return false;
}

function errorResponse(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Guard for every `/api/*` route. Returns `null` when the request may proceed,
 * otherwise the error `Response` the route must return.
 *
 * Rules (EM integration flag #2, ratified by Alya §4.3):
 *  1. `Origin`, when present, must be a parseable http(s) origin that matches our
 *     own host exactly. `Origin: null` and any foreign origin → 403. `Sec-Fetch-Site:
 *     cross-site` → 403.
 *  2. A valid shared secret (`API_SERVER_KEY` as `Authorization: Bearer …` or
 *     `X-API-Key`, compared timing-safely) always admits the caller — the code path
 *     stays implemented for non-browser clients.
 *  3. Same-origin exemption: a request that proves it came from the app (loopback
 *     `Host` + browser same-origin evidence) is admitted without the secret, so the
 *     shipped client keeps working. With a secret configured, absence of `Origin` is
 *     only acceptable on a browser GET (`Sec-Fetch-Site: same-origin`) or when a
 *     `Referer` names our own origin.
 *  4. `Host` must be loopback (kills DNS rebinding, where the attacker's page carries
 *     a same-origin-looking `Origin`). Off-loopback requests need the secret.
 */
export function assertApiRequest(request: Request): Response | null {
	const host = request.headers.get('host');
	const origin = request.headers.get('origin');
	const site = request.headers.get('sec-fetch-site');

	// 1. Origin / fetch-metadata checks
	if (origin) {
		if (origin === 'null') return errorResponse(403, 'Cross-origin request rejected');
		let matches = false;
		try {
			const url = new URL(origin);
			matches =
				(url.protocol === 'http:' || url.protocol === 'https:') && !!host && url.host === host;
		} catch {
			matches = false;
		}
		if (!matches) return errorResponse(403, 'Cross-origin request rejected');
	}
	if (site === 'cross-site') return errorResponse(403, 'Cross-origin request rejected');

	// 2. Shared secret (timing-safe), either accepted header spelling
	const key = (process.env.API_SERVER_KEY ?? '').trim();
	if (key && headerKeyMatches(request, key)) return null;

	// 3. Same-origin exemption
	if (isLoopbackHost(host)) {
		if (!key) return null; // no secret configured — loopback bind + Host check are the control

		const browserEvidence = !!origin || site === 'same-origin' || !!request.headers.get('referer');
		if (browserEvidence) return null;

		return errorResponse(401, 'Unauthorized');
	}

	return errorResponse(
		401,
		'Unauthorized — this host is not loopback; set API_SERVER_KEY to reach /api/*'
	);
}

/** `Authorization` headers for server-side outbound calls (never log the result). */
export function bearerHeaders(apiKey: string): Record<string, string> {
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Random throwaway key for tests — never a real credential. */
export function randomTestKey(): string {
	return randomBytes(16).toString('hex');
}
