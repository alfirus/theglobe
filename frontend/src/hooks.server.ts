import type { Handle } from '@sveltejs/kit';

/**
 * Baseline security headers (P2-2 defense-in-depth).
 *
 * The app is same-origin localhost, so these are belt-and-braces — but they
 * cost nothing and kill whole bug classes (MIME sniffing, referrer leaks to
 * the removed Google Fonts hosts, clickjacking, plugin/object execution).
 *
 * Deliberately NOT a full `default-src` lockdown: `connect-src` would need a
 * per-deployment inventory of provider baseUrls and `img-src`/`media-src` a
 * texture inventory — an over-strict CSP breaks the globe silently. The three
 * directives below are breakage-free by construction (no `default-src`, so
 * unset fetch types stay allowed).
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set(
		'Content-Security-Policy',
		"base-uri 'self'; object-src 'none'; frame-ancestors 'self'"
	);
	// The visor listens via the mic — camera/geolocation stay off by default.
	response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
	return response;
};
