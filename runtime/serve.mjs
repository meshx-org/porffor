// A fetch handler as a wasi:http 0.3 server: the world exports wasi:http/handler@0.3.0,
// and the guest's default export is `{ fetch(request, env, ctx) }` (Cloudflare's module
// form; a Hono app is one). Each incoming request becomes a Request whose body streams
// from the host; the Response goes back with its body streamed out after the head (the
// export's task runs on until the body is written: glue.c).
//
// env is the process environment (wasi:cli/environment, when the world imports it) as an
// object; ctx has waitUntil (the task already runs until what the guest started is done)
// and passThroughOnException (a no-op). A handler that throws, or returns no Response,
// answers 500.
//
// The build wires this up (bundle.mjs) when the world exports wasi:http/handler@0.3.0.

import { Fields, Request as WasiRequest, Response as WasiResponse } from 'wasi:http/types@0.3.0';
import { environment } from 'wasi-porffor:environment';
import {
	stream_u8_new,
	future_result_void_error_code_new,
	future_result_void_error_code_read,
	future_result_option_own_trailers_error_code_new,
	future_result_option_own_trailers_error_code_write
} from 'rt-async';
import { Headers } from './headers.mjs';
import { responseBody, writeBody } from './http-body.mjs';
import { Request } from './request.mjs';
import { Response } from './response.mjs';

const METHOD_NAMES = {
	get: 'GET',
	head: 'HEAD',
	post: 'POST',
	put: 'PUT',
	delete: 'DELETE',
	connect: 'CONNECT',
	options: 'OPTIONS',
	trace: 'TRACE',
	patch: 'PATCH'
};

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** A Request over the host's incoming request. */
function requestFromWasi(wasi) {
	const method = wasi.getMethod();
	const scheme = wasi.getScheme();
	let schemeText = 'http';

	if (scheme !== undefined) {
		if (scheme.tag === 'HTTPS') schemeText = 'https';
		else if (scheme.tag === 'other') schemeText = scheme.val;
	}
	const authority = wasi.getAuthority() ?? 'localhost';
	const path = wasi.getPathWithQuery() ?? '/';
	const decoder = new TextDecoder();
	const headers = new Headers(
		wasi
			.getHeaders()
			.copyAll()
			.map((entry) => [entry[0], decoder.decode(entry[1])])
	);
	// the body, read from the host as the handler reads it
	const [doneReader, doneWriter] = future_result_void_error_code_new();
	const [stream, trailers] = WasiRequest.consumeBody(wasi, doneReader);
	const body = responseBody(stream, trailers, doneWriter, undefined);
	const request = new Request(`${schemeText}://${authority}${path}`, { headers });

	// set directly: CONNECT and TRACE reach a server though Request refuses to make them
	request._method = method.tag === 'other' ? method.val : METHOD_NAMES[method.tag];

	if (request.method === 'GET' || request.method === 'HEAD') body.cancel().then(ignore, ignore);
	else request._body = { stream: body };

	return request;
}

/** The host's response for a Response: the head now, the body streamed out after. */
function responseToWasi(response) {
	const encoder = new TextEncoder();
	const fields = Fields.fromList(
		response.headers._list.map((entry) => [entry[0], encoder.encode(entry[1])])
	);
	let contents = undefined;
	let writer = undefined;

	if (response._body !== null) [contents, writer] = stream_u8_new();
	const [trailersReader, trailersWriter] = future_result_option_own_trailers_error_code_new();
	const [wasi, sent] = WasiResponse.new(fields, contents, trailersReader);

	wasi.setStatusCode(response.status);
	// the response's outcome: read, not dropped
	future_result_void_error_code_read(sent).then(ignore, ignore);
	const finish = async () => {
		try {
			if (writer !== undefined) await writeBody(writer, response._body.stream, undefined);
		} finally {
			future_result_option_own_trailers_error_code_write(trailersWriter, {
				tag: 'ok',
				val: undefined
			});
		}
	};

	finish().then(ignore, (error) => {
		console.error('response body failed: ' + (error?.message ?? error));
	});

	return wasi;
}

/** The context a fetch handler gets. */
const ctx = {
	// the export's task already runs until everything the guest started is done
	waitUntil: ignore,
	passThroughOnException: ignore
};

/**
 * The wasi:http/handler export for an app with a fetch method.
 * @param {{ fetch(request: Request, env: object, ctx: object): Response | Promise<Response> }} app
 */
export function httpHandler(app) {
	if (app === null || app === undefined || typeof app.fetch !== 'function')
		throw new TypeError('the guest must export default { fetch(request, env, ctx) }');

	return {
		async handle(wasiRequest) {
			const request = requestFromWasi(wasiRequest);
			let response;

			try {
				response = await app.fetch(request, environment(), ctx);

				if (!(response instanceof Response))
					throw new TypeError('the fetch handler did not return a Response');
			} catch (error) {
				console.error('fetch handler failed: ' + (error?.stack ?? error?.message ?? error));
				response = new Response('Internal Server Error', { status: 500 });
			}

			return responseToWasi(response);
		}
	};
}
