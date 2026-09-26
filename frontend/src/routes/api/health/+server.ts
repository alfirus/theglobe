import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAllowedUrl,
	isProvider,
	readSettings,
	resolveConfig
} from '$lib/config';
import { errorFields, logEvent } from '$lib/log';

const PROBE_TIMEOUT_MS = 5000;

/**
 * POST /api/health — probe a configured provider (P1-2: surfaced health).
 *
 * Body: `{ providerId, baseUrl? }`. `baseUrl` is optional: when it is omitted
 * the endpoint resolves the provider's stored base URL and API key itself, so
 * the UI can show health for the *server-side* configuration. That is the whole
 * point — a browser-side probe can never be right, because the key only exists
 * on the server (QA D2) and the provider has no CORS headers.
 *
 * The caller-supplied `baseUrl`, when present, is validated against the upstream
 * allow-list before anything is fetched (M15/§4.1-2): this endpoint must never
 * turn into a general-purpose URL prober for internal networks or cloud
 * metadata. Redirects are not followed for the same reason.
 */
export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch (err) {
		logEvent('health', 'request_body_invalid', errorFields(err), 'warn');
		return json({ error: 'Invalid JSON body', code: 'invalid_request' }, { status: 400 });
	}

	const providerId = body.providerId;
	const suppliedBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

	if (!providerId) {
		return json({ error: 'Provider ID is required', code: 'invalid_request' }, { status: 400 });
	}
	if (!isProvider(providerId)) {
		return json({ error: `Invalid provider: ${providerId}`, code: 'invalid_provider' }, { status: 400 });
	}

	// Server-side resolution: stored (or env) base URL + key, never a wire key.
	const resolved = resolveConfig(providerId, readSettings());
	const baseUrl = suppliedBaseUrl || resolved.baseUrl;
	const apiKey = resolved.apiKey;

	if (!baseUrl) {
		return json(
			{ error: `No base URL configured for ${providerId}`, code: 'not_configured' },
			{ status: 400 }
		);
	}
	if (!isAllowedUrl(baseUrl)) {
		return json({ error: `URL not allowed: ${baseUrl}`, code: 'url_not_allowed' }, { status: 400 });
	}

	const root = baseUrl.replace(/\/+$/, '');
	// Shipped base URLs mostly already end in `/v1`, so probing `${root}/v1/models`
	// asked `/v1/v1/models` — it happened to answer 200 on LM Studio (QA D2 note).
	const probes = root.endsWith('/v1')
		? [`${root}/models`, `${root}/health`]
		: [`${root}/v1/models`, `${root}/health`];

	let healthy = false;
	let responseTime = 0;
	let error = '';

	for (const url of probes) {
		try {
			const startTime = Date.now();
			const headers: Record<string, string> = {};
			if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

			const response = await fetch(url, {
				method: 'GET',
				headers,
				redirect: 'manual',
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
			});

			responseTime = Date.now() - startTime;

			if (response.ok) {
				healthy = true;
				break;
			}
			error = `HTTP ${response.status}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Connection failed';
			continue;
		}
	}

	const result = {
		providerId,
		baseUrl,
		healthy,
		responseTime,
		error: healthy ? '' : error || 'No health endpoint responded',
		checkedAt: new Date().toISOString()
	};

	logEvent(
		'health',
		'probe',
		{ providerId, healthy, ms: responseTime, error: result.error || undefined },
		healthy ? 'debug' : 'warn'
	);

	return json(result);
};
