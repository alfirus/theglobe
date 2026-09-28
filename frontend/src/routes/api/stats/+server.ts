import { json } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, totalmem, uptime } from 'node:os';
import { promisify } from 'node:util';
import type { RequestHandler } from './$types';
import { assertApiRequest } from '$lib/config';

/**
 * GET /api/stats — device stats for the status panel.
 *
 * M2: no `require()` anywhere (ESM) and the platform name no longer shadows the
 * `os` import. M3: no synchronous spawns — CPU/RAM/uptime come from pure-Node
 * `node:os` APIs, only the GPU probe shells out, asynchronously via `execFile`,
 * and the whole payload is cached for 2s (the panel polls every 3s).
 */

const execFileAsync = promisify(execFile);

const platformName = platform();
const CACHE_MS = 2000;
const EXEC_TIMEOUT_MS = 5000;
const MIN_CPU_SAMPLE_MS = 400;

type Ram = { percent: number; used: string; total: string };
type Gpu = { percent: number; mem: string; total: string };
type Stats = { cpu: number; ram: Ram; gpu: Gpu; uptime: string };

const FALLBACK: Stats = {
	cpu: 0,
	ram: { percent: 0, used: '0', total: '0' },
	gpu: { percent: 0, mem: '0', total: '0' },
	uptime: '?'
};

/** Async helper for constant command strings — never request data, no shell pipes. */
async function run(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			encoding: 'utf-8'
		});
		return String(stdout).trim();
	} catch {
		return '';
	}
}

/** Windows-only PowerShell probe (one async spawn, no shell string building). */
function ps(command: string): Promise<string> {
	return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

// ── CPU ──────────────────────────────────────────────────────────────────

let previousCpus: ReturnType<typeof cpus> | null = null;
let previousSampleAt = 0;
let lastCpuPercent: number | null = null;

/**
 * Pure-Node CPU usage from `os.cpus()` timing deltas (no process spawn).
 * Returns null until a second sample a few hundred ms apart exists.
 */
function cpuFromOs(): number | null {
	const now = Date.now();
	const list = cpus();
	if (list.length === 0) return null;

	if (
		previousCpus &&
		previousCpus.length === list.length &&
		now - previousSampleAt >= MIN_CPU_SAMPLE_MS
	) {
		let idle = 0;
		let total = 0;
		for (let i = 0; i < list.length; i++) {
			const before = previousCpus[i].times;
			const after = list[i].times;
			const diff =
				after.user -
				before.user +
				after.nice -
				before.nice +
				// `os.cpus().times` exposes `sys`, not `system` — reading `.system`
				// made this delta NaN (QA defect D7).
				after.sys -
				before.sys +
				after.idle -
				before.idle +
				after.irq -
				before.irq;
			idle += after.idle - before.idle;
			total += diff;
		}
		previousCpus = list;
		previousSampleAt = now;
		if (total > 0) {
			const used = 1 - idle / total;
			lastCpuPercent = Math.max(0, Math.min(100, Math.round(used * 100)));
			return lastCpuPercent;
		}
		return lastCpuPercent;
	}

	if (!previousCpus) {
		previousCpus = list;
		previousSampleAt = now;
	}
	return lastCpuPercent;
}

/** Load-average estimate used when no CPU delta is available yet. */
function cpuFromLoad(): number {
	const cores = cpus().length || 1;
	return Math.min(Math.round((loadavg()[0] / cores) * 100), 100);
}

async function getCPU(): Promise<number> {
	const fromOs = cpuFromOs();
	if (fromOs !== null) return fromOs;
	return cpuFromLoad();
}

// ── RAM ──────────────────────────────────────────────────────────────────

function toRam(usedBytes: number, totalBytes: number): Ram {
	const safeTotal = totalBytes || 1;
	return {
		percent: Math.min(Math.round((usedBytes / safeTotal) * 100), 100),
		used: (usedBytes / 1024 ** 3).toFixed(1),
		total: (totalBytes / 1024 ** 3).toFixed(1)
	};
}

async function getRAM(): Promise<Ram> {
	// Linux: /proc/meminfo gives MemAvailable, which beats freemem() (MemFree only).
	if (platformName === 'linux') {
		try {
			const meminfo = await readFile('/proc/meminfo', 'utf-8');
			const totalKB = parseInt(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? '0', 10) || 0;
			let availableKB = parseInt(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? '', 10);
			if (isNaN(availableKB)) {
				const free = parseInt(meminfo.match(/^MemFree:\s+(\d+)/m)?.[1] ?? '0', 10) || 0;
				const buffers = parseInt(meminfo.match(/^Buffers:\s+(\d+)/m)?.[1] ?? '0', 10) || 0;
				const cached = parseInt(meminfo.match(/^Cached:\s+(\d+)/m)?.[1] ?? '0', 10) || 0;
				availableKB = free + buffers + cached;
			}
			if (totalKB > 0) {
				return toRam(Math.max(0, totalKB - availableKB) * 1024, totalKB * 1024);
			}
		} catch {
			/* fall through to node:os */
		}
	}

	const total = totalmem();
	const free = freemem();
	return toRam(Math.max(0, total - free), total);
}

// ── GPU ──────────────────────────────────────────────────────────────────

async function getGPU(): Promise<Gpu> {
	const zero: Gpu = { percent: 0, mem: '0', total: '0' };

	// NVIDIA — every platform
	const nvidia = await run('nvidia-smi', [
		'--query-gpu=utilization.gpu,memory.used,memory.total',
		'--format=csv,noheader,nounits'
	]);
	if (nvidia) {
		const parts = nvidia.split(',').map((part) => part.trim());
		if (parts.length === 3 && !isNaN(parseInt(parts[0], 10))) {
			return { percent: parseInt(parts[0], 10) || 0, mem: parts[1] || '0', total: parts[2] || '0' };
		}
	}

	if (platformName === 'darwin') {
		const sp = await run('system_profiler', ['SPDisplaysDataType']);
		const chipset = sp.match(/Chipset Model:\s*(.+)/);
		if (chipset) {
			const name = chipset[1].trim();
			return { percent: 0, mem: name, total: name };
		}
		return zero;
	}

	if (platformName === 'linux') {
		// AMD
		const rocm = await run('rocm-smi', ['--showuse', '--json']);
		if (rocm) {
			try {
				const parsed = JSON.parse(rocm) as Record<string, Record<string, string>>;
				const card = Object.keys(parsed).find((key) => key.startsWith('card'));
				if (card) {
					return {
						percent: parseInt(parsed[card]['GPU use (%)'] ?? '0', 10) || 0,
						mem: parsed[card]['GPU Memory Used (VRAM MB)'] ?? '0',
						total: parsed[card]['GPU Memory Total (VRAM MB)'] ?? '0'
					};
				}
			} catch {
				/* unparseable — fall through */
			}
		}

		// Intel iGPU — sysfs read, no spawn
		try {
			const freq = await readFile('/sys/class/drm/card0/gt_total_freq/MHz', 'utf-8');
			if (parseInt(freq.trim(), 10) > 0) return zero;
		} catch {
			/* not present */
		}

		// Last resort: GL renderer string
		const glx = await run('glxinfo', []);
		const renderer = glx.match(/OpenGL renderer:\s*(.+)/i);
		if (renderer) return { percent: 0, mem: '0', total: renderer[1].trim() };
	}

	return zero;
}

// ── uptime ───────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
	const days = Math.floor(ms / 86400000);
	const hours = Math.floor((ms % 86400000) / 3600000);
	const mins = Math.floor((ms % 3600000) / 60000);
	if (days > 0) return `${days}d ${hours}h ${mins}m`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

async function getUptime(): Promise<string> {
	// node:os covers every platform — no shell needed (M2/M3).
	const seconds = uptime();
	if (seconds > 0) return formatUptime(seconds * 1000);

	// Windows fallback: last boot time from CIM
	if (platformName === 'win32') {
		const raw = await ps(
			'Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty LastBootUpTime'
		);
		if (raw) {
			const boot = new Date(raw);
			if (!isNaN(boot.getTime())) return formatUptime(Date.now() - boot.getTime());
		}
	}

	// Linux/macOS fallback: boot time from `uptime -s`
	const bootStr = await run('uptime', ['-s']);
	if (bootStr) {
		const diff = Date.now() - new Date(bootStr).getTime();
		if (diff > 0 && !isNaN(diff)) return formatUptime(diff);
	}

	return '?';
}

// ── handler ──────────────────────────────────────────────────────────────

let cache: { at: number; value: Stats } | null = null;
let inflight: Promise<Stats> | null = null;

async function collect(): Promise<Stats> {
	const [cpu, ram, gpu, up] = await Promise.all([getCPU(), getRAM(), getGPU(), getUptime()]);
	return { cpu, ram, gpu, uptime: up };
}

export const GET: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	const now = Date.now();
	if (cache && now - cache.at < CACHE_MS) return json(cache.value);

	if (!inflight) {
		inflight = collect()
			.then((value) => {
				cache = { at: Date.now(), value };
				return value;
			})
			.catch((err) => {
				console.error('Stats error:', err instanceof Error ? err.message : 'unknown error');
				return cache?.value ?? FALLBACK;
			})
			.finally(() => {
				inflight = null;
			});
	}

	return json(await inflight);
};
