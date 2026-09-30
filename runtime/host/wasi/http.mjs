// WASI HTTP client: porffor:http's send, over wasi:http 0.3 (client.send). The request body
// and the response body are stream<u8>s, read and written straight from Uint8Arrays
// (./http-body.mjs); every wait is a promise the component's event loop settles (the glue's
// js/async.mjs), so an async export yields to the host while a request is in flight.
// A failure is the host's: a TypeError whose payload is wasi:http's error-code.
// runtime/host/native/http.mjs is the same over libuv and mbedTLS.
//
// A guest world using it imports wasi:http/client@0.3.0 (the build's --target p3).

import { Fields, Request as WasiRequest, Response as WasiResponse } from 'wasi:http/types@0.3.0';
import { send as wasiSend } from 'wasi:http/client@0.3.0';
import {
	stream_u8_new,
	future_result_void_error_code_new,
	future_result_void_error_code_read,
	future_result_option_own_trailers_error_code_new,
	future_result_option_own_trailers_error_code_write
} from 'rt-async';
import { abortable, responseBody, writeBody } from './http-body.mjs';

const METHODS = ['get', 'head', 'post', 'put', 'delete', 'connect', 'options', 'trace', 'patch'];

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** wasi:http's scheme variant for a URL scheme (lower case, no colon). */
function schemeVariant(scheme) {
	if (scheme === 'http') return { tag: 'HTTP' };

	if (scheme === 'https') return { tag: 'HTTPS' };

	return { tag: 'other', val: scheme };
}

/**
 * Sends a request and resolves its response once the head is in; the body is read from the
 * host as the returned stream is read. `signal` cancels the request, the body write, and
 * (through the stream) the body read in flight: they reject with its reason.
 * @param {{ method: string, scheme: string, authority: string, path: string,
 *   headers: [string, string][], body: Uint8Array | ReadableStream | null }} request
 * @param {AbortSignal} signal
 * @returns {Promise<{ status: number, statusText: string, headers: [string, string][],
 *   body: ReadableStream }>}
 */
export async function send(request, signal) {
	const encoder = new TextEncoder();
	const method = request.method.toLowerCase();
	// the header list as given (not iteration's combined view)
	const fields = Fields.fromList(
		request.headers.map((entry) => [entry[0], encoder.encode(entry[1])])
	);

	let body = undefined;
	let writer = undefined;

	if (request.body !== null) [body, writer] = stream_u8_new();
	const [trailersReader, trailersWriter] = future_result_option_own_trailers_error_code_new();
	const [wasiRequest, sent] = WasiRequest.new(fields, body, trailersReader, undefined);

	// the request's outcome: read, not dropped (a dropped reader lets the host give up on it)
	future_result_void_error_code_read(sent).then(ignore, ignore);

	wasiRequest.setMethod(
		METHODS.includes(method) ? { tag: method } : { tag: 'other', val: request.method }
	);
	wasiRequest.setScheme(schemeVariant(request.scheme));
	wasiRequest.setAuthority(request.authority);
	wasiRequest.setPathWithQuery(request.path);

	const response = abortable(signal, wasiSend(wasiRequest));
	// the body goes out while the request is in flight; then the (empty) trailers
	const finish = async () => {
		try {
			if (writer !== undefined) await writeBody(writer, request.body, signal);
		} finally {
			future_result_option_own_trailers_error_code_write(trailersWriter, {
				tag: 'ok',
				val: undefined
			});
		}
	};

	finish().then(ignore, ignore);

	const wasi = await response;
	// read before consume-body, which takes the response resource
	const status = wasi.getStatusCode();
	const decoder = new TextDecoder();
	const headers = wasi
		.getHeaders()
		.copyAll()
		.map((entry) => [entry[0], decoder.decode(entry[1])]);
	// consume-body takes a future the guest completes when it is done with the body
	const [doneReader, doneWriter] = future_result_void_error_code_new();
	const [stream, trailers] = WasiResponse.consumeBody(wasi, doneReader);

	return {
		status,
		// HTTP/2 and later have no reason phrase, and wasi:http passes none on
		statusText: '',
		headers,
		body: responseBody(stream, trailers, doneWriter, signal)
	};
}
