import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// NOTE (SvelteKit >= 2.62): passing ANY options to sveltekit() here causes
// svelte.config.js to be ignored entirely — so call it bare and keep all
// SvelteKit config (adapter-node, compilerOptions) in svelte.config.js.
// ADR-0002 Phase 1: opt-in dev proxy to globe-server. Default OFF — the
// SvelteKit TS routes stay the default until the Phase 3 cutover. Enable
// with GLOBE_USE_GO=1 (same shell that runs `go run ./server/...`); the
// target port follows GLOBE_API_PORT (default 8787).
const useGoBackend = process.env.GLOBE_USE_GO === '1';
const goApiTarget = `http://127.0.0.1:${process.env.GLOBE_API_PORT ?? '8787'}`;

export default defineConfig({
	plugins: [sveltekit()],

	// P0-4: bind dev and preview to loopback only — /api/* must never be
	// reachable from the LAN. The shared-secret/Origin guard in $lib/config is
	// the second line of defence (DNS rebinding, hostile local pages).
	server: {
		host: '127.0.0.1',
		...(useGoBackend ? { proxy: { '/api': goApiTarget } } : {})
	},
	preview: { host: '127.0.0.1' }
});
