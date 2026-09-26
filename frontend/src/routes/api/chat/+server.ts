import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAllowedUrl,
	isProvider,
	readSettings,
	resolveConfig
} from '$lib/config';

/** Request-shape caps (contract: POST /api/chat — see card t_afd2c465). */
const MAX_MESSAGE = 32_000;
const MAX_SYSTEM_PROMPT = 8_000;
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_CONTENT = 16_000;

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

	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ model, messages, stream: true })
	});

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
							const content = parsed.choices?.[0]?.delta?.content;
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

	const providerId = request.headers.get('x-provider') || 'hermes';
	if (!isProvider(providerId)) {
		return json({ error: `Invalid provider: ${providerId}` }, { status: 400 });
	}

	const settings = readSettings();
	const config = resolveConfig(providerId, settings);

	if (!config.baseUrl) {
		return json({ error: `No base URL configured for ${providerId}` }, { status: 502 });
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
		return await callProvider(config.baseUrl, config.apiKey, config.model, messages);
	} catch (err) {
		console.error('Chat error:', err instanceof Error ? err.message : 'unknown error');
		return json({ error: `Cannot connect to ${providerId}` }, { status: 503 });
	}
};
