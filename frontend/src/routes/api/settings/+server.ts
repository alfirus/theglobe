import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	assertApiRequest,
	mergeSettings,
	readSettings,
	sanitizeSettingsBody,
	settingsToPublic,
	SettingsValidationError,
	writeSettings
} from '$lib/config';

/**
 * GET /api/settings — key-free view of the settings.
 * Built by whitelisting fields: there is no `apiKey` key anywhere in the tree,
 * only `hasKey: boolean` (plus the non-secret `keySource` map).
 */
export const GET: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	return json(settingsToPublic(readSettings()));
};

/**
 * POST /api/settings — validate, sanitise and store settings.
 *
 * Unknown fields are stripped (the client posts its whole settings blob);
 * known fields with invalid values get a 400 carrying the reason.
 * The response is the key-free public view — an `apiKey` is never echoed back.
 */
export const POST: RequestHandler = async ({ request }) => {
	const denied = assertApiRequest(request);
	if (denied) return denied;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	try {
		const patch = sanitizeSettingsBody(body);
		const merged = mergeSettings(readSettings(), patch);
		writeSettings(merged);
		return json({ success: true, settings: settingsToPublic(merged) });
	} catch (err) {
		if (err instanceof SettingsValidationError) {
			return json({ error: err.message }, { status: 400 });
		}
		console.error('Settings write error:', err instanceof Error ? err.message : 'unknown error');
		return json({ error: 'Could not save settings' }, { status: 500 });
	}
};
