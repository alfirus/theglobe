// electron-builder afterPack hook (CommonJS — package.json is "type": "module").
//
// No Developer ID is configured for this project, so electron-builder skips
// signing entirely (mac.identity: null). An unsigned .app is killed by macOS
// on Apple Silicon, so fall back to an ad-hoc signature ("-"), which is enough
// to launch locally. Remove this hook once real signing is set up.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
	if (context.electronPlatformName !== 'darwin') return;

	const appName = context.packager.appInfo.productFilename;
	const appPath = path.join(context.appOutDir, `${appName}.app`);

	try {
		// Already signed (real identity or ad-hoc) — leave it alone.
		execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
		return;
	} catch {
		/* not signed — sign ad-hoc below */
	}

	execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
	console.log(`  • ad-hoc signed ${appPath}`);
};
