/**
 * Client-side Globe event bus — feeds the GLOB LOG rail (OpsLog).
 *
 * Every entry is a real app event pushed at the site where it happens (chat
 * lifecycle in `+page.svelte`, health probes in `TelemetryRail` / `Settings`,
 * TTS in `+page.svelte`). Nothing here is decorative: if no event fires, the
 * rail stays empty. Capped ring buffer (120) so a long session can't leak.
 */

export type GlobTag = 'LINK' | 'CHAT' | 'STREAM' | 'TTS' | 'HEALTH' | 'ERROR' | 'SYS';

export interface GlobEvent {
	id: number;
	ts: number;
	tag: GlobTag;
	msg: string;
}

const MAX_EVENTS = 120;

let seq = 0;
const buf: GlobEvent[] = [];
const subs = new Set<(e: GlobEvent) => void>();

export function pushEvent(tag: GlobTag, msg: string): GlobEvent {
	const event: GlobEvent = { id: ++seq, ts: Date.now(), tag, msg };
	buf.push(event);
	if (buf.length > MAX_EVENTS) buf.splice(0, buf.length - MAX_EVENTS);
	subs.forEach((fn) => {
		try {
			fn(event);
		} catch {
			/* a logging subscriber must never break the app */
		}
	});
	return event;
}

/** Newest-first snapshot for initial render. */
export function recentEvents(n = 40): GlobEvent[] {
	return buf.slice(-n).reverse();
}

export function subscribe(fn: (e: GlobEvent) => void): () => void {
	subs.add(fn);
	return () => {
		subs.delete(fn);
	};
}

export function fmtTime(ts: number): string {
	return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}
