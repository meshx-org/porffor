// fetch() for a Porffor-compiled program, over the platform's HTTP client (porffor:http):
// wasi:http 0.3 in a WASI component (runtime/host/wasi/http.mjs), HTTP/1.1 over libuv and
// mbedTLS natively (runtime/host/native/http.mjs). Every wait is a promise the platform's
// event loop settles, so the program goes on while a request is in flight.
//
// Takes what the Request constructor takes (./request.mjs), or a Request: method, headers,
// a string / bytes / URLSearchParams / Blob / ReadableStream body, a signal, which cancels
// the request or the body read or write in flight (the promise rejects with the signal's
// reason), and a redirect mode. Redirects are followed here, as the fetch standard says
// (up to 20; a 303, or a 301 / 302 after a POST, turns into a GET without the body), unless
// the mode is 'error' (a TypeError) or 'manual' (the redirect is the response, as Node
// gives it). Resolves a Response (./response.mjs) whose body streams from the host. A
// data: or blob: URL is answered without the network.
//
// A WASI guest world using it imports wasi:http/client@0.3.0 (the build's --target p3); the
// build then injects fetch, Response, Headers and EventSource as globals.

import { send } from 'porffor:http';
import { Headers } from './headers.mjs';
import { localResponse } from './local-response.mjs';
import { ReadableStream } from './readable-stream.mjs';
import { Request } from './request.mjs';
import { Response } from './response.mjs';
import { URL } from './url.mjs';

export { Headers, Request, Response };

const REDIRECTS = [301, 302, 303, 307, 308];
/** How many redirects a fetch follows before it gives up (the standard's limit). */
const MAX_REDIRECTS = 20;
/** The headers that describe a body: dropped with the body when a redirect turns into a GET. */
const BODY_HEADERS = [
	'content-type',
	'content-length',
	'content-encoding',
	'content-language',
	'content-location'
];
/** The credentials a redirect to another origin does not carry along. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

/** A URL's parts, as the platform's send takes them. */
function urlParts(url) {
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)/.exec(url);

	if (match === null) throw new TypeError('fetch: not an absolute URL: ' + url);

	return {
		scheme: match[1].toLowerCase(),
		authority: match[2],
		path: match[3] === '' ? '/' : match[3]
	};
}

/** All of a stream's bytes, as one Uint8Array. */
async function streamBytes(stream) {
	const reader = stream.getReader();
	const chunks = [];
	let length = 0;

	while (true) {
		const { value, done } = await reader.read();

		if (done) break;
		chunks.push(value);
		length += value.length;
	}

	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(length);
	let at = 0;

	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}

	return out;
}

/**
 * The body to send: bytes when it came from bytes, a string, a Blob or URLSearchParams
 * (already in memory: its length is known, and a redirect can send it again), else the
 * stream it is, sent as it is read.
 */
async function requestBody(req, init) {
	if (req._body === null) return null;
	const source = init?.body;

	if (source !== undefined && source !== null && !(source instanceof ReadableStream))
		return streamBytes(req._body.stream);

	return req._body.stream;
}

/** The Response for what the platform sent back. */
function makeResponse(head, url, redirected) {
	const response = new Response(null);

	response._status = head.status;
	response._statusText = head.statusText;
	response._url = url;
	response._redirected = redirected;
	// a response from the network, whose headers are what came back
	response._type = 'basic';
	response._headers = new Headers(head.headers);
	response._headers._guard = 'immutable';
	response._body = head.body === null ? null : { stream: head.body };

	return response;
}

/** A header list without the given names. */
function withoutHeaders(headers, names) {
	return headers.filter((entry) => !names.includes(entry[0]));
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

	// answered here, as fetch does for data: and blob: URLs: no request goes out
	const local = localResponse(req);

	if (local !== null) return local;
	let url = req.url;
	let method = req.method;
	// the header list as given (not iteration's combined view)
	let headers = req.headers._list.map((entry) => [entry[0], entry[1]]);
	let body = await requestBody(req, init);
	let redirects = 0;

	while (true) {
		const parts = urlParts(url);

		if (parts.scheme !== 'http' && parts.scheme !== 'https')
			throw new TypeError('fetch: unsupported URL scheme: ' + parts.scheme);
		const head = await send(
			{
				method,
				scheme: parts.scheme,
				authority: parts.authority,
				path: parts.path,
				headers,
				body
			},
			signal
		);
		const location = head.headers.find((entry) => entry[0].toLowerCase() === 'location');

		if (!REDIRECTS.includes(head.status) || location === undefined || req.redirect === 'manual')
			return makeResponse(head, url, redirects > 0);
		// a redirect: its body is not wanted
		await head.body?.cancel();

		if (req.redirect === 'error') throw new TypeError('fetch: redirected, and redirect is error');

		if (++redirects > MAX_REDIRECTS) throw new TypeError('fetch: too many redirects');
		let next;

		try {
			next = new URL(location[1], url);
		} catch {
			throw new TypeError('fetch: a redirect to an invalid URL: ' + location[1]);
		}

		if (next.protocol !== 'http:' && next.protocol !== 'https:')
			throw new TypeError('fetch: a redirect to an unsupported URL scheme: ' + next.protocol);

		if (
			(head.status === 303 && method !== 'GET' && method !== 'HEAD') ||
			((head.status === 301 || head.status === 302) && method === 'POST')
		) {
			method = 'GET';
			body = null;
			headers = withoutHeaders(headers, BODY_HEADERS);
		} else if (body instanceof ReadableStream)
			// a streamed body is gone once sent: it cannot be sent again
			throw new TypeError('fetch: cannot follow a redirect with a streamed request body');

		if (next.origin !== new URL(url).origin) headers = withoutHeaders(headers, CREDENTIAL_HEADERS);
		url = next.href;
	}
}
