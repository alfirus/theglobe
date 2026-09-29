import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiRequest } from '$lib/config';
import { errorFields, logEvent } from '$lib/log';

/**
 * GET  /api/stt — capability probe: is a server-side speech engine usable?
 *      (Cheap: an interpreter/`import` probe only, no model load — the
 *      composer asks before it shows a Whisper mic.)
 * POST /api/stt — transcribe one recorded clip (P1-7, non-Chromium fallback).
 *
 * Body: `{ audio: <base64>, mimeType?: string, language?: 'en' }`
 * Reply: `{ text, engine, model, ms }` — `text` may be empty (silence); the
 * composer turns that into a visible "nothing was recognised" message, so a
 * clip is never dropped without telling the user.
 *
 * Engine: a warm `scripts/stt_worker.py` child (faster-whisper, else
 * openai-whisper) spoken to over NDJSON — same integration layer as
 * `/api/tts`'s CLI spawns (ADR 0001), no new port, no new protocol.
 *
 * Ops knobs (all optional, env-only — no settings UI for a fallback engine):
 *   STT_PYTHON   interpreter to run the worker with (otherwise: candidates)
 *   STT_WORKER   path to stt_worker.py (otherwise: cwd-relative candidates)
 *   STT_MODEL    whisper model name (default `base`)
 *   STT_LANGUAGE default language tag, empty = auto-detect
 *   STT_TIMEOUT_MS per-clip transcription budget (default 60 s)
 */

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Cold start may download the model the first time — budget for that. */
const SPAWN_TIMEOUT_MS = 120_000;
/** A warm worker is ~150 MB of RSS; reap it after this long without a request. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;
/** How long a capability probe result stays fresh (GET runs a Python probe). */
const PROBE_TTL_MS = 60_000;

const DEFAULT_MODEL = 'base';

/** `audio/webm;codecs=opus` → `webm`. */
function extensionFor(mimeType: string, bytes: Buffer): string | null {
	const clean = mimeType.split(';')[0].trim().toLowerCase();
	const known: Record<string, string> = {
		'audio/webm': 'webm',
		'audio/ogg': 'ogg',
		'audio/mp4': 'm4a',
		'audio/aac': 'aac',
		'audio/mpeg': 'mp3',
		'audio/mp3': 'mp3',
		'audio/wav': 'wav',
		'audio/x-wav': 'wav',
		'audio/wave': 'wav',
		'audio/flac': 'flac',
		'audio/x-flac': 'flac'
	};
	if (known[clean]) return known[clean];

	// Only sniff when the browser declared nothing usable. An explicit
	// non-audio type is a contract violation, not a mystery to decode.
	if (clean && !clean.startsWith('audio/') && clean !== 'application/octet-stream') return null;

	// MediaRecorder sometimes reports an empty/generic type — sniff the header.
	if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') return 'wav';
	if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg';
	if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
	if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
	if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'mp3';
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
	return null;
}

/** `en-US` → `en`; anything that is not a language tag is dropped (auto). */
function normalizeLanguage(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const base = raw.trim().split(/[-_]/)[0] ?? '';
	return /^[a-z]{2,3}$/i.test(base) ? base.toLowerCase() : undefined;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
	const raw = Number.parseInt((process.env[name] ?? '').trim(), 10);
	if (!Number.isFinite(raw)) return fallback;
	return Math.min(max, Math.max(min, raw));
}

function sttModel(): string {
	const raw = (process.env.STT_MODEL ?? '').trim();
	// Model ids are file-ish names (`base`, `large-v3-turbo`) — never a path.
	return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : DEFAULT_MODEL;
}

/** Interpreters worth trying, most specific first (mirror of tts `resolveCli`). */
function pythonCandidates(): string[] {
	const explicit = (process.env.STT_PYTHON ?? '').trim();
	if (explicit) return [explicit];

	const home = process.env.HOME || process.env.USERPROFILE || '';
	const localAppData = process.env.LOCALAPPDATA ?? '';
	const candidates: string[] = [];

	// Windows: the per-user installer layout (`…\Programs\Python\Python3XX`).
	if (localAppData) {
		const root = join(localAppData, 'Programs', 'Python');
		try {
			for (const entry of readdirSync(root).sort().reverse()) {
				// Windows names the folder `Python313`, pyenv/Homebrew `python3.13`.
				if (!entry.startsWith('Python3')) continue;
				const exe = join(root, entry, 'python.exe');
				if (existsSync(exe)) candidates.push(exe);
			}
		} catch {
			/* no such directory — keep looking */
		}
	}
	// macOS / Linux system and Homebrew interpreters.
	candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3');
	if (home) candidates.push(join(home, '.local', 'bin', 'python3'));
	// PATH fallbacks last: on this machine plain `python` may be a venv
	// without any speech engine, which the worker reports as ready:false.
	candidates.push('python3', 'python');

	const seen = new Set<string>();
	return candidates.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}

/** Locate the worker script; cwd covers `npm run dev`, `npm start`, `node build`. */
function workerScript(): { path: string | null; searched: string[] } {
	const explicit = (process.env.STT_WORKER ?? '').trim();
	if (explicit) {
		return { path: existsSync(explicit) ? explicit : null, searched: [explicit] };
	}
	const candidates = [
		join(process.cwd(), 'scripts', 'stt_worker.py'),
		join(process.cwd(), 'frontend', 'scripts', 'stt_worker.py')
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate, searched: candidates };
	}
	return { path: null, searched: candidates };
}

// ── capability probe (GET) ───────────────────────────────────────────────

type Probe = { available: boolean; engine?: string; model: string; reason?: string };
let probeCache: { at: number; value: Probe } | null = null;

/**
 * Ask an interpreter whether it has a speech engine. Deliberately does *not*
 * load the model — GET runs on every page load and must stay cheap.
 */
async function probeInterpreter(python: string): Promise<string | null> {
	const code =
		'import importlib.util as u,sys;' +
		"sys.stdout.write('faster-whisper' if u.find_spec('faster_whisper') else ('openai-whisper' if u.find_spec('whisper') else ''))";
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: string | null): void => {
			if (!done) {
				done = true;
				resolve(value);
			}
		};
		let out = '';
		const child = spawn(python, ['-c', code], {
			shell: false,
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true
		});
		child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
		child.on('error', () => finish(null));
		child.on('close', () => {
			const engine = out.trim();
			finish(engine === 'faster-whisper' || engine === 'openai-whisper' ? engine : null);
		});
		setTimeout(() => {
			child.kill();
			finish(null);
		}, 10_000).unref?.();
	});
}

async function capability(): Promise<Probe> {
	const model = sttModel();
	if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;

	const { path, searched } = workerScript();
	let reason = '';
	if (!path) {
		reason = `stt_worker.py not found (searched ${searched.join(', ')}) — set STT_WORKER`;
	}

	let value: Probe;
	if (reason) {
		value = { available: false, model, reason };
	} else {
		let last = 'no Python interpreter candidate resolved';
		for (const python of pythonCandidates()) {
			const engine = await probeInterpreter(python);
			if (engine) {
				value = { available: true, engine, model };
				probeCache = { at: Date.now(), value };
				return value;
			}
			last = `no speech engine in ${python}`;
		}
		value = {
			available: false,
			model,
			reason: `${last} — install one with \`python -m pip install faster-whisper\` or set STT_PYTHON`
		};
	}
	probeCache = { at: Date.now(), value };
	return value;
}

// ── warm worker (POST) ───────────────────────────────────────────────────

type WorkerReply = { id?: number; text?: string; ms?: number; error?: string; code?: string };
type Pending = {
	resolve: (reply: WorkerReply) => void;
	reject: (err: Error & { code?: string }) => void;
	timer: ReturnType<typeof setTimeout>;
};
type WorkerHandle = {
	child: ReturnType<typeof spawn>;
	engine: string;
	model: string;
	pending: Map<number, Pending>;
	nextId: number;
	buffer: string;
	idle: ReturnType<typeof setTimeout> | null;
	/** Set once the worker has been reaped — guards re-entrant shutdown. */
	stopped: boolean;
};

let worker: WorkerHandle | null = null;
let starting: Promise<WorkerHandle> | null = null;
/** Why the last spawn attempt failed — surfaced by GET and POST. */
let lastSpawnError: { code: string; error: string } | null = null;

function stopWorker(handle: WorkerHandle, reason: string): void {
	if (handle.stopped) return;
	handle.stopped = true;
	if (handle.idle) clearTimeout(handle.idle);
	for (const [, pending] of handle.pending) {
		clearTimeout(pending.timer);
		const err = new Error(reason) as Error & { code: string };
		err.code = 'worker_stopped';
		pending.reject(err);
	}
	handle.pending.clear();
	if (worker === handle) worker = null;
	handle.child.kill();
}

function attach(handle: WorkerHandle): void {
	const child = handle.child;
	child.stdin?.on('error', () => stopWorker(handle, 'STT worker stdin closed'));
	child.stdout?.on('data', (chunk: Buffer) => {
		handle.buffer += chunk.toString('utf8');
		let index = handle.buffer.indexOf('\n');
		while (index !== -1) {
			const line = handle.buffer.slice(0, index).trim();
			handle.buffer = handle.buffer.slice(index + 1);
			index = handle.buffer.indexOf('\n');
			if (!line) continue;
			let reply: WorkerReply;
			try {
				reply = JSON.parse(line) as WorkerReply;
			} catch {
				continue;
			}
			if (typeof reply.id !== 'number') continue;
			const pending = handle.pending.get(reply.id);
			if (!pending) continue;
			handle.pending.delete(reply.id);
			clearTimeout(pending.timer);
			if (reply.error) {
				const err = new Error(reply.error) as Error & { code: string };
				err.code = reply.code ?? 'transcribe_failed';
				pending.reject(err);
			} else {
				pending.resolve(reply);
			}
		}
	});
	child.on('error', (err) => stopWorker(handle, `STT worker error: ${err.message}`));
	child.on('exit', (code) => stopWorker(handle, `STT worker exited (code ${code})`));
}

/** Spawn one candidate interpreter and wait for its readiness line. */
function spawnCandidate(python: string, script: string, model: string): Promise<WorkerHandle> {
	return new Promise((resolve, reject) => {
		const child = spawn(python, [script, model], {
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});

		let settled = false;
		let buffer = '';
		let stderrTail = '';
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(
				Object.assign(new Error(`${python} did not become ready in ${SPAWN_TIMEOUT_MS / 1000}s`), {
					code: 'spawn_timeout'
				})
			);
		}, SPAWN_TIMEOUT_MS);

		const fail = (err: Error & { code?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			reject(err);
		};

		child.stderr?.on('data', (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
		});
		child.stdout?.on('data', (chunk: Buffer) => {
			if (settled) return;
			buffer += chunk.toString('utf8');
			const nl = buffer.indexOf('\n');
			if (nl === -1) return;
			const head = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			let info: { ready?: boolean; engine?: string; code?: string; error?: string };
			try {
				info = JSON.parse(head) as typeof info;
			} catch {
				return;
			}
			if (info.ready !== true) {
				fail(
					Object.assign(new Error(info.error ?? 'STT worker reported no engine'), {
						code: info.code ?? 'engine_unavailable'
					})
				);
				return;
			}
			settled = true;
			clearTimeout(timer);
			const handle: WorkerHandle = {
				child,
				engine: info.engine ?? 'unknown',
				model,
				pending: new Map(),
				nextId: 1,
				buffer,
				idle: null,
				stopped: false
			};
			attach(handle);
			resolve(handle);
		});
		child.on('error', (err) =>
			fail(
				Object.assign(new Error(`cannot run ${python}: ${err.message}`), {
					code: 'python_not_found'
				})
			)
		);
		child.on('exit', (code) =>
			fail(
				Object.assign(
					new Error(
						`STT worker exited before ready (code ${code})${stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ''}`
					),
					{ code: 'engine_unavailable' }
				)
			)
		);
	});
}

async function startWorker(): Promise<WorkerHandle> {
	const { path } = workerScript();
	if (!path) {
		throw Object.assign(new Error('stt_worker.py not found — set STT_WORKER'), {
			code: 'engine_unavailable'
		});
	}
	const model = sttModel();
	const reasons: string[] = [];
	const startedAt = Date.now();
	for (const python of pythonCandidates()) {
		try {
			const handle = await spawnCandidate(python, path, model);
			lastSpawnError = null;
			logEvent('stt', 'worker_ready', {
				engine: handle.engine,
				model,
				python,
				spawnMs: Date.now() - startedAt
			});
			// An engine that is warmed but never used must not sit in RAM.
			touchIdle(handle);
			return handle;
		} catch (err) {
			const code = (err as { code?: string }).code ?? 'spawn_failed';
			const message = err instanceof Error ? err.message : String(err);
			reasons.push(`${python}: ${message}`);
			lastSpawnError = { code, error: message };
		}
	}
	const error = Object.assign(new Error(`No usable STT interpreter — ${reasons.join(' ; ')}`), {
		code: 'engine_unavailable'
	});
	logEvent('stt', 'worker_start_failed', { candidates: reasons.length }, 'error');
	throw error;
}

async function getWorker(): Promise<WorkerHandle> {
	if (worker && worker.child.exitCode === null && !worker.child.killed) return worker;
	if (!starting) {
		starting = startWorker()
			.then((handle) => {
				worker = handle;
				return handle;
			})
			.finally(() => {
				starting = null;
			});
	}
	return starting;
}

function touchIdle(handle: WorkerHandle): void {
	if (handle.idle) clearTimeout(handle.idle);
	handle.idle = setTimeout(() => {
		if (handle.pending.size === 0) stopWorker(handle, 'idle shutdown');
	}, IDLE_SHUTDOWN_MS);
	handle.idle.unref?.();
}

function transcribe(
	handle: WorkerHandle,
	path: string,
	language: string | undefined,
	timeoutMs: number
): Promise<WorkerReply> {
	return new Promise((resolve, reject) => {
		const id = handle.nextId++;
		const timer = setTimeout(() => {
			handle.pending.delete(id);
			// A wedged model must not block the next attempt: recycle the worker.
			stopWorker(handle, 'transcription timed out');
			reject(
				Object.assign(new Error(`transcription exceeded ${Math.round(timeoutMs / 1000)}s`), {
					code: 'transcribe_timeout'
				})
			);
		}, timeoutMs);
		handle.pending.set(id, { resolve, reject, timer });
		const payload = JSON.stringify({ id, path, ...(language ? { language } : {}) });
		try {
			handle.child.stdin?.write(payload + '\n');
		} catch (err) {
			clearTimeout(timer);
			handle.pending.delete(id);
			reject(
				Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
					code: 'worker_stopped'
				})
			);
		}
	});
}

// ── handlers ─────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	const probe = await capability();
	if (probe.available) {
		// Warm the engine in the background: a cold Python + model load measured
		// 30 s on this machine (first-run AV scan of torch/CTranslate2 DLLs),
		// which would look like a hang the first time someone dictates. Only
		// non-Chromium browsers ask (the composer probes only when Web Speech is
		// missing), and the worker is reaped after IDLE_SHUTDOWN_MS anyway.
		void getWorker().catch((err) => {
			logEvent('stt', 'warm_failed', { err: String(err).slice(0, 200) }, 'warn');
		});
	}
	const payload =
		lastSpawnError && !probe.available ? { ...probe, lastError: lastSpawnError.error } : probe;
	return json(payload, { status: probe.available ? 200 : 503 });
};

export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: { audio?: unknown; mimeType?: unknown; language?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch (err) {
		logEvent('stt', 'request_body_invalid', errorFields(err), 'warn');
		return json({ error: 'Invalid JSON body', code: 'invalid_request' }, { status: 400 });
	}

	if (typeof body.audio !== 'string' || !body.audio) {
		return json(
			{ error: 'Missing `audio` (base64 clip)', code: 'invalid_request' },
			{ status: 400 }
		);
	}
	const bytes = Buffer.from(body.audio, 'base64');
	if (!bytes.length) {
		return json({ error: 'Empty audio payload', code: 'invalid_request' }, { status: 400 });
	}
	if (bytes.length > MAX_AUDIO_BYTES) {
		return json(
			{ error: `Clip exceeds ${MAX_AUDIO_BYTES / (1024 * 1024)} MB`, code: 'too_large' },
			{ status: 413 }
		);
	}
	const mime = typeof body.mimeType === 'string' ? body.mimeType : '';
	const ext = extensionFor(mime, bytes);
	if (!ext) {
		return json(
			{ error: `Unsupported audio type: ${mime || 'unknown'}`, code: 'unsupported_media' },
			{ status: 415 }
		);
	}
	const language = normalizeLanguage(body.language);

	const dir = mkdtempSync(join(tmpdir(), 'glob-stt-'));
	const file = join(dir, `clip.${ext}`);
	writeFileSync(file, bytes);
	const startedAt = Date.now();

	try {
		const handle = await getWorker();
		const timeoutMs = envInt('STT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 5_000, 600_000);
		const reply = await transcribe(handle, file, language, timeoutMs);
		touchIdle(handle);
		const text = (reply.text ?? '').trim();
		logEvent('stt', 'transcribe_ok', {
			engine: handle.engine,
			model: handle.model,
			bytes: bytes.length,
			chars: text.length,
			ms: reply.ms ?? null,
			tookMs: Date.now() - startedAt
		});
		return json({ text, engine: handle.engine, model: handle.model, ms: reply.ms ?? null });
	} catch (err) {
		const code = (err as { code?: string }).code ?? 'transcribe_failed';
		const message = err instanceof Error ? err.message : String(err);
		const status =
			code === 'transcribe_timeout'
				? 504
				: code === 'engine_unavailable' ||
					  code === 'python_not_found' ||
					  code === 'spawn_timeout' ||
					  code === 'worker_stopped'
					? 503
					: 500;
		logEvent('stt', 'transcribe_failed', { code, status, err: message.slice(0, 300) }, 'error');
		return json({ error: message, code }, { status });
	} finally {
		try {
			unlinkSync(file);
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* temp cleanup is best-effort */
		}
	}
};
