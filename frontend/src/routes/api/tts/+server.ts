import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { assertApiRequest, readSettings, resolveTtsModelPath } from '$lib/config';

/**
 * POST /api/tts — synthesise speech with Piper.
 *
 * C1 (RCE) / M5 fix: the text is never interpolated into a shell command. It is
 * written to `piper`'s stdin with `shell: false`, so `$(…)`, backticks, `;`, `|`,
 * newlines and quotes are inert data — and multi-line replies synthesise correctly.
 *
 * M4 fix: the model path comes from `PIPER_MODEL` (or `tts.modelPath` in settings)
 * and is validated before spawning; a missing model returns 503 with a clear
 * message instead of a silent 500.
 */

const MAX_TEXT = 2000;
const SYNTH_TIMEOUT_MS = 30_000;

function synthesize(text: string, modelPath: string, outputFile: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// shell: false — piper is exec'd directly, no shell ever sees the text.
		const child = spawn('piper', ['--model', modelPath, '--output_file', outputFile], {
			shell: false,
			stdio: ['pipe', 'ignore', 'pipe'],
			windowsHide: true
		});

		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`piper timed out after ${SYNTH_TIMEOUT_MS}ms`));
		}, SYNTH_TIMEOUT_MS);

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-1000);
		});

		// If piper exits before consuming stdin we get EPIPE — that is not an error
		// we need to surface (the close/code check below reports the real failure).
		child.stdin.on('error', () => {});

		child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
		child.stdin.end();

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`piper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
		});
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

	const tmpWav = join(tmpdir(), `piper-${process.pid}-${randomBytes(6).toString('hex')}.wav`);

	try {
		await synthesize(text, modelPath, tmpWav);

		const wavBuffer = readFileSync(tmpWav);
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
			return new Response('TTS synthesis timed out', { status: 504 });
		}
		return new Response('TTS failed', { status: 500 });
	} finally {
		try {
			unlinkSync(tmpWav);
		} catch {
			/* nothing to clean up */
		}
	}
};
