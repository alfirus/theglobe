import { describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';

/** P2-2: the server hook stamps every response with the baseline headers. */
describe('hooks.server — baseline security headers (P2-2)', () => {
	it('sets nosniff, same-origin referrer, framing and permission headers', async () => {
		const res = await handle({
			event: {},
			resolve: async () => new Response('ok')
		} as unknown as Parameters<typeof handle>[0]);

		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
		expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
		const csp = res.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("frame-ancestors 'self'");
		expect(csp).toContain("base-uri 'self'");
		const pp = res.headers.get('Permissions-Policy') ?? '';
		expect(pp).toContain('camera=()');
		// The visor listens via the mic — never disable the microphone here.
		expect(pp).not.toContain('microphone=()');
	});
});
