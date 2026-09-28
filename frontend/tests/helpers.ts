import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

/**
 * Shared fixtures for the `/api/*` route tests.
 *
 * Every helper is deliberately small: the routes are plain
 * `(event: { request }) => Promise<Response>` functions, so a test only needs a
 * `Request`, a settings file and (for upstreams) a stubbed `fetch`.
 */

/** Loosest useful handler type — the routes only ever read `request`. */
export type RouteHandler = (event: { request: Request }) => Promise<Response>;

/** Invoke a SvelteKit `RequestHandler` with just the field the routes use. */
export async function call(handler: unknown, request: Request): Promise<Response> {
	return (handler as RouteHandler)({ request });
}

const ORIGIN = 'http://localhost:5173';

/**
 * Build a request that satisfies `assertApiRequest`'s loopback + same-origin
 * rules by default: loopback `Host`, matching `Origin`. Override headers per
 * test to exercise the guard's deny paths.
 */
export function apiRequest(pathname: string, init: RequestInit = {}): Request {
	const url = `${ORIGIN}${pathname}`;
	const headers = new Headers(init.headers);
	if (!headers.has('host')) headers.set('host', new URL(url).host);
	return new Request(url, { ...init, headers });
}

export function getRequest(pathname: string, init: RequestInit = {}): Request {
	return apiRequest(pathname, { ...init, method: 'GET' });
}

export function postJson(pathname: string, body: unknown, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json');
	return apiRequest(pathname, {
		...init,
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

// ── settings file ────────────────────────────────────────────────────────

/** Path `config.ts` reads: `process.cwd()` (the temp sandbox) + filename. */
export function settingsPath(): string {
	return path.join(process.cwd(), '.globe-settings.json');
}

/** Write raw settings as if the app had persisted them. */
export function writeSettingsFile(settings: unknown): void {
	fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
}

export function readSettingsFile(): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function clearSettingsFile(): void {
	fs.rmSync(settingsPath(), { force: true });
}

// ── upstream stubs ───────────────────────────────────────────────────────

/** A provider config that is allow-listed (loopback) and carries a fake key. */
export function providerSettings(overrides: {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	provider?: string;
} = {}): Record<string, unknown> {
	return {
		provider: overrides.provider ?? 'lmstudio',
		configs: {
			lmstudio: {
				baseUrl: overrides.baseUrl ?? 'http://127.0.0.1:9999/v1',
				model: overrides.model ?? 'stub-model',
				...(overrides.apiKey ? { apiKey: overrides.apiKey } : {})
			}
		}
	};
}

export type CapturedCall = { url: string; init: RequestInit };

/** SSE body the chat route relays verbatim: `data: {…}` frames + `[DONE]`. */
export function sseBody(frames: string[]): string {
	return `${frames.map((frame) => `data: ${frame}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

/**
 * Stub the global `fetch` (the routes' only door to the outside world) and
 * record every call. Returns the call list — push your own `Response` in via
 * `respondWith` before awaiting the handler.
 */
export function stubFetch(): {
	calls: CapturedCall[];
	respondWith: (fn: (call: CapturedCall) => Response | Promise<Response>) => void;
} {
	const calls: CapturedCall[] = [];
	let impl: ((call: CapturedCall) => Response | Promise<Response>) | null = null;

	vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
		const call = { url: String(input), init };
		calls.push(call);
		if (!impl) throw new Error(`Unexpected outbound fetch in test: ${call.url}`);
		return Promise.resolve(impl(call));
	});

	return {
		calls,
		respondWith: (fn) => {
			impl = fn;
		}
	};
}

/** Read an SSE route response as text (fails loudly on a non-string body). */
export async function readSse(res: Response): Promise<string> {
	return res.text();
}
