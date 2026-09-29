import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// NOTE (SvelteKit >= 2.62): passing ANY options to sveltekit() here causes
// svelte.config.js to be ignored entirely — so call it bare and keep all
// SvelteKit config (adapter-node, compilerOptions) in svelte.config.js.
export default defineConfig({
	plugins: [sveltekit()],

	// P0-4: bind dev and preview to loopback only — /api/* must never be
	// reachable from the LAN. The shared-secret/Origin guard in $lib/config is
	// the second line of defence (DNS rebinding, hostile local pages).
	server: { host: '127.0.0.1' },
	preview: { host: '127.0.0.1' }
});
