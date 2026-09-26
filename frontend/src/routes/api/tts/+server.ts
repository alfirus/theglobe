import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { assertApiRequest, readSettings, resolveTtsModelPath, resolveTtsTimeoutMs } from '$lib/config';

/**
 * POST /api/tts — synthesise speech with Piper.
 *
 * C1 (RCE) / M5 fix: the text is never interpolated into a shell command and it
 * never enters `argv`. It is written to a temp file whose read end is handed to
 * `piper` as its stdin, spawned with `shell: false`, so `$(…)`, backticks, `;`,
 * `|`, `&`, newlines and quotes are inert data — and multi-line replies
 * synthesise correctly. Both temp files are unlinked in a `finally`.
 *
 * D5 fix (measured on this machine, 27 Sep):
 *   - input mode: **file-backed stdin**, i.e. the validated text goes to a temp
 *     file and piper reads it to EOF. `piper -i <file> -f <out>` (file input via
 *     argv) was measured against `C:/Users/alfir/.local/bin/piper.exe` (1.2.0,
 *     the binary first on PATH): that build has **no `-i` option**, so it ignores
 *     the flag, blocks reading stdin and writes no file — killed at 120 s with 0
 *     bytes on disk, i.e. a 504 on every request. stdin mode instead completes in
 *     0.44–0.58 s warm (3.8 s cold) through this endpoint. The file-backed fd
 *     keeps the "text goes to a temp file, argv holds only flags" property while
 *     giving piper a deterministic EOF.
 *   - timeout: `TTS_TIMEOUT_MS` (default 120000) instead of a hard-coded 30 s.
 *     A max-length (2000-char → 102 s of audio) reply measured **40.0 s** wall
 *     through this endpoint, so the old 30 s cap 504'd on ordinary long replies
 *     even with a perfectly healthy piper.
 *   - missing model: 503 whose message names the exact path that was looked for.
 *
 * M4 fix: the model path comes from `PIPER_MODEL` (or `tts.modelPath` in settings)
 * and is validated before spawning; a missing model returns 503 with a clear
 * message instead of a silent 500.
 */

const MAX_TEXT = 2000;

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
				if (!existsSync(outputFile) || statSync(outputFile).size === 0) {
					reject(new Error(`piper exited 0 but wrote no output file at ${outputFile}`));
					return;
				}
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

	const { modelPath, error } = resolveTtsModelPath(readSettings());
	if (!modelPath) {
		return new Response(error ?? 'TTS is not available', { status: 503 });
	}

	const timeoutMs = resolveTtsTimeoutMs();
	const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
	const tmpIn = join(tmpdir(), `piper-${suffix}.txt`);
	const tmpOut = join(tmpdir(), `piper-${suffix}.wav`);

	try {
		await synthesize({ text, modelPath, inputFile: tmpIn, outputFile: tmpOut, timeoutMs });

		const wavBuffer = readFileSync(tmpOut);
		return new Response(wavBuffer, {
			headers: {
				'Content-Type': 'audio/wav',
				'Content-Length': String(wavBuffer.length)
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('Piper TTS error:', message.includes('ENOENT') ? 'piper not found on PATH' : message);

		if (message.includes('ENOENT')) {
			return new Response('Piper is not installed or not on PATH', { status: 503 });
		}
		if (message.includes('timed out')) {
			return new Response(`TTS synthesis timed out after ${timeoutMs}ms`, { status: 504 });
		}
		return new Response('TTS failed', { status: 500 });
	} finally {
		for (const file of [tmpIn, tmpOut]) {
			try {
				unlinkSync(file);
			} catch {
				/* nothing to clean up */
			}
		}
	}
};
