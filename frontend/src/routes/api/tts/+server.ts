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
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	isAllowedUrl,
	readSettings,
	resolveTts,
	resolveTtsModelPath,
	resolveTtsTimeoutMs
} from '$lib/config';

/**
 * POST /api/tts — synthesise speech with the configured TTS engine.
 *
 * Hermes-style engine table (`tts.provider` in settings):
 *   - `system` (default) — the OS-native voice, zero setup on every platform:
 *     macOS `say`, Windows SAPI (`PowerShell System.Speech`), Linux `espeak-ng`.
 *   - `piper` — the local Piper binary + voice model (the original engine).
 *   - `edge` — Microsoft Edge TTS, free, no key, via the `edge-tts` CLI.
 *   - `openai` — any OpenAI-compatible `/audio/speech` endpoint
 *     (default: OpenAI `gpt-4o-mini-tts`; Kokoro-style servers work by
 *     overriding the base URL).
 *   - `elevenlabs` — ElevenLabs premium voices.
 *
 * Cloud-engine keys (`openai`, `elevenlabs`) live server-side only — same
 * contract as the LLM providers: settings file → engine env var → ''.
 *
 * C1 (RCE) / M5 fix (piper path): the text is never interpolated into a shell
 * command and it never enters `argv`. It is written to a temp file whose read
 * end is handed to `piper` as its stdin, spawned with `shell: false`.
 */

const MAX_TEXT = 8000;
/** One synthesis call never exceeds this — longer replies are chunked (Hermes parity). */
const CHUNK_TEXT = 1500;

/**
 * Split `text` into sentence-aware chunks of at most CHUNK_TEXT chars.
 * Splits on sentence/line boundaries first, then on word boundaries; a single
 * pathological token longer than the cap is hard-split. Nothing is dropped —
 * the chunks rejoin to the original text (modulo boundary whitespace).
 */
function chunkText(text: string, max: number = CHUNK_TEXT): string[] {
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
function concatWav(buffers: Buffer[]): Buffer {
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

function cleanup(...files: string[]): void {
	for (const file of files) {
		try {
			unlinkSync(file);
		} catch {
			/* nothing to clean up */
		}
	}
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

// ── `system` engine: OS-native voices ────────────────────────────────────────

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
	timeoutMs: number
): Promise<{ file: string; contentType: string; cleanup: () => void }> {
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

// ── `piper` engine (original local engine) ───────────────────────────────────

interface SynthesisOptions {
	text: string;
	modelPath: string;
	inputFile: string;
	outputFile: string;
	timeoutMs: number;
}

/** Write `text` to `inputFile`, run piper with that file as stdin, verify the WAV. */
function synthesize({
	text,
	modelPath,
	inputFile,
	outputFile,
	timeoutMs
}: SynthesisOptions): Promise<void> {
	// The validated text lives in a temp file, never on the command line.
	writeFileSync(inputFile, text.endsWith('\n') ? text : `${text}\n`, 'utf-8');
	const stdinFd = openSync(inputFile, 'r');

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let stderr = '';

		// shell: false — piper is exec'd directly; argv holds only flags plus
		// paths we generated, and no shell ever sees the text.
		const child = spawn('piper', ['--model', modelPath, '--output_file', outputFile], {
			shell: false,
			// stdin comes from the temp file's read fd → EOF when the text ends,
			// so piper can never block waiting for more input.
			stdio: [stdinFd, 'ignore', 'pipe'],
			windowsHide: true
		});

		let timedOut = false;
		let grace: ReturnType<typeof setTimeout> | undefined;

		const timer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			child.kill();
			// Windows cannot unlink a file the child still holds open, so the real
			// rejection happens on `close` (below) and the `finally` unlink then
			// succeeds. The grace timer is only a safety net for a kill that does
			// not take.
			grace = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`piper timed out after ${timeoutMs}ms`));
			}, 5_000);
		}, timeoutMs);

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
			if (timedOut) {
				reject(new Error(`piper timed out after ${timeoutMs}ms`));
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
		try {
			closeSync(stdinFd);
		} catch {
			/* already closed by the child / never opened */
		}
	});
}

// ── `edge` engine: free Microsoft Edge TTS via the edge-tts CLI ─────────────

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
	timeoutMs: number
): Promise<{ file: string; contentType: string; cleanup: () => void }> {
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

// ── `openai` + `elevenlabs` engines: cloud HTTP ──────────────────────────────

async function runCloudTts(opts: {
	engine: 'openai' | 'elevenlabs';
	text: string;
	baseUrl: string;
	apiKey: string;
	voice: string;
	model: string;
	timeoutMs: number;
}): Promise<{ body: ArrayBuffer; contentType: string }> {
	const { engine, text, baseUrl, apiKey, voice, model, timeoutMs } = opts;

	let url: string;
	let body: unknown;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };

	if (engine === 'openai') {
		// Any OpenAI-compatible `/audio/speech` endpoint (OpenAI, Kokoro, …).
		url = `${baseUrl.replace(/\/+$/, '')}/audio/speech`;
		headers['Authorization'] = `Bearer ${apiKey}`;
		body = { model, input: text, voice: voice || 'alloy', response_format: 'mp3' };
	} else {
		url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice || 'pNInz6obpgDQGcFmaJgB')}`;
		headers['xi-api-key'] = apiKey;
		body = { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
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

// ── route ────────────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let text: unknown;
	try {
		({ text } = await request.json());
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	if (typeof text !== 'string' || text.trim().length === 0) {
		return new Response('Text is required', { status: 400 });
	}
	if (text.length > MAX_TEXT) {
		return new Response(`Text exceeds maximum length (${MAX_TEXT})`, { status: 400 });
	}

	const settings = readSettings();
	const tts = resolveTts(settings);
	const timeoutMs = resolveTtsTimeoutMs();
	// Long replies are spoken in sentence-aware chunks; each chunk gets its own
	// synthesis call inside the shared budget (chunk i gets timeoutMs/(n-i)).
	const chunks = chunkText(text);
	if (chunks.length === 0) {
		return new Response('Text is required', { status: 400 });
	}
	const chunkTimeout = (i: number): number =>
		Math.max(5_000, Math.floor(timeoutMs / (chunks.length - i)));

	/** One chunk → audio bytes. File engines return WAV, cloud engines MP3. */
	async function synthChunk(
		chunk: string,
		i: number
	): Promise<{ audio: Buffer; contentType: string }> {
		const budget = chunkTimeout(i);
		if (tts.provider === 'system') {
			const { file, contentType, cleanup: done } = await runSystemTts(chunk, tts.voice, budget);
			try {
				return { audio: readFileSync(file), contentType };
			} finally {
				done();
			}
		}
		if (tts.provider === 'edge') {
			const { file, contentType, cleanup: done } = await runEdgeTts(chunk, tts.voice, budget);
			try {
				return { audio: readFileSync(file), contentType };
			} finally {
				done();
			}
		}
		if (tts.provider === 'openai' || tts.provider === 'elevenlabs') {
			const { body, contentType } = await runCloudTts({
				engine: tts.provider,
				text: chunk,
				baseUrl: tts.baseUrl,
				apiKey: tts.apiKey,
				voice: tts.voice,
				model: tts.model,
				timeoutMs: budget
			});
			return { audio: Buffer.from(body), contentType };
		}
		// `piper` — the original local engine.
		const { modelPath, error } = resolveTtsModelPath(settings);
		if (!modelPath) throw new Error(error ?? 'TTS is not available');
		const { tmpIn, tmpOut } = tempFiles('piper', 'wav');
		try {
			await synthesize({
				text: chunk,
				modelPath,
				inputFile: tmpIn,
				outputFile: tmpOut,
				timeoutMs: budget
			});
			return { audio: readFileSync(tmpOut), contentType: 'audio/wav' };
		} finally {
			cleanup(tmpIn, tmpOut);
		}
	}

	try {
		if ((tts.provider === 'openai' || tts.provider === 'elevenlabs') && !tts.apiKey) {
			const hint =
				tts.provider === 'openai'
					? 'VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY (env) or tts.apiKey (settings)'
					: 'ELEVENLABS_API_KEY (env) or tts.apiKey (settings)';
			return new Response(`TTS API key not configured — set ${hint}`, { status: 503 });
		}
		if (tts.provider === 'openai' && !isAllowedUrl(tts.baseUrl)) {
			return new Response(`URL not allowed: ${tts.baseUrl}`, { status: 400 });
		}

		const parts: { audio: Buffer; contentType: string }[] = [];
		for (let i = 0; i < chunks.length; i++) {
			parts.push(await synthChunk(chunks[i], i));
		}

		// Single chunk: return it untouched. Multiple WAV chunks: one header +
		// joined PCM. Multiple MP3 chunks: frames concatenate natively.
		let audio: Buffer;
		const contentType = parts[0].contentType;
		if (parts.length === 1) {
			audio = parts[0].audio;
		} else if (contentType === 'audio/wav') {
			audio = concatWav(parts.map((p) => p.audio));
		} else {
			audio = Buffer.concat(parts.map((p) => p.audio));
		}
		// Fresh ArrayBuffer copy: narrows Buffer's ArrayBuffer|SharedArrayBuffer union
		// to what the DOM Response type accepts.
		const view = new Uint8Array(audio.length);
		view.set(audio);
		return new Response(view.buffer, {
			headers: { 'Content-Type': contentType, 'Content-Length': String(audio.length) }
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('TTS error:', message);

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
};
