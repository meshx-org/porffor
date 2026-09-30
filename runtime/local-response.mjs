// What fetch answers without the network: a data: URL's Response (./data-url.mjs), and a blob: URL's
// Blob (the Request resolved it when it was made). Shared by fetch.mjs and the WPT runner's
// offline fetch (wasi/wpt/guest.mjs), which has no network either.
import { dataUrlResponse } from './data-url.mjs';
import { Response } from './response.mjs';

/**
 * The Response for a data: or blob: URL's Request, or null for another URL. A TypeError for a
 * blob: URL that names no Blob, or a method other than GET on one.
 * @param {import('./request.mjs').Request} req
 */
export function localResponse(req) {
	if (req.url.startsWith('data:')) {
		const response = dataUrlResponse(req.url);

		// a HEAD request gets the head alone
		if (req.method === 'HEAD') response._body = null;

		return response;
	}

	if (!req.url.startsWith('blob:')) return null;
	const blob = req._blob;

	if (blob === null || blob === undefined || req.method !== 'GET')
		throw new TypeError(`fetch: cannot fetch ${req.method} ${req.url}`);
	const response = new Response(blob, {
		headers: { 'content-type': blob.type, 'content-length': String(blob.size) }
	});

	response._type = 'basic';
	response._url = req.url;
	response._headers._guard = 'immutable';

	return response;
}
