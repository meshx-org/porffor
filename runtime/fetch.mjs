// fetch() for a Porffor-compiled guest, over wasi:http 0.3 (client.send). The request
// body and the response body are stream<u8>s, read and written straight from
// Uint8Arrays; every wait is a promise the component's event loop settles (the glue's
// js/async.mjs), so an async export yields to the host while a request is in flight.
//
// Takes what the Request constructor takes (./request.mjs), or a Request: method, headers,
// a string / bytes / URLSearchParams / ReadableStream body, a signal, which cancels the
// request or the body read or write in flight (the promise rejects with the signal's
// reason). Resolves a Response (./response.mjs) whose body streams from the host. Not yet:
// redirect modes (the host decides), FormData. A data: URL is answered without the network.
//
// A guest world using it imports wasi:http/client@0.3.0 (the build's --target p3); the
// build then injects fetch, Response, Headers and EventSource as globals.

import { Fields, Request as WasiRequest } from 'wasi:http/types@0.3.0';
import { send } from 'wasi:http/client@0.3.0';
import {
	stream_u8_new,
	future_result_void_error_code_read,
	future_result_option_own_trailers_error_code_new,
	future_result_option_own_trailers_error_code_write
} from 'rt-async';
import { Headers } from './headers.mjs';
import { dataUrlResponse } from './data-url.mjs';
import { abortable, responseFromWasi, writeBody } from './http-body.mjs';
import { Request } from './request.mjs';
import { Response } from './response.mjs';

export { Headers, Request, Response };

const METHODS = ['get', 'head', 'post', 'put', 'delete', 'connect', 'options', 'trace', 'patch'];

/** An outcome nobody needs to see. */
const ignore = () => undefined;

function parseUrl(url) {
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)/.exec(url);

	if (match === null) throw new TypeError('fetch: not an absolute URL: ' + url);
	const scheme = match[1].toLowerCase();
	let tagged = { tag: 'other', val: scheme };

	if (scheme === 'http') tagged = { tag: 'HTTP' };
	else if (scheme === 'https') tagged = { tag: 'HTTPS' };

	return {
		scheme: tagged,
		authority: match[2],
		pathWithQuery: match[3] === '' ? '/' : match[3]
	};
}

/**
 * Sends a request and resolves its Response once the headers are in; the body is read
 * from the Response as it is wanted.
 */
export async function fetch(input, init) {
	// everything normalized once: the URL, the method, the headers, the body, the signal
	const req = new Request(input, init);
	const signal = req.signal;

	signal.throwIfAborted();

	// answered here, as fetch does for data: URLs: no request goes out
	if (req.url.startsWith('data:')) return dataUrlResponse(req.url);
	const method = req.method.toLowerCase();
	const where = parseUrl(req.url);
	const encoder = new TextEncoder();
	// the header list as given (not iteration's combined view)
	const fields = Fields.fromList(
		req.headers._list.map((entry) => [entry[0], encoder.encode(entry[1])])
	);

	let body = undefined;
	let writer = undefined;

	if (req._body !== null) [body, writer] = stream_u8_new();
	const [trailersReader, trailersWriter] = future_result_option_own_trailers_error_code_new();
	const [request, sent] = WasiRequest.new(fields, body, trailersReader, undefined);

	// the request's outcome: read, not dropped (a dropped reader lets the host give up on it)
	future_result_void_error_code_read(sent).then(ignore, ignore);

	request.setMethod(METHODS.includes(method) ? { tag: method } : { tag: 'other', val: req.method });
	request.setScheme(where.scheme);
	request.setAuthority(where.authority);
	request.setPathWithQuery(where.pathWithQuery);

	const response = abortable(signal, send(request));
	// the body goes out while the request is in flight; then the (empty) trailers
	const finish = async () => {
		try {
			if (writer !== undefined) await writeBody(writer, req._body.stream, signal);
		} finally {
			future_result_option_own_trailers_error_code_write(trailersWriter, {
				tag: 'ok',
				val: undefined
			});
		}
	};

	finish().then(ignore, ignore);

	return responseFromWasi(await response, req.url, signal);
}
