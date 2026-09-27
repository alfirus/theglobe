/**
 * Structured logging for The Globe — one greppable, machine-parseable line per
 * event, shared by the browser and the SvelteKit routes (P1-2).
 *
 *   [glob] stream_failed {"ts":"2026-09-27T…Z","scope":"chat","event":"stream_failed","kind":"stream",…}
 *
 * Rules (card t_94fa9c65):
 *   - never log message/prompt content, API keys or any key material — lengths,
 *     counts, HTTP statuses, error names and machine codes only;
 *   - user-facing copy lives in `chatError.ts`; logs are for us and carry the
 *     numbers the copy deliberately leaves out;
 *   - every catch in the chat path that used to swallow silently calls this
 *     instead — a swallowed error is an unobservable one.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Only scalar fields: keeps every record JSON-safe and small. */
export type LogField = string | number | boolean | null | undefined;

export function logEvent(
	scope: string,
	event: string,
	fields: Record<string, LogField> = {},
	level: LogLevel = 'info'
): void {
	const record = { ts: new Date().toISOString(), scope, event, ...fields };
	const write = console[level] ?? console.log;
	write.call(console, '[glob]', event, JSON.stringify(record));
}

/** Safe `catch (err)` projection: name + message, never a stack of secrets. */
export function errorFields(err: unknown): Record<string, LogField> {
	if (err instanceof Error) return { errName: err.name, err: err.message };
	return { err: String(err) };
}
