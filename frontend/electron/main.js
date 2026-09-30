// The Globe — Electron shell.
//
// The app itself is the adapter-node build (`build/index.js`): this process
// starts that server on a free loopback port and opens a window on it, so the
// packaged .app carries no separate server runtime — the Electron binary runs
// the server as a child (ELECTRON_RUN_AS_NODE).
import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 30_000;

let serverProcess = null;
let mainWindow = null;

/** `build/index.js` in dev, `Contents/Resources/server/index.js` when packaged. */
function serverEntry() {
	return app.isPackaged
		? path.join(process.resourcesPath, 'server', 'index.js')
		: path.join(here, '..', 'build', 'index.js');
}

/** Loopback port the server will bind (never a fixed port — no collisions). */
function getFreePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

/** Resolve once the server answers HTTP, reject on timeout or early exit. */
function waitForServer(port, timeoutMs) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		let settled = false;
		const finish = (err) => {
			if (settled) return;
			settled = true;
			serverProcess?.off('exit', onExit);
			serverProcess?.off('error', onError);
			err ? reject(err) : resolve();
		};
		const onExit = (code) => finish(new Error(`server exited during startup (code ${code})`));
		const onError = (err) => finish(err);
		serverProcess?.once('exit', onExit);
		serverProcess?.once('error', onError);

		const attempt = () => {
			if (settled) return;
			const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
				res.resume();
				finish();
			});
			req.on('error', () => {
				if (Date.now() > deadline) {
					finish(new Error(`server did not respond within ${timeoutMs / 1000}s`));
				} else {
					setTimeout(attempt, 250);
				}
			});
		};
		attempt();
	});
}

async function startServer() {
	const entry = serverEntry();
	if (!existsSync(entry)) {
		throw new Error(`No production build found at ${entry} — run \`npm run build\` first.`);
	}

	// `.globe-settings.json` is written to process.cwd(); in the packaged app
	// cwd would be `/`, so pin it to the per-app data directory instead.
	const cwd = app.isPackaged ? app.getPath('userData') : process.cwd();
	mkdirSync(cwd, { recursive: true });

	const port = await getFreePort();
	const env = {
		...process.env,
		ELECTRON_RUN_AS_NODE: '1',
		NODE_ENV: 'production',
		HOST: '127.0.0.1',
		PORT: String(port),
		// GUI-launched apps get a bare PATH; Piper (and brew-installed tools)
		// live outside it.
		PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`
	};

	serverProcess = spawn(process.execPath, [entry], {
		cwd,
		env,
		stdio: ['ignore', 'inherit', 'inherit']
	});

	await waitForServer(port, START_TIMEOUT_MS);
	return `http://127.0.0.1:${port}/`;
}

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>The Globe</title>
<style>html,body{height:100%;margin:0;background:#000;color:#7fb3ff;font:16px/1.4 -apple-system,system-ui,sans-serif;display:grid;place-items:center}
.spinner{width:28px;height:28px;border:3px solid #16304f;border-top-color:#7fb3ff;border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div style="text-align:center"><div class="spinner"></div>Waking the Globe…</div></body></html>`;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: '#000000',
		title: 'The Globe',
		autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
	});

	mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
		shell.openExternal(target);
		return { action: 'deny' };
	});
	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	// Show the window immediately with a splash, then swap in the app.
	mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
}

function showError(err) {
	const message = err instanceof Error ? err.message : String(err);
	// app.exit() skips before-quit, so stop the server child by hand.
	if (serverProcess && !serverProcess.killed) {
		serverProcess.kill('SIGTERM');
		serverProcess = null;
	}
	dialog.showErrorBox('The Globe', message);
	app.exit(1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	app.whenReady().then(async () => {
		// Splash first, so something is on screen while the server boots.
		createWindow();
		try {
			const url = await startServer();
			if (mainWindow) await mainWindow.loadURL(url);
		} catch (err) {
			showError(err);
		}
	});

	app.on('window-all-closed', () => {
		// Quit on every platform: the Node server child must not outlive the app.
		app.quit();
	});

	app.on('before-quit', () => {
		if (serverProcess && !serverProcess.killed) {
			serverProcess.kill('SIGTERM');
			serverProcess = null;
		}
	});
}
