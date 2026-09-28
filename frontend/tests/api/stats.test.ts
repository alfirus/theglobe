import { describe, expect, it, vi } from 'vitest';
import { GET as getStats } from '../../src/routes/api/stats/+server';
import { call, getRequest } from '../helpers';

/**
 * Every child process the stats route spawns goes through `execFile` with a
 * constant command and argv — no shell, no request data (M2/M3).
 * Captured through `execFile`'s promisify hook so `promisify(execFile)` in the
 * route resolves to this fake.
 */
const spawned = vi.hoisted(() => ({ cmds: [] as string[][] }));

vi.mock('node:child_process', () => {
	const impl = (cmd: string, args: string[] = []) => {
		spawned.cmds.push([cmd, ...args]);
		return Promise.resolve({ stdout: '', stderr: '' });
	};
	const execFile = Object.assign(impl, {
		[Symbol.for('nodejs.util.promisify.custom')]: impl,
		[Symbol.for('util.promisify.custom')]: impl
	});
	return { execFile };
});

const ALLOWED_COMMANDS = new Set([
	'nvidia-smi',
	'powershell',
	'uptime',
	'rocm-smi',
	'glxinfo',
	'system_profiler'
]);

describe('GET /api/stats — device stats for the status panel', () => {
	it('returns the documented stats shape with sane ranges', async () => {
		const res = await call(getStats, getRequest('/api/stats'));
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			cpu: number;
			ram: { percent: number; used: string; total: string };
			gpu: { percent: number; mem: string; total: string };
			uptime: string;
		};

		expect(Number.isFinite(body.cpu)).toBe(true);
		expect(body.cpu).toBeGreaterThanOrEqual(0);
		expect(body.cpu).toBeLessThanOrEqual(100);

		expect(body.ram.percent).toBeGreaterThanOrEqual(0);
		expect(body.ram.percent).toBeLessThanOrEqual(100);
		expect(typeof body.ram.used).toBe('string');
		expect(typeof body.ram.total).toBe('string');

		expect(typeof body.gpu.percent).toBe('number');
		expect(typeof body.gpu.mem).toBe('string');
		expect(typeof body.gpu.total).toBe('string');

		expect(typeof body.uptime).toBe('string');
		expect(body.uptime).not.toBe('');
	});

	it('only ever spawns constant commands via execFile — never a shell string', async () => {
		await call(getStats, getRequest('/api/stats'));
		expect(spawned.cmds.length).toBeGreaterThan(0);
		for (const argv of spawned.cmds) {
			expect(ALLOWED_COMMANDS.has(argv[0]), argv.join(' ')).toBe(true);
			// No shell metacharacter ever reaches a spawn from this route.
			expect(argv.join(' ')).not.toMatch(/[;&|`$><]/);
		}
	});

	it('serves the 2 s cache instead of re-spawning on every poll', async () => {
		const first = await call(getStats, getRequest('/api/stats'));
		const afterFirst = spawned.cmds.length;

		const second = await call(getStats, getRequest('/api/stats'));
		// The DeviceStats panel polls every 3 s — the second call must be a cache hit.
		expect(spawned.cmds.length).toBe(afterFirst);

		expect(await first.json()).toEqual(await second.json());
	});

	it('recollects once the 2 s cache expires', async () => {
		await call(getStats, getRequest('/api/stats'));
		const before = spawned.cmds.length;

		await new Promise((resolve) => setTimeout(resolve, 2_100));
		await call(getStats, getRequest('/api/stats'));

		expect(spawned.cmds.length).toBeGreaterThan(before);
	});

	it('rejects a cross-origin caller', async () => {
		const res = await call(
			getStats,
			getRequest('/api/stats', { headers: { origin: 'https://evil.example.com' } })
		);
		expect(res.status).toBe(403);
	});
});
