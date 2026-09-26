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

/** Request-shape caps (contract: POST /api/chat — see card t_afd2c465). */
const MAX_MESSAGE = 32_000;
const MAX_SYSTEM_PROMPT = 8_000;
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_CONTENT = 16_000;

/**
 * Deadline for the provider's *response headers* only (P1-2: "no request
 * timeouts on the chat provider fetch"). Cleared the moment headers arrive, so
 * a long streaming reply is never cut off by it — D8's silent 200-with-no-body
 * now surfaces as `provider_timeout` instead of hanging the client for 120s.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** Provider answered 4xx/5xx — carries the upstream status for the client. */
class ProviderHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Provider error: ${status}`);
		this.name = 'ProviderHttpError';
		this.status = status;
	}
}

/** Provider sent no headers within `CONNECT_TIMEOUT_MS`. */
class ProviderTimeoutError extends Error {
	constructor() {
		super(`Provider did not respond within ${CONNECT_TIMEOUT_MS}ms`);
		this.name = 'ProviderTimeoutError';
	}
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

async function callProvider(
	baseUrl: string,
	apiKey: string,
	model: string,
	messages: ChatMessage[]
): Promise<Response> {
	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

	// Key material is never logged — only the endpoint and model.
	console.log(`Calling provider at ${url} with model ${model}`);

	// Headers-only deadline (see CONNECT_TIMEOUT_MS). The signal is dropped as
	// soon as the headers land, so it can never abort the streaming body.
	const gate = new AbortController();
	const deadline = setTimeout(() => gate.abort(), CONNECT_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ model, messages, stream: true }),
			signal: gate.signal
		});
	} catch (err) {
		if (gate.signal.aborted) {
			logEvent('chat', 'provider_timeout', { url, model, afterMs: CONNECT_TIMEOUT_MS }, 'error');
			throw new ProviderTimeoutError();
		}
		throw err;
	} finally {
		clearTimeout(deadline);
	}

	if (!response.ok) {
		const status = response.status;
		logEvent('chat', 'provider_http_error', { url, model, upstream: status }, 'error');
		throw new ProviderHttpError(status);
	}
	if (!response.body) {
		logEvent('chat', 'provider_no_body', { url, model, upstream: response.status }, 'error');
		throw new Error(`Provider returned HTTP ${response.status} with no body`);
	}

	// Relay the upstream SSE stream unchanged: `data: {"content":…}` / `data: [DONE]`.
	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = '';
			let forwarded = 0;
			let malformedFrames = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const data = line.slice(6).trim();
						if (data === '[DONE]') {
							controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
							continue;
						}
						try {
							const parsed = JSON.parse(data);
							const content = parsed.choices?.[0]?.delta?.content;
							if (content) {
								controller.enqueue(
									new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`)
								);
								forwarded += 1;
							}
						} catch {
							// Skip malformed upstream frames — one line for the first, then a count.
							malformedFrames += 1;
							if (malformedFrames === 1) {
								logEvent(
									'chat',
									'upstream_frame_malformed',
									{ bytes: data.length },
									'warn'
								);
							}
						}
					}
				}
				if (malformedFrames > 1) {
					logEvent('chat', 'upstream_frames_malformed', { count: malformedFrames }, 'warn');
				}
				if (forwarded === 0) {
					// 200 + SSE with nothing usable in it (D8): the client sees an empty
					// stream; log the shape here so the two sides can be correlated.
					logEvent('chat', 'upstream_stream_empty', { malformedFrames }, 'warn');
				}
			} catch (err) {
				logEvent('chat', 'stream_read_failed', { forwarded, ...errorFields(err) }, 'error');
			} finally {
				try {
					controller.close();
				} catch (closeErr) {
					logEvent('chat', 'stream_close_skipped', errorFields(closeErr), 'debug');
				}
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}

export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch (err) {
		logEvent('chat', 'request_body_invalid', errorFields(err), 'warn');
		return json({ error: 'Invalid JSON body', code: 'invalid_request' }, { status: 400 });
	}

	const message = body.message;
	if (!message || typeof message !== 'string') {
		return json({ error: 'Message is required', code: 'invalid_request' }, { status: 400 });
	}
	if (message.length > MAX_MESSAGE) {
		return json(
			{ error: `Message exceeds ${MAX_MESSAGE} characters`, code: 'payload_too_large' },
			{ status: 413 }
		);
	}

	const providerId = request.headers.get('x-provider') || 'hermes';
	if (!isProvider(providerId)) {
		return json({ error: `Invalid provider: ${providerId}`, code: 'invalid_provider' }, { status: 400 });
	}

	const settings = readSettings();
	const config = resolveConfig(providerId, settings);

	if (!config.baseUrl) {
		return json(
			{ error: `No base URL configured for ${providerId}`, code: 'not_configured' },
			{ status: 502 }
		);
	}
	if (!isAllowedUrl(config.baseUrl)) {
		return json({ error: `URL not allowed: ${config.baseUrl}`, code: 'url_not_allowed' }, { status: 400 });
	}

	// Contract: systemPrompt in the body (H5). The legacy X-System-Prompt header is
	// still accepted so a half-migrated client keeps working.
	const bodyPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
	const headerPrompt = request.headers.get('x-system-prompt') ?? '';
	const systemPrompt = (bodyPrompt || headerPrompt).slice(0, MAX_SYSTEM_PROMPT);

	const messages: ChatMessage[] = [];
	if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });

	// Contract: history[] precedes message, capped to the most recent entries (H6).
	if (Array.isArray(body.history)) {
		for (const entry of body.history.slice(-MAX_HISTORY_ENTRIES)) {
			if (!entry || typeof entry !== 'object') continue;
			const { role, content } = entry as { role?: unknown; content?: unknown };
			if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content) {
				messages.push({ role, content: content.slice(0, MAX_HISTORY_CONTENT) });
			}
		}
	}

	messages.push({ role: 'user', content: message });

	try {
		return await callProvider(config.baseUrl, config.apiKey, config.model, messages);
	} catch (err) {
		// One class per failure, all keeping the historical 503 status so the
		// wire contract holds; the machine `code` is what the UI switches on.
		if (err instanceof ProviderTimeoutError) {
			logEvent('chat', 'provider_timeout', { provider: providerId, model: config.model }, 'error');
			return json(
				{
					error: `${providerId} did not respond within ${CONNECT_TIMEOUT_MS / 1000}s`,
					code: 'provider_timeout'
				},
				{ status: 503 }
			);
		}
		if (err instanceof ProviderHttpError) {
			const code = err.status === 401 || err.status === 403 ? 'provider_auth' : 'provider_http';
			logEvent(
				'chat',
				'provider_http_error',
				{ provider: providerId, model: config.model, upstream: err.status, code },
				'error'
			);
			return json(
				{
					error: `${providerId} returned HTTP ${err.status}`,
					code,
					upstream: err.status
				},
				{ status: 503 }
			);
		}
		logEvent('chat', 'provider_unreachable', { provider: providerId, ...errorFields(err) }, 'error');
		return json({ error: `Cannot connect to ${providerId}`, code: 'provider_unreachable' }, { status: 503 });
	}
};
