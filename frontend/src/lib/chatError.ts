/**
 * Chat failure classification (P1-2, card t_94fa9c65).
 *
 * Every failure the chat path can produce lands in exactly one `ChatErrorKind`
 * so the UI can show a distinct, actionable line instead of the old single
 * canned string ("Cannot connect to <provider>. Check settings.").
 *
 * Copy rules: `title` is one short line that goes in the bubble, `detail` is one
 * actionable sentence (what to do next), `retryable` decides whether the bubble
 * offers a Retry button. Machine fields (`code`, `status`, `upstream`, `reason`)
 * are for the structured logs and never rendered verbatim unless they *are* the
 * actionable text.
 */
export type ChatErrorKind =
	/** Nothing configured for this provider (no base URL / host not allow-listed). */
	| 'config'
	/** Provider refused the connection or answered 5xx. */
	| 'provider'
	/** Provider answered 401/403 — key missing, wrong or revoked. */
	| 'auth'
	/** No bytes within the deadline (client timeout or upstream connect timeout). */
	| 'timeout'
	/** Stream started or should have started, but broke before a usable reply. */
	| 'stream'
	/** The local `/api/*` rejected the caller (shared secret / cross-origin). */
	| 'blocked'
	/** `/api/*` rejected the payload itself (400/413). */
	| 'request';

export interface ChatError {
	kind: ChatErrorKind;
	/** Short headline shown in the error bubble. */
	title: string;
	/** One sentence telling the user what to do. */
	detail: string;
	/** Whether a Retry button is meaningful for this class. */
	retryable: boolean;
	/** Server machine code when there was one (`code` field of the JSON body). */
	code?: string;
	/** HTTP status of the local API response. */
	status?: number;
	/** Upstream provider status, when the provider itself answered. */
	upstream?: number;
	/** Extra machine context for the logs (never rendered). */
	reason?: string;
}

/** Thrown inside `handleSend` so the catch block gets the classification intact. */
export class ChatFailure extends Error {
	readonly chat: ChatError;
	constructor(chat: ChatError) {
		super(chat.title);
		this.name = 'ChatFailure';
		this.chat = chat;
	}
}

// ── constructors (one per class — this is where the distinct copy lives) ──

export function configError(provider: string, code = 'not_configured'): ChatError {
	return {
		kind: 'config',
		title: `${provider} isn't configured`,
		detail: `No usable base URL for ${provider} — open Settings (bottom right) and set one.`,
		retryable: false,
		code
	};
}

export function urlNotAllowedError(provider: string, code = 'url_not_allowed'): ChatError {
	return {
		kind: 'config',
		title: `${provider} has a blocked base URL`,
		detail: 'That host is not on the upstream allow-list — change the Base URL in Settings.',
		retryable: false,
		code
	};
}

export function unreachableError(provider: string, reason?: string): ChatError {
	return {
		kind: 'provider',
		title: `Can't reach ${provider}`,
		detail: 'The provider refused the connection — check it is running and its Base URL is right.',
		retryable: true,
		code: 'provider_unreachable',
		reason
	};
}

export function upstreamHttpError(provider: string, upstream?: number): ChatError {
	return {
		kind: 'provider',
		title: `${provider} returned ${upstream ? `HTTP ${upstream}` : 'an error'}`,
		detail: 'The provider is up but erroring — check its logs, then retry.',
		retryable: true,
		code: 'provider_http',
		upstream
	};
}

export function authError(provider: string, upstream: number): ChatError {
	return {
		kind: 'auth',
		title: `${provider} rejected the request (HTTP ${upstream})`,
		detail: 'The API key is missing, wrong or expired — update it in Settings, then retry.',
		retryable: true,
		code: 'provider_auth',
		upstream
	};
}

export function timeoutError(provider: string, reason?: string): ChatError {
	return {
		kind: 'timeout',
		title: `${provider} timed out`,
		detail: 'No reply within the deadline — the model may be busy. Retry in a moment.',
		retryable: true,
		code: 'provider_timeout',
		reason
	};
}

export function streamError(provider: string, reason: string): ChatError {
	return {
		kind: 'stream',
		title: 'The reply stream broke',
		detail: `The connection to ${provider} dropped before a usable reply arrived — retry to get the full answer.`,
		retryable: true,
		code: 'stream_failed',
		reason
	};
}

export function blockedError(status: number, serverError?: string): ChatError {
	return {
		kind: 'blocked',
		title: `Blocked by the local API (HTTP ${status})`,
		detail: serverError
			? `${serverError} — this request never reached the provider.`
			: 'This request never reached the provider — check API_SERVER_KEY and that you are on loopback.',
		retryable: false,
		code: 'blocked',
		status
	};
}

export function requestError(status: number, serverError?: string): ChatError {
	return {
		kind: 'request',
		title: serverError || `Request rejected (HTTP ${status})`,
		detail: `The app's own API refused the request (HTTP ${status}) — adjust the message or Settings.`,
		retryable: false,
		code: 'invalid_request',
		status
	};
}

// ── classification ────────────────────────────────────────────────────────

export interface HttpFailure {
	/** Status of the local `/api/*` response. */
	status: number;
	/** `code` from the JSON body, when the server sent one. */
	code?: string;
	/** `error` from the JSON body — short server-written sentence. */
	serverError?: string;
	/** Upstream provider status, when the provider itself answered. */
	upstream?: number;
	provider: string;
}

/** Map a non-2xx `/api/chat` (or `/api/*`) response to exactly one class. */
export function classifyHttpFailure({
	status,
	code,
	serverError,
	upstream,
	provider
}: HttpFailure): ChatError {
	if (code === 'not_configured') return configError(provider, code);
	if (code === 'url_not_allowed') return urlNotAllowedError(provider, code);
	if (code === 'provider_timeout') return timeoutError(provider, serverError);
	if (
		code === 'provider_auth' ||
		upstream === 401 ||
		upstream === 403 ||
		((status === 502 || status === 503) && upstream !== undefined && (upstream === 401 || upstream === 403))
	) {
		return authError(provider, upstream ?? status);
	}
	if (code === 'provider_http') return upstreamHttpError(provider, upstream);
	if (code === 'provider_unreachable') return unreachableError(provider, serverError);
	if (status === 401 || status === 403) return blockedError(status, serverError);
	if (status >= 400 && status < 500) return requestError(status, serverError);
	// A coded 5xx we don't recognise still means the provider, not the payload.
	return unreachableError(provider, serverError || `HTTP ${status}`);
}

export interface ThrownFailure {
	provider: string;
	/** The client-side timeout abort fired. */
	timedOut: boolean;
	/** The user pressed Stop. */
	stopRequested: boolean;
	/** Assistant characters already rendered when it threw. */
	received: number;
}

/**
 * Classify a `catch (err)` from the send path.
 *
 * @returns `null` when the "failure" was the user pressing Stop — that is not an
 * error class and must not flash the globe.
 */
export function classifyThrownError(err: unknown, ctx: ThrownFailure): ChatError | null {
	if (err instanceof ChatFailure) return err.chat;

	const aborted = err instanceof DOMException && err.name === 'AbortError';
	if (aborted && ctx.stopRequested) return null;
	if (aborted && ctx.timedOut) return timeoutError(ctx.provider, 'client_timeout');

	// Bytes already reached the user → the stream died mid-reply; no bytes →
	// the provider never answered at all. Same `catch`, different user advice.
	if (ctx.received > 0) return streamError(ctx.provider, aborted ? 'aborted_mid_stream' : 'read_failed');
	return unreachableError(ctx.provider, err instanceof Error ? err.message : String(err));
}
