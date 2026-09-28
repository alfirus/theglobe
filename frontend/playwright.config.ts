import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the P1-5 smoke test (card t_644b7899).
 *
 * One test, one project (Chromium), headless — this is the CI gate, not a
 * browser-matrix run; Firefox/WebKit stay available locally via
 * `npx playwright install firefox webkit`.
 *
 * The dev server is started by Playwright itself and bound to loopback by
 * `vite.config.ts`, so the smoke never talks to anything but this machine, and
 * the provider upstream is stubbed inside the test (no live LLM calls).
 */
const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The spec needs the same origin for its raw `fetch` against /api/settings.
process.env.SMOKE_BASE_URL = BASE_URL;

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: /smoke\.spec\.ts$/,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 20_000 },
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	outputDir: './test-results',
	use: {
		baseURL: BASE_URL,
		headless: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		viewport: { width: 1440, height: 900 }
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `npm run dev -- --port ${PORT} --strictPort`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdio: 'ignore'
	}
});
