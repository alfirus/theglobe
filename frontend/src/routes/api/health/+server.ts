import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAgent,
	isAllowedUrl,
	isProvider,
	providerHeaders,
	readSettings,
	resolveAgent,
	resolveConfig,
	type Agent,
	type Provider
} from '$lib/config';
import { errorFields, logEvent } from '$lib/log';

const PROBE_TIMEOUT_MS = 5000;
/** A per-uplink budget must still bound a probe: at most ~30 s per URL. */
const MAX_PROBE_MS = 30_000;

/**
 * POST /api/health — probe a configured provider or agent (P1-2: surfaced health).
 *
 * Body: `{ providerId, baseUrl? }` or `{ agentId, baseUrl? }`. `baseUrl` is
 * optional: when it is omitted the endpoint resolves the stored base URL and
 * API key itself, so the UI can show health for the *server-side*
 * configuration. That is the whole point — a browser-side probe can never be
 * right, because the key only exists on the server (QA D2) and the upstream
 * has no CORS headers.
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

	const suppliedBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

	// Agent probe (`{ agentId }`) or provider probe (`{ providerId }`).
	const agentId = typeof body.agentId === 'string' ? body.agentId : '';
	const providerId = typeof body.providerId === 'string' ? body.providerId : '';

	// After the guards below, exactly one branch assigns — the union carries
	// the narrowing, so no casts are needed downstream.
	let uplinkId: Agent | Provider;
	if (agentId) {
		if (!isAgent(agentId)) {
			return json({ error: `Invalid agent: ${agentId}`, code: 'invalid_provider' }, { status: 400 });
		}
		uplinkId = agentId;
	} else {
		if (!providerId) {
			return json({ error: 'Provider ID is required', code: 'invalid_request' }, { status: 400 });
		}
		if (!isProvider(providerId)) {
			return json({ error: `Invalid provider: ${providerId}`, code: 'invalid_provider' }, { status: 400 });
		}
		uplinkId = providerId;
	}

	// Server-side resolution: stored (or env) base URL + key, never a wire key.
	// `isAgent` narrows the union, so each branch gets its own resolver.
	const resolved = isAgent(uplinkId)
		? resolveAgent(uplinkId, readSettings())
		: resolveConfig(uplinkId, readSettings());
	const baseUrl = suppliedBaseUrl || resolved.baseUrl;
	const apiKey = resolved.apiKey;

	if (!baseUrl) {
		return json(
			{ error: `No base URL configured for ${uplinkId}`, code: 'not_configured' },
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

	// The provider's own timeout caps the probe (a slow-LLM budget must not turn
	// "Check Connection" into a 2-minute hang), clamped to a 30 s probe ceiling.
	const probeMs = Math.min(resolved.timeoutMs, MAX_PROBE_MS);
	const perUrlMs = Math.min(PROBE_TIMEOUT_MS, Math.max(1_000, Math.floor(probeMs / probes.length)));

	// Agents take plain Bearer (none uses MiMo's `api-key` header).
	const authId: Provider = isAgent(uplinkId) ? 'hermes' : uplinkId;

	for (const url of probes) {
		try {
			const startTime = Date.now();
			const headers: Record<string, string> = { ...providerHeaders(authId, apiKey) };

			const response = await fetch(url, {
				method: 'GET',
				headers,
				redirect: 'manual',
				signal: AbortSignal.timeout(perUrlMs)
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
		providerId: uplinkId,
		baseUrl,
		healthy,
		responseTime,
		error: healthy ? '' : error || 'No health endpoint responded',
		checkedAt: new Date().toISOString()
	};

	logEvent(
		'health',
		'probe',
		{ providerId: uplinkId, healthy, ms: responseTime, error: result.error || undefined },
		healthy ? 'debug' : 'warn'
	);

	return json(result);
};
