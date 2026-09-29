import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit/API test config (P1-5, card t_644b7899).
 *
 * Deliberately separate from `vite.config.ts`: the SvelteKit plugin is not
 * needed to exercise the `routes/api/*` handlers or `db.ts`, and keeping the
 * two configs apart means `npm run test` never has to boot SvelteKit.
 *
 * `isolate: true` (the default, spelled out because `$lib/config` depends on
 * it) gives every test file a fresh module registry, so `config.ts` re-captures
 * `process.cwd()` — and therefore its `.globe-settings.json` path — from the
 * temp directory that `tests/setup.ts` chdirs into.
 */
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		environment: 'node',
		// e2e specs live under tests/e2e and are Playwright's, not Vitest's.
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/e2e/**', 'node_modules/**'],
		setupFiles: ['./tests/setup.ts'],
		pool: 'forks',
		isolate: true,
		restoreMocks: true,
		unstubGlobals: true,
		testTimeout: 15_000,
		reporter: process.env.CI ? ['default', 'junit'] : 'default',
		outputFile: { junit: './test-results/vitest-junit.xml' }
	}
});
