import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAllowedUrl,
	isProvider,
	readSettings,
	resolveConfig
} from '$lib/config';

const PROBE_TIMEOUT_MS = 5000;

/**
 * POST /api/health — probe a configured provider.
 *
 * The caller-supplied `baseUrl` is validated against the upstream allow-list
 * before anything is fetched (M15/§4.1-2): this endpoint must never turn into a
 * general-purpose URL prober for internal networks or cloud metadata.
 * Redirects are not followed for the same reason.
 */
export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const providerId = body.providerId;
	const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

	if (!providerId || !baseUrl) {
		return json({ error: 'Provider ID and base URL are required' }, { status: 400 });
	}
	if (!isProvider(providerId)) {
		return json({ error: `Invalid provider: ${providerId}` }, { status: 400 });
	}
	if (!isAllowedUrl(baseUrl)) {
		return json({ error: `URL not allowed: ${baseUrl}` }, { status: 400 });
	}

	// A caller-supplied key is honoured for the probe; otherwise use the resolved one.
	// It is used as a bearer token only and never echoed back.
	const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
	const apiKey = suppliedKey || resolveConfig(providerId, readSettings()).apiKey;

	const root = baseUrl.replace(/\/+$/, '');
	const healthCheckUrls = [`${root}/health`, `${root}/v1/models`];

	let healthy = false;
	let responseTime = 0;
	let error = '';

	for (const url of healthCheckUrls) {
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

	return json({
		providerId,
		baseUrl,
		healthy,
		responseTime,
		error: healthy ? '' : error || 'No health endpoint responded',
		checkedAt: new Date().toISOString()
	});
};
