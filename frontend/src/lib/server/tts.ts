import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir, platform, homedir } from 'node:os';
import { join } from 'node:path';
import {
	isAllowedUrl,
	readSettings,
	resolveTts,
	resolveTtsMaxConcurrent,
	resolveTtsModelPath
} from '$lib/config';

/**
 * TTS engine layer — the one place a synthesis call is turned into audio bytes.
 *
 * Both routes use it, so there is exactly one copy of the engine table and one
 * place that touches argv/temp files:
 *   - `POST /api/tts`         whole reply → one concatenated audio blob
 *   - `POST /api/tts/stream`  one sentence per request → one SSE frame
 *
 * Two properties every path inherits:
 *
 * 1. **Concurrency cap (P1-4).** `synthesizeChunk` takes a module-level slot
 *    before spawning anything, so the whole app never runs more than
 *    `TTS_MAX_CONCURRENT` (default 2) engine processes at once; the rest queue
 *    FIFO in `waiters`. The cap is per process, not per request — a streaming
 *    session, a whole-reply fallback and a second tab all share it.
 *
 * 2. **Cancellation (P1-4).** Every engine takes an optional `signal`. Aborting
 *    kills the spawned process (or the cloud fetch) and rejects, which is what
 *    lets stop-generation silence mid-speech instead of leaving a piper running
 *    for the rest of its 120 s budget.
 *
 * Security contract carried over from P0/D5 unchanged: text never reaches a
 * shell (`shell: false` everywhere) and never enters `argv` for the engines
 * that accept stdin (piper, Windows PowerShell, edge-tts `--file`). Key material
 * for the cloud engines is read through `$lib/config` and never logged.
 *
 * Engine table (`tts.provider` in settings) — unchanged from the route it was
 * extracted from:
 *   - `system` (default) — OS-native voice: macOS `say`, Windows SAPI
 *     (PowerShell `System.Speech`), Linux `espeak-ng`.
 *   - `piper` — the local Piper binary + voice model.
 *   - `edge` — Microsoft Edge TTS via the `edge-tts` CLI (free, no key).
 *   - `openai` / `elevenlabs` — cloud HTTP `/audio/speech` style endpoints.
 */

/** Longest body `POST /api/tts` accepts (whole reply, pre-chunking). */
export const MAX_TTS_TEXT = 8000;
/** Longest single synthesis call — longer replies are chunked (Hermes parity). */
export const TTS_CHUNK_TEXT = 1500;
/**
 * Granularity the streaming route aims for: one sentence per SSE frame. Piper
 * measures ~0.7 s per short sentence on the target machine, so a frame this
 * size keeps the first audible chunk well inside the 2 s BLUEPRINT target
 * instead of waiting for a whole paragraph to synthesise.
 */
export const TTS_STREAM_CHUNK_TEXT = 400;
/** Longest body `POST /api/tts/stream` accepts (a sentence, not a reply). */
export const MAX_TTS_STREAM_TEXT = 800;

type Settings = ReturnType<typeof readSettings>;

export interface SynthesizedChunk {
	audio: Buffer;
	contentType: string;
}

// ── concurrency slot (P1-4) ──────────────────────────────────────────────

let active = 0;
const waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

function abortError(): Error {
	const err = new Error('TTS synthesis aborted');
	err.name = 'AbortError';
	return err;
}

/** `true` when the error came from our own cancellation, not a real failure. */
export function isTtsAbort(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** Register an abort listener; returns the disposer (no-op without a signal). */
function listenAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
	if (!signal || signal.aborted) return () => {};
	signal.addEventListener('abort', fn, { once: true });
	return () => signal.removeEventListener('abort', fn);
}

async function acquireSlot(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (active < resolveTtsMaxConcurrent()) {
		active += 1;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const waiter = { resolve, reject };
		waiters.push(waiter);
		const unlisten = listenAbort(signal, () => {
			const at = waiters.indexOf(waiter);
			if (at >= 0) waiters.splice(at, 1);
			reject(abortError());
		});
		// Detach the abort listener the moment the slot is granted, otherwise a
		// later abort would reject a promise that has already resolved.
		const granted = waiter.resolve;
		waiter.resolve = () => {
			unlisten();
			granted();
		};
	});
}

function releaseSlot(): void {
	const next = waiters.shift();
	// Hand the slot straight over: `active` stays where it is.
	if (next) {
		next.resolve();
		return;
	}
	active -= 1;
}

// ── text chunking ────────────────────────────────────────────────────────

/**
 * Split `text` into sentence-aware chunks of at most `max` chars.
 * Splits on sentence/line boundaries first, then on word boundaries; a single
 * pathological token longer than the cap is hard-split. Nothing is dropped —
 * the chunks rejoin to the original text (modulo boundary whitespace).
 */
export function chunkText(text: string, max: number = TTS_CHUNK_TEXT): string[] {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (normalized.length <= max) return normalized ? [normalized] : [];

	// Sentence-ish boundaries: `.`/`!`/`?`/`;`/`:` + space, or CJK stops.
	const sentences = normalized.split(/(?<=[.!?;:。！？；：])\s+/);
	const chunks: string[] = [];
	let current = '';
	const push = (s: string): void => {
		// A single sentence over the cap: split on words, then hard-split.
		if (s.length > max) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			for (const word of s.split(' ')) {
				if (word.length > max) {
					for (let i = 0; i < word.length; i += max) chunks.push(word.slice(i, i + max));
				} else if ((current + ' ' + word).trim().length > max) {
					chunks.push(current);
					current = word;
				} else {
					current = (current + ' ' + word).trim();
				}
			}
			return;
		}
		if ((current + ' ' + s).trim().length > max) {
			chunks.push(current);
			current = s;
		} else {
			current = (current + ' ' + s).trim();
		}
	};
	for (const s of sentences) {
		if (s) push(s);
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Minimal WAV header parse — enough to split data from framing for concat. */
function splitWav(buffer: Buffer): { header: Buffer; pcm: Buffer; headerLen: number } | null {
	if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
	// Walk sub-chunks to find `data` (handles JUNK/LIST/bext before data).
	let offset = 12;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString('ascii', offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		if (id === 'data') {
			return {
				header: buffer.subarray(0, offset + 8),
				pcm: buffer.subarray(offset + 8, offset + 8 + size),
				headerLen: offset + 8
			};
		}
		offset += 8 + size + (size % 2);
	}
	return null;
}

/**
 * Concatenate same-format WAV buffers: first header + joined PCM, sizes patched.
 * All chunks come from one engine with one invocation shape, so the `fmt `
 * block is identical — only the RIFF/data sizes differ, and both are patched.
 */
export function concatWav(buffers: Buffer[]): Buffer {
	const parts = buffers.map(splitWav);
	if (parts.some((p) => p === null)) throw new Error('system TTS produced unreadable WAV');
	const [first, ...rest] = parts as NonNullable<(typeof parts)[number]>[];
	const pcm = Buffer.concat([first.pcm, ...rest.map((p) => p.pcm)]);
	const out = Buffer.concat([first.header, pcm]);
	// Patch RIFF size (bytes 4–7) and data size (last 4 bytes of the header).
	out.writeUInt32LE(out.length - 8, 4);
	out.writeUInt32LE(pcm.length, first.header.length - 4);
	return out;
}

function tempFiles(prefix: string, ext: string): { tmpIn: string; tmpOut: string } {
	const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
	return {
		tmpIn: join(tmpdir(), `${prefix}-${suffix}.txt`),
		tmpOut: join(tmpdir(), `${prefix}-${suffix}.${ext}`)
	};
}

/**
 * Remove temp files immediately, retrying in the background when the OS still
 * refuses.
 *
 * Windows keeps a killed engine's output file locked for a moment after the
 * process dies, so the first `unlink` after stop-generation can fail with
 * EBUSY/EPERM — without the retry a 0-byte `.wav` was left in the temp dir for
 * every interrupted synthesis. ENOENT is "already gone", never retried.
 */
function cleanup(...files: string[]): void {
	let pending = files.slice();
	let attempts = 0;
	const attempt = (): void => {
		pending = pending.filter((file) => {
			try {
				unlinkSync(file);
				return false;
			} catch (err) {
				return (err as NodeJS.ErrnoException).code !== 'ENOENT';
			}
		});
		if (pending.length === 0 || attempts >= 20) return;
		attempts += 1;
		const timer = setTimeout(attempt, 100);
		if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
	};
	attempt();
}

function checkAudioFile(path: string, engine: string): void {
	try {
		if (!existsSync(path) || statSync(path).size === 0) {
			throw new Error(`${engine} produced no audio output`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith(engine)) throw err;
		throw new Error(`${engine} produced no audio output`, { cause: err });
	}
}

// ── `system` engine: OS-native voices ────────────────────────────────────

interface SystemTts {
	args: (outFile: string) => { cmd: string; argv: string[] };
	ext: string;
	contentType: string;
}

/**
 * OS-native synthesis command. No shell, no key, no model to download:
 *   - macOS: `say --file-format=WAVE … -o <wav> <text>` — the `voice` setting
 *     names a macOS voice. WAV, never AIFF: Chrome cannot decode AIFF.
 *   - Windows: SAPI via PowerShell `System.Speech` to WAV — `voice` matches a
 *     substring of an installed voice name (falls back to the system default).
 *   - Linux: `espeak-ng -w <wav> [-v <voice>] <text>` — `voice` is espeak's
 *     voice selector (e.g. `en`, `en-us`, `de`).
 *
 * Text travels as argv here (not stdin): all three tools take the utterance as
 * a plain argument and none of them interprets shell metacharacters because no
 * shell is ever spawned (`shell: false` / `execFile`).
 */
function systemTts(voice: string): SystemTts | { error: string } {
	const host = platform();
	if (host === 'darwin') {
		// `say -o` defaults to AIFF, which Chrome's <audio> cannot decode —
		// synthesis "succeeds" but playback fails. Force 16-bit PCM WAV so the
		// browser can play it directly (verified: `file` reports RIFF/WAVE).
		return {
			ext: 'wav',
			contentType: 'audio/wav',
			args: (outFile: string) => ({
				cmd: 'say',
				argv: [
					...(voice ? ['-v', voice] : []),
					'--file-format=WAVE',
					'--data-format=LEI16@22050',
					'-o',
					outFile
				]
			})
		};
	}
	if (host === 'win32') {
		// Single-quoted PowerShell here-string content: the text is embedded via
		// base64 (UTF-16LE) so quotes/newlines can never break out of the script.
		return {
			ext: 'wav',
			contentType: 'audio/wav',
			args: (outFile: string) => ({
				cmd: 'powershell',
				argv: [
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					[
						'$b64 = [Console]::In.ReadToEnd()',
						'$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64))',
						'Add-Type -AssemblyName System.Speech',
						'$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
						`$v = "${voice.replace(/"/g, '')}"`,
						'if ($v) { $m = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like "*$v*" } | Select-Object -First 1; if ($m) { $s.SelectVoice($m.VoiceInfo.Name) } }',
						`$s.SetOutputToWaveFile("${outFile.replace(/"/g, '')}")`,
						'$s.Speak($text)',
						'$s.Dispose()'
					].join('; ')
				]
			})
		};
	}
	// linux + everything else: espeak-ng (Debian/Ubuntu: `apt install espeak-ng`).
	return {
		ext: 'wav',
		contentType: 'audio/wav',
		args: (outFile: string) => ({
			cmd: 'espeak-ng',
			argv: voice ? ['-v', voice, '-w', outFile] : ['-w', outFile]
		})
	};
}

function runSystemTts(
	text: string,
	voice: string,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<{ file: string; contentType: string; cleanup: () => void }> {
	throwIfAborted(signal);
	const resolved = systemTts(voice);
	if ('error' in resolved) return Promise.reject(new Error(resolved.error));
	const { tmpIn, tmpOut } = tempFiles('system-tts', resolved.ext);

	return new Promise((resolve, reject) => {
		const { cmd, argv } = resolved.args(tmpOut);
		const host = platform();
		const isWinPowershell = host === 'win32';

		// Windows path feeds text via stdin (base64 → no quoting hazard); the
		// `say`/espeak paths take the text as a final argv element (no shell).
		const finalArgv = isWinPowershell ? argv : [...argv, text];
		const child = spawn(cmd, finalArgv, {
			shell: false,
			stdio: isWinPowershell ? ['pipe', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe'],
			windowsHide: true
		});

		let settled = false;
		let stderr = '';
		const done = (err: Error | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unlisten();
			if (err) {
				cleanup(tmpIn, tmpOut);
				reject(err);
				return;
			}
			try {
				checkAudioFile(tmpOut, 'system TTS');
			} catch (checkErr) {
				cleanup(tmpIn, tmpOut);
				reject(checkErr instanceof Error ? checkErr : new Error(String(checkErr)));
				return;
			}
			resolve({
				file: tmpOut,
				contentType: resolved.contentType,
				cleanup: () => cleanup(tmpIn, tmpOut)
			});
		};

		const timer = setTimeout(() => {
			child.kill();
			done(new Error(`system TTS timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		// P1-4: stop-generation kills the OS voice mid-sentence, same shape as a timeout.
		const unlisten = listenAbort(signal, () => {
			child.kill();
			done(abortError());
		});

		child.on('error', (err) => {
			const missing =
				err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
					? new Error(systemMissingHint(host))
					: err;
			done(missing instanceof Error ? missing : new Error(String(missing)));
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-1000);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				done(new Error(`system TTS exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
				return;
			}
			done(null);
		});

		if (isWinPowershell && child.stdin) {
			// UTF-16LE base64: quotes, newlines and `$` are inert data.
			child.stdin.write(Buffer.from(text, 'utf16le').toString('base64'));
			child.stdin.end();
		} else if (child.stdin) {
			child.stdin.end();
		}
	});
}

function systemMissingHint(host: string): string {
	if (host === 'darwin') return 'macOS `say` not found — it ships with macOS; check PATH';
	if (host === 'win32') return 'PowerShell not found — system TTS needs Windows PowerShell + SAPI';
	return 'espeak-ng not found — install it (`sudo apt install espeak-ng`) or switch the TTS engine in Settings';
}

// ── `piper` engine (original local engine) ───────────────────────────────

interface SynthesisOptions {
	text: string;
	modelPath: string;
	inputFile: string;
	outputFile: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Write `text` to `inputFile`, run piper with that file as stdin, verify the WAV. */
function synthesize({
	text,
	modelPath,
	inputFile,
	outputFile,
	timeoutMs,
	signal
}: SynthesisOptions): Promise<void> {
	throwIfAborted(signal);
	// The validated text lives in a temp file, never on the command line.
	writeFileSync(inputFile, text.endsWith('\n') ? text : `${text}\n`, 'utf-8');
	const stdinFd = openSync(inputFile, 'r');

	let child: ReturnType<typeof spawn> | null = null;
	let disposeAbort: () => void = () => {};

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let stderr = '';
		let aborted = false;

		// shell: false — piper is exec'd directly; argv holds only flags plus
		// paths we generated, and no shell ever sees the text.
		child = spawn('piper', ['--model', modelPath, '--output_file', outputFile], {
			shell: false,
			// stdin comes from the temp file's read fd → EOF when the text ends,
			// so piper can never block waiting for more input.
			stdio: [stdinFd, 'ignore', 'pipe'],
			windowsHide: true
		});

		// Rejections are deferred to `close` (below) so Windows can unlink the
		// temp files — the child holds them open while it runs. The grace timer
		// is a safety net for a kill that does not take.
		let grace: ReturnType<typeof setTimeout> | undefined;
		const armGrace = (err: Error): void => {
			clearTimeout(grace);
			grace = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(err);
			}, 5_000);
		};

		const timer = setTimeout(() => {
			if (settled) return;
			child!.kill();
			armGrace(new Error(`piper timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		// P1-4: stop-generation terminates this piper instead of letting it run
		// to its budget in the background, holding a concurrency slot. The
		// rejection lands on `close` exactly like a timeout does.
		disposeAbort = listenAbort(signal, () => {
			if (settled || aborted) return;
			aborted = true;
			clearTimeout(timer);
			child!.kill();
			armGrace(abortError());
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			reject(err);
		});

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-1000);
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			if (aborted) {
				reject(abortError());
				return;
			}
			if (code !== 0) {
				reject(new Error(`piper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
				return;
			}
			// piper has been observed to exit 0 without writing anything — fail
			// loudly here instead of letting readFileSync throw ENOENT.
			try {
				checkAudioFile(outputFile, 'piper');
			} catch (statErr) {
				reject(statErr instanceof Error ? statErr : new Error(String(statErr)));
				return;
			}
			resolve();
		});
	}).finally(() => {
		disposeAbort();
		try {
			closeSync(stdinFd);
		} catch {
			/* already closed by the child / never opened */
		}
	});
}

// ── `edge` engine: free Microsoft Edge TTS via the edge-tts CLI ──────────

/**
 * `edge-tts --file <txt> --write-media <mp3> [--voice <id>]`.
 * No API key; requires `pip install edge-tts` on the server machine.
 *
 * `--file`, never `--text`, for file input: `--text` speaks its argument
 * literally, so passing the temp path made Edge read out `/tmp/edge-tts-…`.
 *
 * `pip install --user` drops the CLI into a user bin dir that is often absent
 * from a GUI-launched server's PATH (macOS: `~/Library/Python/X.Y/bin`;
 * `~/.local/bin` on Unix) — so those locations are probed explicitly instead
 * of failing with ENOENT while the binary sits installed but unfindable.
 */
function resolveCli(cmd: string): string {
	if (cmd.includes('/') || cmd.includes('\\')) return cmd;
	// os.homedir() survives a stripped environment where HOME/USERPROFILE are
	// unset (GUI-launched servers, bare test envs).
	let home = process.env.HOME || process.env.USERPROFILE || '';
	if (!home) {
		try {
			home = homedir();
		} catch {
			/* fall through to PATH lookup */
		}
	}
	const py = process.versions.python ?? '';
	const candidates = [
		// macOS `pip3 install --user edge-tts` (Python 3.9–3.14 layout).
		...['3.9', '3.10', '3.11', '3.12', '3.13', '3.14'].map(
			(v) => `${home}/Library/Python/${v}/bin/${cmd}`
		),
		`${home}/.local/bin/${cmd}`,
		`/opt/homebrew/bin/${cmd}`,
		`/usr/local/bin/${cmd}`
	];
	if (py) candidates.unshift(`${home}/Library/Python/${py}/bin/${cmd}`);
	for (const full of candidates) {
		try {
			if (existsSync(full) && statSync(full).isFile()) return full;
		} catch {
			/* keep probing */
		}
	}
	return cmd; // fall back to PATH lookup; ENOENT handler names the fix
}

function runEdgeTts(
	text: string,
	voice: string,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<{ file: string; contentType: string; cleanup: () => void }> {
	throwIfAborted(signal);
	const { tmpIn, tmpOut } = tempFiles('edge-tts', 'mp3');
	writeFileSync(tmpIn, text, 'utf-8');

	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = '';
		const argv = voice
			? ['--voice', voice, '--file', tmpIn, '--write-media', tmpOut]
			: ['--file', tmpIn, '--write-media', tmpOut];
		const child = spawn(resolveCli('edge-tts'), argv, {
			shell: false,
			stdio: ['ignore', 'ignore', 'pipe'],
			windowsHide: true
		});

		const done = (err: Error | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unlisten();
			if (err) {
				cleanup(tmpIn, tmpOut);
				reject(err);
				return;
			}
			try {
				checkAudioFile(tmpOut, 'edge TTS');
			} catch (checkErr) {
				cleanup(tmpIn, tmpOut);
				reject(checkErr instanceof Error ? checkErr : new Error(String(checkErr)));
				return;
			}
			resolve({ file: tmpOut, contentType: 'audio/mpeg', cleanup: () => cleanup(tmpIn, tmpOut) });
		};

		const timer = setTimeout(() => {
			child.kill();
			done(new Error(`edge TTS timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const unlisten = listenAbort(signal, () => {
			child.kill();
			done(abortError());
		});

		child.on('error', (err) => {
			const missing =
				err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
					? new Error(
							'edge-tts CLI not found — install it (`pip install edge-tts`) or switch the TTS engine in Settings'
						)
					: err;
			done(missing instanceof Error ? missing : new Error(String(missing)));
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-1000);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				done(new Error(`edge TTS exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
				return;
			}
			done(null);
		});
	});
}

// ── `openai` + `elevenlabs` engines: cloud HTTP ──────────────────────────

async function runCloudTts(opts: {
	engine: 'openai' | 'elevenlabs';
	text: string;
	baseUrl: string;
	key: string;
	voice: string;
	model: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ body: ArrayBuffer; contentType: string }> {
	const { engine, text, baseUrl, key, voice, model, timeoutMs, signal } = opts;
	throwIfAborted(signal);

	let url: string;
	let body: unknown;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };

	if (engine === 'openai') {
		// Any OpenAI-compatible `/audio/speech` endpoint (OpenAI, Kokoro, …).
		url = `${baseUrl.replace(/\/+$/, '')}/audio/speech`;
		headers['Authorization'] = `Bearer ${key}`;
		body = { model, input: text, voice: voice || 'alloy', response_format: 'mp3' };
	} else {
		url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice || 'pNInz6obpgDQGcFmaJgB')}`;
		headers['xi-api-key'] = key;
		body = { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			// Budget and cancellation share one signal; `AbortSignal.any` keeps
			// both without a wrapper promise.
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
				: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		if (signal?.aborted) throw abortError();
		if (err instanceof DOMException && err.name === 'TimeoutError') {
			throw new Error(`${engine} TTS timed out after ${timeoutMs}ms`, { cause: err });
		}
		throw err;
	}

	if (!response.ok) {
		// Status only — the body may echo the request back.
		throw new Error(`${engine} TTS failed: HTTP ${response.status}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error(`${engine} TTS returned empty audio`);
	return {
		body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		contentType: 'audio/mpeg'
	};
}

// ── preflight, dispatch, error mapping ───────────────────────────────────

export interface TtsPreflight {
	status: number;
	message: string;
}

/**
 * Fail before spawning anything when the configured engine cannot work:
 * missing cloud key, disallowed base URL, missing piper model. Returns `null`
 * when the engine is ready. Both routes call it — the streaming route needs it
 * *before* it commits to an SSE response, so the client gets a real HTTP status
 * it can fall back on instead of an error frame.
 */
export function preflightTts(settings: Settings = readSettings()): TtsPreflight | null {
	const tts = resolveTts(settings);

	if ((tts.provider === 'openai' || tts.provider === 'elevenlabs') && !tts.apiKey) {
		const hint =
			tts.provider === 'openai'
				? 'VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY (env) or tts.apiKey (settings)'
				: 'ELEVENLABS_API_KEY (env) or tts.apiKey (settings)';
		return { status: 503, message: `TTS API key not configured — set ${hint}` };
	}
	if (tts.provider === 'openai' && !isAllowedUrl(tts.baseUrl)) {
		return { status: 400, message: `URL not allowed: ${tts.baseUrl}` };
	}
	if (tts.provider === 'piper') {
		const { modelPath, error } = resolveTtsModelPath(settings);
		if (!modelPath) return { status: 503, message: error ?? 'TTS is not available' };
	}
	return null;
}

/**
 * One synthesis call, through the concurrency slot.
 *
 * `timeoutMs` is the budget for THIS chunk (the whole-reply route splits its
 * global budget across chunks; the streaming route gives each request the full
 * budget because each request is one sentence).
 */
export async function synthesizeChunk(opts: {
	text: string;
	settings?: Settings;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<SynthesizedChunk> {
	const settings = opts.settings ?? readSettings();
	throwIfAborted(opts.signal);
	await acquireSlot(opts.signal);
	try {
		return await dispatchChunk(opts.text, settings, opts.timeoutMs, opts.signal);
	} finally {
		releaseSlot();
	}
}

async function dispatchChunk(
	text: string,
	settings: Settings,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<SynthesizedChunk> {
	const tts = resolveTts(settings);

	if (tts.provider === 'system') {
		const {
			file,
			contentType,
			cleanup: done
		} = await runSystemTts(text, tts.voice, timeoutMs, signal);
		try {
			return { audio: readFileSync(file), contentType };
		} finally {
			done();
		}
	}
	if (tts.provider === 'edge') {
		const {
			file,
			contentType,
			cleanup: done
		} = await runEdgeTts(text, tts.voice, timeoutMs, signal);
		try {
			return { audio: readFileSync(file), contentType };
		} finally {
			done();
		}
	}
	if (tts.provider === 'openai' || tts.provider === 'elevenlabs') {
		// Resolved once by $lib/config (settings → engine env → ''); the route
		// never logs it and the cloud engines only ever see it in a header.
		const credential = tts.apiKey;
		const { body, contentType } = await runCloudTts({
			engine: tts.provider,
			text,
			baseUrl: tts.baseUrl,
			key: credential,
			voice: tts.voice,
			model: tts.model,
			timeoutMs,
			signal
		});
		return { audio: Buffer.from(body), contentType };
	}
	// `piper` — the original local engine.
	const { modelPath, error } = resolveTtsModelPath(settings);
	if (!modelPath) throw new Error(error ?? 'TTS is not available');
	const { tmpIn, tmpOut } = tempFiles('piper', 'wav');
	try {
		await synthesize({ text, modelPath, inputFile: tmpIn, outputFile: tmpOut, timeoutMs, signal });
		return { audio: readFileSync(tmpOut), contentType: 'audio/wav' };
	} finally {
		cleanup(tmpIn, tmpOut);
	}
}

/**
 * Human-readable failure text for a streaming error frame.
 *
 * Same vocabulary as `ttsErrorResponse` (engine messages already name the fix:
 * `edge-tts CLI not found — install…`, `TTS model file not found: <path>`), and
 * like every other surface it can never carry key material — cloud engines
 * report status codes only.
 */
export function ttsErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err ?? '');
	if (message.includes('ENOENT')) return 'TTS engine is not installed or not on PATH';
	return message || 'TTS failed';
}

/**
 * Map a synthesis failure to the route response both TTS endpoints share, so
 * `/api/tts` and `/api/tts/stream` report the same status for the same cause.
 * The message is engine-owned (`edge-tts CLI not found — install…`, `TTS model
 * file not found: <path>`) and always names the fix; keys never appear.
 */
export function ttsErrorResponse(err: unknown, timeoutMs: number): Response {
	const message = err instanceof Error ? err.message : String(err);
	console.error('TTS error:', message);

	if (isTtsAbort(err)) return new Response('TTS synthesis aborted', { status: 499 });
	if (message.includes('ENOENT')) {
		return new Response('TTS engine is not installed or not on PATH', { status: 503 });
	}
	if (message.includes('not found') || message.includes('not configured')) {
		return new Response(message, { status: 503 });
	}
	if (message.includes('timed out')) {
		return new Response(`TTS synthesis timed out after ${timeoutMs}ms`, { status: 504 });
	}
	if (message.includes('HTTP')) {
		return new Response(message, { status: 502 });
	}
	return new Response('TTS failed', { status: 500 });
}
