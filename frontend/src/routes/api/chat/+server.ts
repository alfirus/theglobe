import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAgent,
	isAllowedUrl,
	isProvider,
	isUplinkMode,
	providerHeaders,
	readSettings,
	resolveAgent,
	resolveConfig,
	type Agent,
	type Provider
} from '$lib/config';

/** Request-shape caps (contract: POST /api/chat — see card t_afd2c465). */
const MAX_MESSAGE = 32_000;
const MAX_SYSTEM_PROMPT = 8_000;
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_CONTENT = 16_000;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

async function callProvider(
	providerId: Provider,
	baseUrl: string,
	apiKey: string,
	model: string,
	timeoutMs: number,
	messages: ChatMessage[]
): Promise<Response> {
	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...providerHeaders(providerId, apiKey)
	};

	// Key material is never logged — only the endpoint, model and budget.
	console.log(`Calling provider at ${url} with model ${model} (timeout ${timeoutMs}ms)`);

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ model, messages, stream: true }),
			// Per-uplink budget: the whole stream (headers + every chunk) must
			// finish inside it. Expired → 504, not a silent hang.
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === 'TimeoutError') {
			console.error(`Provider timeout (${url}) after ${timeoutMs}ms`);
		const timeout = new Error(`Provider timed out after ${timeoutMs}ms`);
		(timeout as NodeJS.ErrnoException).code = 'UPSTREAM_TIMEOUT';
			throw timeout;
		}
		throw err;
	}

	if (!response.ok || !response.body) {
		const status = response.status;
		console.error(`Provider API error (${url}): HTTP ${status}`);
		throw new Error(`Provider error: ${status}`);
	}

	// Relay the upstream SSE stream unchanged: `data: {"content":…}` / `data: [DONE]`.
	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = '';
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
							const delta = parsed.choices?.[0]?.delta;
							// Reasoning deltas ride alongside `content` on their own field:
							// `reasoning_content` (MiMo, DeepSeek) or `reasoning`
							// (OpenRouter). Relayed as `thinking` frames so the client
							// can render them without mixing them into the answer.
							const thinking =
								(typeof delta?.reasoning_content === 'string' && delta.reasoning_content) ||
								(typeof delta?.reasoning === 'string' && delta.reasoning) ||
								'';
							if (thinking) {
								controller.enqueue(
									new TextEncoder().encode(`data: ${JSON.stringify({ thinking })}\n\n`)
								);
							}
							const content = delta?.content;
							if (content) {
								controller.enqueue(
									new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`)
								);
							}
						} catch {
							// Skip malformed upstream frames
						}
					}
				}
			} catch (err) {
				console.error('Stream read error:', err instanceof Error ? err.message : 'unknown');
			} finally {
				try {
					controller.close();
				} catch {
					/* already closed */
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
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const message = body.message;
	if (!message || typeof message !== 'string') {
		return json({ error: 'Message is required' }, { status: 400 });
	}
	if (message.length > MAX_MESSAGE) {
		return json({ error: `Message exceeds ${MAX_MESSAGE} characters` }, { status: 413 });
	}

	// Uplink routing: `X-Uplink-Mode: agent` + `X-Agent: <id>` reaches a remote
	// agent gateway; anything else (or a missing/garbage mode) is the classic
	// provider path. Both resolve server-side — the body never carries secrets.
	const uplinkMode = request.headers.get('x-uplink-mode') || 'provider';
	if (!isUplinkMode(uplinkMode)) {
		return json({ error: `Invalid uplink mode: ${uplinkMode}` }, { status: 400 });
	}

	const settings = readSettings();

	let uplinkId: Provider | Agent;
	if (uplinkMode === 'agent') {
		const agentId = request.headers.get('x-agent') || 'hermes-agent';
		if (!isAgent(agentId)) {
			return json({ error: `Invalid agent: ${agentId}` }, { status: 400 });
		}
		uplinkId = agentId;
	} else {
		const providerId = request.headers.get('x-provider') || 'hermes';
		if (!isProvider(providerId)) {
			return json({ error: `Invalid provider: ${providerId}` }, { status: 400 });
		}
		uplinkId = providerId;
	}

	const config = isAgent(uplinkId) ? resolveAgent(uplinkId, settings) : resolveConfig(uplinkId, settings);

	if (!config.baseUrl) {
		return json({ error: `No base URL configured for ${uplinkId}` }, { status: 502 });
	}
	if (!isAllowedUrl(config.baseUrl)) {
		return json({ error: `URL not allowed: ${config.baseUrl}` }, { status: 400 });
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
		// Agents speak the same OpenAI-compatible SSE surface in v1 — plain
		// Bearer auth. The `providerId` param only picks auth headers, and no
		// agent uses MiMo's `api-key` header, so providers pass their own id.
		const authId: Provider = isAgent(uplinkId) ? 'hermes' : uplinkId;
		return await callProvider(authId, config.baseUrl, config.apiKey, config.model, config.timeoutMs, messages);
	} catch (err) {
		console.error('Chat error:', err instanceof Error ? err.message : 'unknown error');
		if ((err as NodeJS.ErrnoException)?.code === 'UPSTREAM_TIMEOUT') {
			return json({ error: `${uplinkId} timed out after ${config.timeoutMs}ms` }, { status: 504 });
		}
		return json({ error: `Cannot connect to ${uplinkId}` }, { status: 503 });
	}
};
