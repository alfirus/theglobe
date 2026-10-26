import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GET, POST } from '../../src/routes/api/stt/+server';
import { call, getRequest, postJson } from '../helpers';

/**
 * Error-copy hardening (card t_c0ae5752): no server-local filesystem path
 * may reach the client in any GET/POST body — stable coded copy instead,
 * full detail staying in the server log.
 */
const PATH_LIKE =
	/[A-Za-z]:[\\/]|\/tmp\/|\/home\/|\/root\/|\/usr\/|\/opt\/|AppData|glob-stt-|Program Files/;

const state = vi.hoisted(() => ({ mode: 'spawn-fails' as 'spawn-fails' | 'worker-path-error' }));

vi.mock('node:child_process', () => {
	type Listener = (...args: unknown[]) => void;
	const spawn = (cmd: string, argv: string[]): unknown => {
		const listeners: Record<string, Listener[]> = {};
		const stdoutListeners: Listener[] = [];
		const child = {
			exitCode: null as number | null,
			killed: false,
			stdout: {
				on: (event: string, cb: Listener): void => {
					if (event === 'data') stdoutListeners.push(cb);
				}
			},
			stderr: { on: (): void => {} },
			stdin: {
				on: (): void => {},
				write: (chunk: unknown): boolean => {
					// Fake worker: answer the transcribe request with a
					// path-bearing failure, as an unsanitized worker would.
					if (state.mode === 'worker-path-error') {
						const id = (JSON.parse(String(chunk)) as { id: number }).id;
						setImmediate(() => {
							for (const cb of stdoutListeners) {
								cb(
									Buffer.from(
										JSON.stringify({
											id,
											error: `RuntimeError: [Errno 2] No such file: '/tmp/glob-stt-zzz/clip.webm'`,
											code: 'transcribe_failed'
										}) + '\n'
									)
								);
							}
						});
					}
					return true;
				}
			},
			on: (event: string, cb: Listener): unknown => {
				(listeners[event] ??= []).push(cb);
				return child;
			},
			kill: (): void => {
				child.killed = true;
			}
		};
		const emit = (event: string, ...args: unknown[]): void => {
			for (const cb of listeners[event] ?? []) cb(...args);
		};
		setImmediate(() => {
			if (argv[0] === '-c') {
				// Capability probe: no speech engine in any interpreter.
				emit('error', new Error(`spawn ${cmd} ENOENT`));
				emit('close', 1);
			} else if (state.mode === 'worker-path-error') {
				for (const cb of stdoutListeners) {
					cb(
						Buffer.from(
							JSON.stringify({ ready: true, engine: 'faster-whisper', model: 'base' }) + '\n'
						)
					);
				}
			} else {
				emit('error', new Error(`cannot run ${cmd}: spawn ENOENT`));
				emit('exit', 1);
			}
		});
		return child;
	};
	return { spawn };
});

/** Absolute path to the real worker: the suite runs with cwd in a temp sandbox. */
const WORKER_SCRIPT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'scripts',
	'stt_worker.py'
);

beforeEach(() => {
	delete process.env.STT_WORKER;
	state.mode = 'spawn-fails';
});

/** Minimal RIFF header so `extensionFor` accepts the clip as wav. */
function wavClip(): { audio: string; mimeType: string } {
	const bytes = Buffer.alloc(16);
	bytes.write('RIFF', 0, 'ascii');
	bytes.write('WAVE', 8, 'ascii');
	return { audio: bytes.toString('base64'), mimeType: 'audio/wav' };
}

describe('GET /api/stt error copy', () => {
	it('returns stable coded copy without filesystem paths when the worker is missing', async () => {
		const response = await call(GET, getRequest('/api/stt'));
		expect(response.status).toBe(503);
		const data = (await response.json()) as {
			available: boolean;
			reason?: string;
			code?: string;
		};
		expect(data.available).toBe(false);
		expect(data.code).toBe('worker_not_found');
		expect(data.reason).toBe('Speech engine files are missing on the server.');
		expect(JSON.stringify(data)).not.toMatch(PATH_LIKE);
	});
});

describe('POST /api/stt error copy', () => {
	it('rejects an oversized JSON body pre-parse with 413', async () => {
		const response = await call(POST, postJson('/api/stt', 'x'.repeat(7 * 1024 * 1024)));
		expect(response.status).toBe(413);
		const data = (await response.json()) as { code: string };
		expect(data.code).toBe('too_large');
	});

	it('maps spawn failure to stable copy without interpreter paths', async () => {
		process.env.STT_WORKER = WORKER_SCRIPT;
		state.mode = 'spawn-fails';
		const response = await call(POST, postJson('/api/stt', wavClip()));
		expect(response.status).toBe(503);
		const data = (await response.json()) as { error: string; code: string };
		expect(data.code).toBe('engine_unavailable');
		expect(data.error).toBe('No speech engine is installed on the server.');
		expect(JSON.stringify(data)).not.toMatch(PATH_LIKE);
	});

	it('strips the mkdtemp clip path from transcribe_failed worker detail', async () => {
		process.env.STT_WORKER = WORKER_SCRIPT;
		state.mode = 'worker-path-error';
		const response = await call(POST, postJson('/api/stt', wavClip()));
		expect(response.status).toBe(500);
		const data = (await response.json()) as { error: string; code: string };
		expect(data.code).toBe('transcribe_failed');
		expect(JSON.stringify(data)).not.toMatch(PATH_LIKE);
		expect(data.error).toContain('RuntimeError');
	});
});
