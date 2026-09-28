import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { POST as postTts } from '../../src/routes/api/tts/+server';
import {
	call,
	clearSettingsFile,
	postJson,
	stubFetch,
	writeSettingsFile
} from '../helpers';

/** The C1 RCE payload class: shell metacharacters in user text. */
const PAYLOAD = '$(calc); rm -rf ~ # `whoami` && echo "pwned"';

type SpawnRecord = {
	cmd: string;
	argv: string[];
	opts: Record<string, unknown>;
	stdin: Buffer[];
};

const spawns = vi.hoisted(() => ({ calls: [] as SpawnRecord[] }));

vi.mock('node:child_process', () => ({
	spawn: (cmd: string, argv: string[], opts: Record<string, unknown>) => {
		const record: SpawnRecord = { cmd, argv, opts, stdin: [] };
		spawns.calls.push(record);

		const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
		let finished = false;

		const emit = (event: string, ...args: unknown[]): void => {
			for (const cb of listeners[event] ?? []) cb(...args);
		};

		/** Where this engine wants its WAV; the fake synthesises one there. */
		const outPath = (): string | null => {
			for (let i = 0; i < argv.length; i++) {
				if (argv[i] === '-o' || argv[i] === '-w') return argv[i + 1] ?? null;
			}
			// Windows SAPI: the path lives inside the PowerShell -Command script.
			const script = argv.join(' ');
			const match = script.match(/"([^"]+\.wav)"/);
			return match ? match[1] : null;
		};

		const finish = (): void => {
			if (finished) return;
			finished = true;
			const file = outPath();
			if (file) fs.writeFileSync(file, minimalWav());
			emit('close', 0);
		};

		// The route registers its `close` listener synchronously after spawn
		// returns and then writes stdin — one macrotask is enough to be after both.
		setImmediate(finish);

		return {
			stdin: {
				write: (chunk: unknown): boolean => {
					record.stdin.push(Buffer.from(chunk as string | Buffer));
					return true;
				},
				end: (): void => finish()
			},
			stderr: { on: () => {} },
			on: (event: string, cb: (...args: unknown[]) => void): void => {
				(listeners[event] ??= []).push(cb);
			},
			kill: (): void => {}
		};
	}
}));

/** 44-byte PCM WAV header + a little payload — enough for `splitWav`. */
function minimalWav(pcmBytes = 64): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(36 + pcmBytes, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(22_050, 24);
	header.writeUInt32LE(44_100, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(pcmBytes, 40);
	return Buffer.concat([header, Buffer.alloc(pcmBytes, 0x40)]);
}

/** Text this spawn handed to the engine — stdin (Windows) or argv (POSIX). */
function spawnedText(record: SpawnRecord): string {
	const stdinText = record.stdin.map((chunk) => chunk.toString('utf8')).join('');
	if (stdinText) {
		try {
			return Buffer.from(stdinText, 'base64').toString('utf16le');
		} catch {
			return stdinText;
		}
	}
	return record.argv.join('\n');
}

/** The utterance itself: stdin payload, or the final argv element on POSIX. */
function engineText(record: SpawnRecord): string {
	if (record.stdin.length > 0) return spawnedText(record);
	return record.argv[record.argv.length - 1];
}

function ttsRequest(body: unknown, init: RequestInit = {}): Request {
	return postJson('/api/tts', body, init);
}

describe('POST /api/tts — validation', () => {
	beforeEach(() => clearSettingsFile());

	it('rejects invalid JSON, empty text and non-string text', async () => {
		const badJson = await call(postTts, ttsRequest('{"text": '));
		expect(badJson.status).toBe(400);

		const empty = await call(postTts, ttsRequest({ text: '   ' }));
		expect(empty.status).toBe(400);
		expect(await empty.text()).toContain('Text is required');

		const wrongType = await call(postTts, ttsRequest({ text: 42 }));
		expect(wrongType.status).toBe(400);
	});

	it('rejects text over the 8 000 character cap', async () => {
		const res = await call(postTts, ttsRequest({ text: 'x'.repeat(8_001) }));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('8000');
	});

	it('rejects a cross-origin caller', async () => {
		const res = await call(
			postTts,
			ttsRequest({ text: 'hello' }, { headers: { origin: 'https://evil.example.com' } })
		);
		expect(res.status).toBe(403);
	});
});

describe('POST /api/tts — command injection stays inert (C1 / M5)', () => {
	beforeEach(() => {
		clearSettingsFile();
		spawns.calls.length = 0;
	});

	it('never puts user text in a shell command', async () => {
		const res = await call(postTts, ttsRequest({ text: PAYLOAD }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('audio/wav');
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(44);

		expect(spawns.calls).toHaveLength(1);
		const { cmd, argv, opts } = spawns.calls[0];

		// 1. No shell, ever — the child is exec'd directly.
		expect(opts.shell).toBe(false);

		// 2. The command is a fixed engine binary, never built from request data.
		expect(['powershell', 'espeak-ng', 'say']).toContain(cmd);

		// 3. The payload must survive as inert data, split across neither the
		//    command string nor more than one argv element.
		const inArgv = argv.filter((arg) => arg.includes('$(calc)'));
		if (process.platform === 'win32') {
			// Windows SAPI pipes the text through stdin as base64 → it must not
			// appear on the command line at all.
			expect(argv.join(' ')).not.toContain('$(calc)');
			expect(inArgv).toHaveLength(0);
			expect(spawnedText(spawns.calls[0])).toContain('$(calc)');
		} else {
			// POSIX hands the utterance to `say`/`espeak-ng` as one final argv
			// element (no shell to interpret it).
			expect(inArgv).toHaveLength(1);
			expect(argv[argv.length - 1]).toBe(inArgv[0]);
			expect(cmd).not.toContain('$(calc)');
		}
	});

	it('keeps a multi-line payload intact as data', async () => {
		const multiline = `line one\nline two; echo $HOME\`id\`\nline three`;
		const res = await call(postTts, ttsRequest({ text: multiline }));
		expect(res.status).toBe(200);

		const record = spawns.calls[0];
		expect(record.opts.shell).toBe(false);
		const text = spawnedText(record);
		// Whitespace normalisation is allowed; shell control flow must not survive
		// as more than one command — there is no command at all.
		expect(text).toContain('line one');
		expect(text).toContain('echo $HOME');
		expect(text).toContain('line three');
	});

	it('splits long replies into engine-sized chunks instead of one giant command', async () => {
		const longText = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} about the globe.`)
			.join(' ')
			.repeat(25);

		const res = await call(postTts, ttsRequest({ text: longText }));
		expect(res.status).toBe(200);
		expect(longText.length).toBeGreaterThan(1_500);

		// One spawn per ≤1 500-char chunk — not one spawn with the whole reply.
		expect(spawns.calls.length).toBeGreaterThan(1);
		for (const record of spawns.calls) {
			expect(record.opts.shell).toBe(false);
			expect(engineText(record).length).toBeLessThanOrEqual(1_500);
		}

		// Chunks are re-joined into one WAV with patched RIFF/data sizes.
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
		expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
		expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
		expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
	});
});

describe('POST /api/tts — engine configuration gates', () => {
	beforeEach(() => {
		clearSettingsFile();
		spawns.calls.length = 0;
	});

	it('answers 503 for a cloud engine with no key, naming the env var', async () => {
		writeSettingsFile({ tts: { provider: 'openai' } });
		const res = await call(postTts, ttsRequest({ text: 'hello' }));
		expect(res.status).toBe(503);
		expect(await res.text()).toContain('VOICE_TOOLS_OPENAI_KEY');
		expect(spawns.calls).toHaveLength(0);
	});

	it('refuses a non-allow-listed cloud endpoint without fetching it', async () => {
		writeSettingsFile({ tts: { provider: 'openai', baseUrl: 'https://evil.example.com', apiKey: 'x' } });
		const fetchStub = stubFetch();

		const res = await call(postTts, ttsRequest({ text: 'hello' }));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('URL not allowed');
		expect(fetchStub.calls).toHaveLength(0);
	});

	it('answers 503 when piper has no model configured, naming where it looked', async () => {
		writeSettingsFile({ tts: { provider: 'piper' } });
		const res = await call(postTts, ttsRequest({ text: 'hello' }));
		expect(res.status).toBe(503);
		expect(await res.text()).toContain('TTS model');
		expect(spawns.calls).toHaveLength(0);
	});
});
