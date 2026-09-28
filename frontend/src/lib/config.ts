/**
 * Single validated config module for The Globe's `/api/*` routes.
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
 *   HERMES_API_KEY_HERMES / _LMSTUDIO / _OPENCODE / _OPENROUTER / _DEEPSEEK / _OPENCLAW / _MIMO
 *   HERMES_API_KEY_HERMES_AGENT / _OPENCLAW_AGENT  agent uplink keys
 *   HERMES_API_KEY                        generic fallback for all providers and agents
 *   VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY  TTS `openai` engine key
 *   ELEVENLABS_API_KEY                    TTS `elevenlabs` engine key
 *   API_SERVER_KEY                        shared secret for /api/* (see assertApiRequest)
 *   PIPER_MODEL                           TTS `piper` engine model path
 *   TTS_TIMEOUT_MS                        synthesis budget for POST /api/tts (default 120000)
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
	'openclaw',
	'mimo'
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Non-secret provider defaults. Deliberately has no `apiKey` field (C4). */
export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
	hermes: { baseUrl: '', model: 'hermes-agent' },
	// LM Studio's own loopback port, spelled `127.0.0.1`. Never a test-stub
	// port: an e2e mock (5224) once leaked into the owner's shipped config.
	lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: '' },
	opencode: { baseUrl: 'http://localhost:8765/v1', model: '' },
	openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
	deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
	openclaw: { baseUrl: '', model: '' },
	// Xiaomi MiMo (OpenAI-compatible). Pay-as-you-go endpoint; Token Plan users
	// override the base URL with their regional endpoint
	// (https://token-plan-{cn,sgp,ams}.xiaomimimo.com/v1).
	mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash' }
};

export type KeySource = 'env' | 'file' | 'none';

export interface ResolvedConfig {
	baseUrl: string;
	model: string;
	/** Resolved key — never log it, never echo it back. */
	apiKey: string;
	/** Where the key came from; `keySource !== 'none'` is exactly `hasKey`. */
	keySource: KeySource;
	/** Per-uplink wall-clock budget in ms — bounds /api/chat and /api/health. */
	timeoutMs: number;
}

interface ProviderFileConfig {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	/** Per-uplink wall-clock budget in ms (5 s – 10 min, default 120 s). */
	timeoutMs?: number;
}

/** TTS engines, Hermes-style: one selector, one per-engine section. */
export const TTS_PROVIDERS = ['system', 'piper', 'edge', 'openai', 'elevenlabs'] as const;

export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export function isTtsProvider(id: unknown): id is TtsProvider {
	return typeof id === 'string' && (TTS_PROVIDERS as readonly string[]).includes(id);
}

interface TtsFileConfig {
	provider?: TtsProvider;
	/** `system` engine voice name (OS-specific, optional — OS default otherwise). */
	voice?: string;
	/** `openai` / `elevenlabs` engine model. */
	model?: string;
	/** `openai` engine base URL (any OpenAI-compatible /audio/speech endpoint). */
	baseUrl?: string;
	/** Cloud-engine key — server-side only, never echoed back. */
	apiKey?: string;
	/** `piper` engine voice model path (legacy flat key still wins via PIPER_MODEL). */
	modelPath?: string;
}

/**
 * Agent uplink entries — remote Hermes / OpenClaw agent gateways.
 *
 * Separate from PROVIDER UPLINK on purpose: providers are stateless
 * OpenAI-compatible chat endpoints; agents are stateful (sessions, tools,
 * memory) and speak through their own gateway API. v1 routes them through
 * the same OpenAI-compatible SSE relay — the distinction lives in the
 * Settings sections, the uplink-mode switch, and the LINK readout.
 */
export const AGENTS = ['hermes-agent', 'openclaw-agent'] as const;

export type Agent = (typeof AGENTS)[number];

export function isAgent(id: unknown): id is Agent {
	return typeof id === 'string' && (AGENTS as readonly string[]).includes(id);
}

/** Which uplink carries chat: a stateless provider or a stateful agent. */
export const UPLINK_MODES = ['provider', 'agent'] as const;

export type UplinkMode = (typeof UPLINK_MODES)[number];

export function isUplinkMode(id: unknown): id is UplinkMode {
	return typeof id === 'string' && (UPLINK_MODES as readonly string[]).includes(id);
}

export const DEFAULT_UPLINK_MODE: UplinkMode = 'provider';

/** Non-secret agent defaults. No `apiKey` field — same rule as providers (C4). */
export const AGENT_DEFAULTS: Record<Agent, { baseUrl: string; model: string }> = {
	// Remote Hermes agent gateway (OpenAI-compatible chat surface).
	'hermes-agent': { baseUrl: '', model: 'hermes-agent' },
	// Remote OpenClaw gateway (OpenAI-compatible chat surface).
	'openclaw-agent': { baseUrl: '', model: '' }
};

/** Per-agent env var: `HERMES_API_KEY_HERMES_AGENT` / `_OPENCLAW_AGENT`. */
export function agentKeyEnvName(agent: Agent): string {
	return `HERMES_API_KEY_${agent.toUpperCase().replace(/-/g, '_')}`;
}

interface SettingsFile {
	provider?: Provider;
	systemPrompt?: string;
	configs?: Record<string, ProviderFileConfig>;
	tts?: TtsFileConfig;
	/** Active uplink section: `provider` (default) or `agent`. */
	uplinkMode?: UplinkMode;
	/** Selected agent entry (when `uplinkMode` is `agent`). */
	agent?: Agent;
	/** Per-agent overrides — same fields as providers, separate namespace. */
	agents?: Record<string, ProviderFileConfig>;
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
		keySource: apiKey === '' ? 'none' : fileKey ? 'file' : 'env',
		timeoutMs: resolveProviderTimeoutMs(override.timeoutMs)
	};
}

// ── per-provider uplink timeout ──────────────────────────────────────────

/** Default wall-clock budget for one provider uplink (chat stream / health probe). */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MIN_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_TIMEOUT_MS = 600_000;

/** Clamp a settings-file `timeoutMs` (or fall back to the default). */
export function resolveProviderTimeoutMs(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return DEFAULT_PROVIDER_TIMEOUT_MS;
	}
	return Math.min(Math.max(Math.round(raw), MIN_PROVIDER_TIMEOUT_MS), MAX_PROVIDER_TIMEOUT_MS);
}

/** `true` when a key is available for the provider — never exposes any part of it. */
export function hasKey(provider: Provider, settings: SettingsFile = readSettings()): boolean {
	return resolveConfig(provider, settings).keySource !== 'none';
}

// ── agent uplink resolution ──────────────────────────────────────────────

/** Default selected agent (when `uplinkMode` is `agent`). */
export const DEFAULT_AGENT: Agent = 'hermes-agent';

/**
 * Resolve the full config for an agent gateway.
 *
 * Same contract as providers: settings file (`agents.<id>`) → per-agent env
 * (`HERMES_API_KEY_HERMES_AGENT` / `_OPENCLAW_AGENT`) → generic env → ''.
 * baseUrl/model/timeoutMs: settings file overrides AGENT_DEFAULTS.
 */
export function resolveAgent(
	agent: Agent,
	settings: SettingsFile = readSettings()
): ResolvedConfig {
	const override = settings.agents?.[agent] ?? {};
	const fileKey = (override.apiKey ?? '').trim();
	const envKey = (process.env[agentKeyEnvName(agent)] ?? '').trim();
	const genericKey = (process.env[GENERIC_API_KEY_ENV] ?? '').trim();

	const apiKey = fileKey || envKey || genericKey || '';

	return {
		baseUrl: (override.baseUrl ?? '').trim() || AGENT_DEFAULTS[agent].baseUrl,
		model: (override.model ?? '').trim() || AGENT_DEFAULTS[agent].model,
		apiKey,
		keySource: apiKey === '' ? 'none' : fileKey ? 'file' : 'env',
		timeoutMs: resolveProviderTimeoutMs(override.timeoutMs)
	};
}

/** Resolve the active uplink — provider or agent — in one call. */
export function resolveUplink(settings: SettingsFile = readSettings()): {
	mode: UplinkMode;
	id: Provider | Agent;
	config: ResolvedConfig;
} {
	const mode = isUplinkMode(settings.uplinkMode) ? settings.uplinkMode : DEFAULT_UPLINK_MODE;
	if (mode === 'agent') {
		const agent = isAgent(settings.agent) ? settings.agent : DEFAULT_AGENT;
		return { mode, id: agent, config: resolveAgent(agent, settings) };
	}
	const provider = isProvider(settings.provider) ? settings.provider : 'hermes';
	return { mode, id: provider, config: resolveConfig(provider, settings) };
}

// ── upstream origin allow-list ───────────────────────────────────────────

const IMPLICIT_ALLOWED_HOSTS = [
	'openrouter.ai',
	'api.deepseek.com',
	'*.xiaomimimo.com',
	// Cloud TTS upstreams (POST /api/tts `openai` / `elevenlabs` engines).
	'api.openai.com',
	'api.elevenlabs.io'
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function allowedExtraHosts(): string[] {
	return (process.env.GLOB_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Allow-list for upstream provider origins.
 * Allows: `http(s)` only, plus loopback / RFC1918 private ranges / the
 * 100.64.0.0/10 CGNAT range (this is how Tailscale addresses a remote machine —
 * a remote LM Studio over a tailnet arrives as 100.x.y.z) and the explicit host
 * allow-list (defaults + GLOB_ALLOWED_ORIGINS). 100.64/10 is only routable
 * inside the local tailnet/VPN, never the open internet, so probing it cannot
 * escape the machine's own private networks. Everything else is rejected —
 * including link-local/cloud-metadata addresses (169.254.x.x), which never
 * match a private range here.
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
		// Tailscale / CGNAT shared range 100.64.0.0/10 — a remote LM Studio
		// over a tailnet lives here.
		if (a === 100 && b >= 64 && b <= 127) return true;
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
	ttsModelPath: 1024,
	ttsVoice: 256
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

	if (raw.uplinkMode !== undefined && raw.uplinkMode !== null && raw.uplinkMode !== '') {
		if (!isUplinkMode(raw.uplinkMode)) {
			throw new SettingsValidationError(`Unknown uplink mode: ${String(raw.uplinkMode)}`);
		}
		out.uplinkMode = raw.uplinkMode;
	}

	if (raw.agent !== undefined && raw.agent !== null && raw.agent !== '') {
		if (!isAgent(raw.agent)) {
			throw new SettingsValidationError(`Unknown agent: ${String(raw.agent)}`);
		}
		out.agent = raw.agent;
	}

	if (raw.agents !== undefined && raw.agents !== null) {
		if (typeof raw.agents !== 'object' || Array.isArray(raw.agents)) {
			throw new SettingsValidationError('agents must be an object');
		}
		const agents: Record<string, ProviderFileConfig> = {};
		for (const [id, value] of Object.entries(raw.agents as Record<string, unknown>)) {
			if (!isAgent(id)) throw new SettingsValidationError(`Unknown agent: ${id}`);
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new SettingsValidationError(`agents.${id} must be an object`);
			}
			const entry = value as Record<string, unknown>;
			const clean: ProviderFileConfig = {};
			for (const key of ['baseUrl', 'model', 'apiKey'] as const) {
				const raw = entry[key];
				if (raw === undefined || raw === null) continue;
				const label = `agents.${id}.${key}`;
				const str = assertString(raw, label, MAX_STRING[key]);
				if (key === 'baseUrl' && str !== '' && !isAllowedUrl(str)) {
					throw new SettingsValidationError(`URL not allowed: ${str}`);
				}
				clean[key] = str;
			}
			if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
				if (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs)) {
					throw new SettingsValidationError(`agents.${id}.timeoutMs must be a number`);
				}
				clean.timeoutMs = Math.min(
					Math.max(Math.round(entry.timeoutMs), MIN_PROVIDER_TIMEOUT_MS),
					MAX_PROVIDER_TIMEOUT_MS
				);
			}
			if (Object.keys(clean).length > 0) agents[id] = clean;
		}
		if (Object.keys(agents).length > 0) out.agents = agents;
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
			// Per-uplink timeout (ms): a positive number, clamped into range.
			// Invalid values are rejected — a silently-accepted hostile timeout is
			// the same pivot class as §4.1-2's hostile URL.
			if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
				if (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs)) {
					throw new SettingsValidationError(`configs.${id}.timeoutMs must be a number`);
				}
				clean.timeoutMs = Math.min(
					Math.max(Math.round(entry.timeoutMs), MIN_PROVIDER_TIMEOUT_MS),
					MAX_PROVIDER_TIMEOUT_MS
				);
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
		const clean: TtsFileConfig = {};
		if (tts.provider !== undefined && tts.provider !== null && tts.provider !== '') {
			if (typeof tts.provider !== 'string' || !isTtsProvider(tts.provider)) {
				throw new SettingsValidationError(`Unknown TTS provider: ${String(tts.provider)}`);
			}
			clean.provider = tts.provider;
		}
		// Empty strings are explicit clears, same contract as LLM provider fields.
		for (const [key, max] of [
			['voice', MAX_STRING.ttsVoice],
			['model', MAX_STRING.model],
			['baseUrl', MAX_STRING.baseUrl],
			['apiKey', MAX_STRING.apiKey],
			['modelPath', MAX_STRING.ttsModelPath]
		] as const) {
			const value = tts[key];
			if (value === undefined || value === null) continue;
			const str = assertString(value, `tts.${key}`, max);
			if (key === 'baseUrl' && str !== '' && !isAllowedUrl(str)) {
				throw new SettingsValidationError(`URL not allowed: ${str}`);
			}
			clean[key] = str;
		}
		if (Object.keys(clean).length > 0) out.tts = clean;
	}

	return out;
}

/** Merge a sanitised payload into stored settings (field-by-field, no clobbering). */
export function mergeSettings(current: SettingsFile, patch: SettingsFile): SettingsFile {
	const merged: SettingsFile = { ...current };

	if (patch.provider !== undefined) merged.provider = patch.provider;
	if (patch.systemPrompt !== undefined) merged.systemPrompt = patch.systemPrompt;
	if (patch.tts !== undefined) merged.tts = { ...merged.tts, ...patch.tts };
	if (patch.uplinkMode !== undefined) merged.uplinkMode = patch.uplinkMode;
	if (patch.agent !== undefined) merged.agent = patch.agent;

	if (patch.configs) {
		const configs: Record<string, ProviderFileConfig> = { ...merged.configs };
		for (const [id, value] of Object.entries(patch.configs)) {
			configs[id] = { ...configs[id], ...value };
		}
		merged.configs = configs;
	}

	if (patch.agents) {
		const agents: Record<string, ProviderFileConfig> = { ...merged.agents };
		for (const [id, value] of Object.entries(patch.agents)) {
			agents[id] = { ...agents[id], ...value };
		}
		merged.agents = agents;
	}

	return merged;
}

// ── public (key-free) settings view ──────────────────────────────────────

export interface PublicTtsSettings {
	provider: TtsProvider;
	voice?: string;
	model?: string;
	baseUrl?: string;
	modelPath?: string;
	hasKey: boolean;
	keySource: KeySource;
}

export interface PublicSettings {
	provider?: Provider;
	systemPrompt?: string;
	configs: Record<string, { baseUrl: string; model: string; hasKey: boolean; timeoutMs: number }>;
	keySource: Record<string, KeySource>;
	tts?: PublicTtsSettings;
	uplinkMode?: UplinkMode;
	agent?: Agent;
	agents: Record<string, { baseUrl: string; model: string; hasKey: boolean; timeoutMs: number }>;
	agentKeySource: Record<string, KeySource>;
}

/**
 * Build the `GET /api/settings` response by whitelisting fields.
 * There is no `apiKey` key anywhere in the returned tree — nothing to delete.
 */
export function settingsToPublic(settings: SettingsFile = readSettings()): PublicSettings {
	const out: PublicSettings = { configs: {}, keySource: {}, agents: {}, agentKeySource: {} };

	if (settings.provider !== undefined && isProvider(settings.provider))
		out.provider = settings.provider;
	if (typeof settings.systemPrompt === 'string') out.systemPrompt = settings.systemPrompt;
	if (isUplinkMode(settings.uplinkMode)) out.uplinkMode = settings.uplinkMode;
	if (isAgent(settings.agent)) out.agent = settings.agent;
	out.tts = settingsToPublicTts(settings);

	for (const provider of PROVIDERS) {
		const resolved = resolveConfig(provider, settings);
		out.configs[provider] = {
			baseUrl: resolved.baseUrl,
			model: resolved.model,
			hasKey: resolved.keySource !== 'none',
			timeoutMs: resolved.timeoutMs
		};
		out.keySource[provider] = resolved.keySource;
	}

	for (const agent of AGENTS) {
		const resolved = resolveAgent(agent, settings);
		out.agents[agent] = {
			baseUrl: resolved.baseUrl,
			model: resolved.model,
			hasKey: resolved.keySource !== 'none',
			timeoutMs: resolved.timeoutMs
		};
		out.agentKeySource[agent] = resolved.keySource;
	}

	return out;
}

// ── TTS engine resolution (Hermes-style engine table) ─────────────────────

export interface ResolvedTts {
	provider: TtsProvider;
	/** `system` / `piper` voice name or model path; cloud voice/model otherwise. */
	voice: string;
	model: string;
	/** `openai` engine endpoint (default: OpenAI). */
	baseUrl: string;
	/** Cloud-engine key — never log it, never echo it back. */
	apiKey: string;
	keySource: KeySource;
	/** `piper` engine voice model path (validated on use). */
	modelPath: string;
}

/** Default TTS engine: the OS-native voice — zero setup on every platform. */
export const DEFAULT_TTS_PROVIDER: TtsProvider = 'system';

export const DEFAULT_TTS_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_TTS_OPENAI_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_ELEVENLABS_MODEL = 'eleven_multilingual_v2';

/**
 * Resolve the TTS engine from settings (file wins, `system` default).
 *
 * Cloud-engine key precedence mirrors the LLM rule: settings file →
 * engine-specific env (`VOICE_TOOLS_OPENAI_KEY` / `OPENAI_API_KEY` for `openai`,
 * `ELEVENLABS_API_KEY` for `elevenlabs`) → ''. `piper` needs no key.
 */
export function resolveTts(settings: SettingsFile = readSettings()): ResolvedTts {
	const tts = settings.tts ?? {};
	const provider = isTtsProvider(tts.provider) ? tts.provider : DEFAULT_TTS_PROVIDER;

	let apiKey = '';
	let keySource: KeySource = 'none';
	if (provider === 'openai' || provider === 'elevenlabs') {
		const fileKey = (tts.apiKey ?? '').trim();
		const envKey =
			provider === 'openai'
				? (process.env.VOICE_TOOLS_OPENAI_KEY ?? '').trim() ||
					(process.env.OPENAI_API_KEY ?? '').trim()
				: (process.env.ELEVENLABS_API_KEY ?? '').trim();
		apiKey = fileKey || envKey || '';
		keySource = apiKey === '' ? 'none' : fileKey ? 'file' : 'env';
	}

	return {
		provider,
		voice: (tts.voice ?? '').trim(),
		model:
			(tts.model ?? '').trim() ||
			(provider === 'elevenlabs' ? DEFAULT_TTS_ELEVENLABS_MODEL : DEFAULT_TTS_OPENAI_MODEL),
		baseUrl: (tts.baseUrl ?? '').trim() || DEFAULT_TTS_OPENAI_BASE_URL,
		apiKey,
		keySource,
		modelPath: (process.env.PIPER_MODEL ?? '').trim() || (tts.modelPath ?? '').trim()
	};
}

/** Key-free TTS view for `GET /api/settings` — whitelisted, never a passthrough. */
export function settingsToPublicTts(settings: SettingsFile = readSettings()): PublicTtsSettings {
	const resolved = resolveTts(settings);
	const out: PublicTtsSettings = {
		provider: resolved.provider,
		hasKey: resolved.keySource !== 'none',
		keySource: resolved.keySource
	};
	if (resolved.voice) out.voice = resolved.voice;
	if (resolved.provider === 'openai' || resolved.provider === 'elevenlabs') {
		out.model = resolved.model;
		if (resolved.provider === 'openai') out.baseUrl = resolved.baseUrl;
	}
	if (resolved.provider === 'piper' && resolved.modelPath) out.modelPath = resolved.modelPath;
	return out;
}

/**
 * Resolve the Piper model path from `PIPER_MODEL` or settings, validating existence.
 *
 * D5: both failure branches name the exact path that was looked for (and where it
 * came from), so `POST /api/tts`'s 503 tells ops in one look what to fix.
 */
export function resolveTtsModelPath(settings: SettingsFile = readSettings()): {
	modelPath: string | null;
	error: string | null;
} {
	const { modelPath } = resolveTts(settings);
	const source = (process.env.PIPER_MODEL ?? '').trim()
		? 'PIPER_MODEL env var'
		: 'tts.modelPath in settings';

	if (!modelPath) {
		return {
			modelPath: null,
			error: `TTS model not configured — no path in PIPER_MODEL (env) or tts.modelPath (settings file read: ${SETTINGS_FILE})`
		};
	}

	try {
		const stat = fs.statSync(modelPath);
		if (!stat.isFile()) throw new Error('not a file');
	} catch {
		return { modelPath: null, error: `TTS model file not found: ${modelPath} (from ${source})` };
	}

	return { modelPath, error: null };
}

// ── TTS synthesis budget (D5) ────────────────────────────────────────────

/**
 * Default wall-clock budget for one `POST /api/tts` synthesis.
 *
 * Measured on the target machine (piper 1.2.0 + `en_US-lessac-medium.onnx`,
 * idle): a short sentence is **0.6–0.8 s**; a full-length (~2.8 k char, 184 s of
 * audio) reply is **27.6 s**. The old hard-coded 30 s cap sat on top of that,
 * so anything longer — or a loaded machine — returned 504. 120 s clears a
 * worst-case body with room to spare.
 */
export const DEFAULT_TTS_TIMEOUT_MS = 120_000;
const MIN_TTS_TIMEOUT_MS = 1_000;
const MAX_TTS_TIMEOUT_MS = 600_000;

/**
 * `TTS_TIMEOUT_MS` from env, clamped to [1 s, 10 min]. Unset, empty, non-numeric
 * or non-positive ⇒ the default. Read per request so ops can tune it without a
 * code change.
 */
export function resolveTtsTimeoutMs(): number {
	const raw = (process.env.TTS_TIMEOUT_MS ?? '').trim();
	if (!raw) return DEFAULT_TTS_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTS_TIMEOUT_MS;
	return Math.min(Math.max(Math.round(parsed), MIN_TTS_TIMEOUT_MS), MAX_TTS_TIMEOUT_MS);
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
	const name = host
		.toLowerCase()
		.replace(/:\d+$/, '')
		.replace(/^\[|\]$/g, '');
	return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function headerKeyMatches(request: Request, key: string): boolean {
	const bearer = request.headers
		.get('authorization')
		?.replace(/^Bearer\s+/i, '')
		.trim();
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
let warnedMissingSecret = false;

export function assertApiRequest(request: Request): Response | null {
	const host = request.headers.get('host');
	const origin = request.headers.get('origin');
	const site = request.headers.get('sec-fetch-site');

	// 1. Origin / fetch-metadata checks
	if (origin) {
		if (origin === 'null') return errorResponse(403, 'Cross-origin request rejected');
		let matches: boolean;
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
	if (!key && !warnedMissingSecret) {
		warnedMissingSecret = true;
		console.warn(
			'[api] API_SERVER_KEY is not set — /api/* relies on the loopback bind plus Host/Origin checks only. Set API_SERVER_KEY (BLUEPRINT.md:278) to enforce the shared secret.'
		);
	}
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

/**
 * Auth headers for an upstream provider call (never log the result).
 *
 * Most providers take the OpenAI-standard `Authorization: Bearer …`. Xiaomi
 * MiMo instead authenticates with the `api-key` header — both are sent for
 * `mimo` so either contract succeeds, and other providers are unaffected.
 */
export function providerHeaders(provider: Provider, apiKey: string): Record<string, string> {
	if (!apiKey) return {};
	if (provider === 'mimo') return { Authorization: `Bearer ${apiKey}`, 'api-key': apiKey };
	return bearerHeaders(apiKey);
}

/** Random throwaway key for tests — never a real credential. */
export function randomTestKey(): string {
	return randomBytes(16).toString('hex');
}
