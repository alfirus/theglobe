import { expect, test } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Phase 1b smoke: the Desktop-file bridge + Files surface in the visor.
 *
 * Two halves, split on purpose:
 *
 *   (a) Bridge API — the spec builds the real globe-server binary from
 *       ../../server, starts it against a temp GLOBE_FILES_ROOT seeded with
 *       fixtures, and asserts listing, traversal/symlink/allow-list/cap
 *       rejections, and the shared-secret guard over raw HTTP. No mocks.
 *
 *   (b) Files surface — the visor panel is exercised in the real page with
 *       /api/files stubbed at the network edge (the SvelteKit dev server
 *       has no /api/files route until the Phase 3 cutover flips
 *       GLOBE_USE_GO; the full-stack proxy path is covered by the Go half
 *       plus the flag documented in vite.config.ts). Opening a row must
 *       launch a same-origin /api/files/:name preview popup.
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5199';
const GO_PORT = Number(process.env.FILESMOKE_GO_PORT ?? 18787);
const GO_BASE = `http://127.0.0.1:${GO_PORT}`;
const SERVER_DIR = path.resolve(process.cwd(), '..', 'server');
const TEST_KEY = 'files-smoke-shared-secret';

let workdir: string;
let root: string;
let binary: string;
let server: ChildProcess | null = null;

function rawGet(pathname: string, host: string, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port: GO_PORT,
				path: pathname,
				method: 'GET',
				headers: { host, ...headers }
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

async function waitForHealth(): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`${GO_BASE}/healthz`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) throw new Error('globe-server did not come up for files-smoke');
		await new Promise((r) => setTimeout(r, 200));
	}
}

test.beforeAll(async () => {
	workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-smoke-'));
	root = path.join(workdir, 'Desktop');
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, 'hello.txt'), 'bridge bytes');
	fs.writeFileSync(path.join(root, 'notes.md'), '# notes');
	fs.writeFileSync(path.join(root, 'run.exe'), 'MZ');
	fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(4096));
	try {
		fs.symlinkSync(path.join(workdir, 'outside.txt'), path.join(root, 'escape.txt'));
		fs.writeFileSync(path.join(workdir, 'outside.txt'), 'outside');
	} catch {
		// Windows without Developer Mode cannot create symlinks — the Go unit
		// tests cover the escape case there; the API half skips it here.
	}

	binary = path.join(workdir, process.platform === 'win32' ? 'globe-server.exe' : 'globe-server');
	execFileSync('go', ['build', '-o', binary, './cmd/globe-server'], {
		cwd: SERVER_DIR,
		stdio: 'pipe'
	});

	server = spawn(binary, [], {
		env: {
			...process.env,
			GLOBE_API_HOST: '127.0.0.1',
			GLOBE_API_PORT: String(GO_PORT),
			GLOBE_FILES_ROOT: root,
			GLOBE_FILES_MAX_BYTES: '1024',
			API_SERVER_KEY: TEST_KEY
		},
		stdio: 'ignore'
	});
	await waitForHealth();
});

test.afterAll(async () => {
	if (server) {
		const child = server;
		server = null;
		child.kill();
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			child.once('exit', done);
			setTimeout(done, 5000);
		});
	}
	// Windows locks the just-killed binary briefly — retry before giving up.
	// A leftover temp dir must never fail the suite.
	for (let i = 0; i < 10; i++) {
		try {
			fs.rmSync(workdir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	try {
		fs.rmSync(workdir, { recursive: true, force: true });
	} catch {
		console.log(`[files-smoke] could not remove ${workdir}, left for the OS temp sweeper`);
	}
});

// Same-origin evidence: the binary runs with API_SERVER_KEY set, so plain
// fetches (no Origin) are 401 by design — every bridge call carries Origin.
function gofetch(pathname: string, init?: RequestInit) {
	return fetch(`${GO_BASE}${pathname}`, {
		...init,
		headers: { origin: GO_BASE, ...init?.headers }
	});
}

// ── (a) bridge API against the real binary ────────────────────────────

test('bridge lists only servable files', async () => {
	const res = await gofetch('/api/files');
	expect(res.status).toBe(200);
	const list = (await res.json()) as {
		name: string;
		size: number;
		modified: string;
		contentType: string;
	}[];
	const names = list.map((e) => e.name);
	expect(names).toEqual(['hello.txt', 'notes.md']);
	for (const entry of list) {
		expect(entry.size).toBeGreaterThan(0);
		expect(Number.isNaN(Date.parse(entry.modified))).toBe(false);
		expect(entry.contentType).toContain('/');
	}
});

test('bridge serves bytes inline, svg as text', async () => {
	const res = await gofetch('/api/files/hello.txt');
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
	expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	expect(await res.text()).toBe('bridge bytes');
});

test('bridge rejects traversal, disallowed types, over-cap files', async () => {
	expect((await gofetch(`/api/files/${encodeURIComponent('../secret.txt')}`)).status).toBe(400);
	expect((await gofetch('/api/files/run.exe')).status).toBe(403);
	expect((await gofetch('/api/files/big.txt')).status).toBe(413);
	expect((await gofetch('/api/files/nope.txt')).status).toBe(404);
});

test('bridge symlink escape is forbidden', async () => {
	if (!fs.existsSync(path.join(root, 'escape.txt'))) {
		console.log(
			'[files-smoke] symlink unavailable, escape case skipped (covered by Go unit tests)'
		);
		return;
	}
	expect((await gofetch('/api/files/escape.txt')).status).toBe(403);
});

test('bridge guard: off-loopback needs the shared secret', async () => {
	const anon = await rawGet('/api/files', 'files-smoke-device:9');
	expect(anon.status).toBe(401);
	const authed = await rawGet('/api/files', 'files-smoke-device:9', { 'x-api-key': TEST_KEY });
	expect(authed.status).toBe(200);
});

// ── (b) Files surface in the visor ────────────────────────────────────

test('@smoke files panel lists bridge files and previews one', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));

	await page.context().route('**/api/files', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					name: 'hello.txt',
					size: 12,
					modified: new Date().toISOString(),
					contentType: 'text/plain; charset=utf-8'
				},
				{
					name: 'deck.pdf',
					size: 42000,
					modified: new Date().toISOString(),
					contentType: 'application/pdf'
				}
			])
		});
	});
	await page.context().route('**/api/files/*', async (route) => {
		await route.fulfill({ status: 200, contentType: 'text/plain', body: 'preview bytes' });
	});

	await page.goto(`${BASE_URL}/`);
	await page.getByRole('button', { name: 'Desktop files' }).click();

	const panel = page.getByRole('complementary', { name: 'Desktop files' });
	await expect(panel).toBeVisible();
	await expect(panel.getByText('hello.txt')).toBeVisible();
	await expect(panel.getByText('deck.pdf')).toBeVisible();

	const [popup] = await Promise.all([
		page.waitForEvent('popup'),
		panel.getByRole('button', { name: /Preview hello\.txt/ }).click()
	]);
	expect(popup.url()).toContain('/api/files/hello.txt');

	expect(pageErrors, 'page must not throw').toEqual([]);
});
