// WASI server: porffor:http-server, a fetch handler as a wasi:http 0.3 server. The world exports
// wasi:http/handler@0.3.0; each incoming request becomes a Request whose body streams from the
// host, and the Response (runtime/serve.mjs's respond) goes back with its body streamed out after
// the head (the export's task runs on until the body is written: glue.c). The build makes
// serve(app) the handler export when the world exports the interface (wasi/scripts/bundle.mjs).
// runtime/host/native/http-server.mjs is the same over a socket.

import { Fields, Request as WasiRequest, Response as WasiResponse } from 'wasi:http/types@0.3.0';
import {
	stream_u8_new,
	future_result_void_error_code_new,
	future_result_void_error_code_read,
	future_result_option_own_trailers_error_code_new,
	future_result_option_own_trailers_error_code_write
} from 'rt-async';
import { AbortSignal } from '../../abort-signal.mjs';
import { Headers } from '../../headers.mjs';
import { incomingRequest } from '../../request.mjs';
import { checkApp, respond } from '../../serve.mjs';
import { URL } from '../../url.mjs';
import { responseBody, writeBody } from './http-body.mjs';

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
	const methodName = method.tag === 'other' ? method.val : METHOD_NAMES[method.tag];
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
	const bodyless = methodName === 'GET' || methodName === 'HEAD';

	if (bodyless) body.cancel().then(ignore, ignore);
	// (parsed: the host hands over an authority and a path, not a URL)
	const url = new URL(`${schemeText}://${authority}${path}`).href;

	return incomingRequest(url, methodName, headers, bodyless ? null : body, new AbortSignal());
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

/**
 * The wasi:http/handler export for an app with a fetch method.
 * @param {{ fetch(request: Request, env: object, ctx: object): Response | Promise<Response> }} app
 */
export function serve(app) {
	checkApp(app);

	return {
		async handle(wasiRequest) {
			return responseToWasi(await respond(app, requestFromWasi(wasiRequest)));
		}
	};
}
