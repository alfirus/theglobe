import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-test-file setup (runs before the test module is imported).
 *
 * 1. `$lib/config` captures `process.cwd()` at import time to locate
 *    `.globe-settings.json`. Chdir into a fresh, empty temp dir here so no test
 *    can ever read the developer's real settings file (which holds provider
 *    API keys) — and so every test file starts from an empty settings state.
 *
 * 2. Clear the secret-bearing environment variables. The host machine may have
 *    `HERMES_API_KEY` / `API_SERVER_KEY` / cloud TTS keys exported; inheriting
 *    them would make `hasKey`, `keySource` and the `/api/*` guard assertions
 *    depend on the machine instead of the code.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-tests-'));
process.chdir(sandbox);

const SECRET_ENV = /^(HERMES_API_KEY|GLOB_ALLOWED_ORIGINS|API_SERVER_KEY|VOICE_TOOLS_OPENAI_KEY|OPENAI_API_KEY|ELEVENLABS_API_KEY|PIPER_MODEL|TTS_TIMEOUT_MS)/;
for (const name of Object.keys(process.env)) {
	if (SECRET_ENV.test(name)) delete process.env[name];
}
