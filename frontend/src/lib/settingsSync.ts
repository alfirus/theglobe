/**
 * Browser-side settings hydration (QA defect D1).
 *
 * The client used to read `provider/systemPrompt/configs` from `localStorage`
 * alone. On a fresh profile (first run, new browser, private window) that copy
 * does not exist, so the app fell back to the code default `hermes` with an
 * empty base URL and every first message died with `502 No base URL configured`.
 *
 * The server already holds the truth — `GET /api/settings` returns the
 * key-free view (`provider`, `systemPrompt`, `configs[*].{baseUrl,model,hasKey}`)
 * — so hydration reads it and fills in exactly the fields the browser has never
 * set:
 *
 *   - local edits always win, including an explicit `""` (the user cleared it);
 *   - the server fills the rest, so the server-side prefill ("zero setup first
 *     message") reaches a brand-new browser;
 *   - **nothing is written back**: a prefill must stay a prefill, otherwise the
 *     first page load would copy it into `localStorage` and shadow every later
 *     server-side change. `localStorage` only ever receives fields the user
 *     actually edited (see `Settings.svelte persistSettings`).
 *
 * No key material is involved in either direction: `GET /api/settings` is
 * key-free by construction and `localStorage` is never given an `apiKey`.
 */

export interface LocalProviderConfig {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
}

export interface LocalSettings {
	provider?: string;
	systemPrompt?: string;
	configs?: Record<string, LocalProviderConfig>;
	/** Older/unknown keys are preserved verbatim. */
	[key: string]: unknown;
}

export interface ServerConfigView {
	baseUrl?: string;
	model?: string;
	hasKey?: boolean;
	/** Only reachable when an old server echoes it — never trusted as a key. */
	[key: string]: unknown;
}

export interface ServerSettingsView {
	provider?: string;
	systemPrompt?: string;
	configs?: Record<string, ServerConfigView>;
	[key: string]: unknown;
}

/** One storage key for the whole app. */
export const SETTINGS_STORAGE_KEY = 'globe-settings';

/** A hung server must never block the UI that is hydrating from it. */
const HYDRATE_TIMEOUT_MS = 5000;

/** `localStorage` copy — `{ provider, systemPrompt, configs }`, never a key. */
export function readLocalSettings(): LocalSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		const parsed: unknown = JSON.parse(raw || '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as LocalSettings;
	} catch {
		return {};
	}
}

let inflight: Promise<ServerSettingsView | null> | null = null;

/**
 * `GET /api/settings`, fetched at most once per page load no matter how many
 * components hydrate from it. A failed attempt clears the cache so a later
 * caller can retry instead of inheriting `null` for the rest of the session.
 */
export function fetchServerSettings(): Promise<ServerSettingsView | null> {
	if (inflight) return inflight;

	const request = (async () => {
		try {
			const res = await fetch('/api/settings', {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(HYDRATE_TIMEOUT_MS)
			});
			if (!res.ok) return null;
			const data: unknown = await res.json();
			if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
			return data as ServerSettingsView;
		} catch {
			// Offline, pre-upgrade server or timeout: hydration is best-effort.
			return null;
		}
	})().then((value) => {
		if (value === null) inflight = null;
		return value;
	});

	inflight = request;
	return request;
}

/**
 * Pure merge: local wins, the server fills what the browser never set.
 *
 * A local value of `""` counts as "set" on purpose — it is how the user says
 * "cleared", and it must not be re-filled from the server (that is D3's wipe in
 * reverse).
 */
export function mergeServerIntoLocal(
	local: LocalSettings,
	server: ServerSettingsView | null
): LocalSettings {
	const merged: LocalSettings = { ...local };
	if (!server) return merged;

	const localProvider = local.provider;
	if (typeof localProvider !== 'string' || localProvider === '') {
		if (typeof server.provider === 'string' && server.provider !== '') {
			merged.provider = server.provider;
		}
	}

	if (typeof local.systemPrompt !== 'string') {
		if (typeof server.systemPrompt === 'string') merged.systemPrompt = server.systemPrompt;
	}

	const serverConfigs = server.configs;
	if (serverConfigs && typeof serverConfigs === 'object') {
		const configs: Record<string, LocalProviderConfig> = { ...(local.configs || {}) };
		let touched = false;

		for (const [id, cfg] of Object.entries(serverConfigs)) {
			if (!cfg || typeof cfg !== 'object') continue;
			const current: LocalProviderConfig = { ...(configs[id] || {}) };
			let entryTouched = false;

			for (const field of ['baseUrl', 'model'] as const) {
				const existing = current[field];
				if (typeof existing === 'string') continue; // local — including "" — wins
				const fromServer = cfg[field];
				if (typeof fromServer === 'string' && fromServer !== '') {
					current[field] = fromServer;
					entryTouched = true;
				}
			}

			if (entryTouched) {
				configs[id] = current;
				touched = true;
			}
		}

		if (touched || Object.keys(configs).length > 0) merged.configs = configs;
	}

	return merged;
}

/**
 * Effective settings for this page load: `localStorage` first, the server's
 * prefill for everything the browser has never set. Writes nothing.
 */
export async function loadEffectiveSettings(): Promise<LocalSettings> {
	const local = readLocalSettings();
	const server = await fetchServerSettings();
	return mergeServerIntoLocal(local, server);
}
