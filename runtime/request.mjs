// Request (https://fetch.spec.whatwg.org/#request-class): an absolute URL, a method
// (the standard ones uppercased), headers, a body (none for GET and HEAD) read once
// (./body.mjs), and a signal; made from a URL string or another Request plus init.
// fetch() takes one; a server's fetch handler is given one.
//
// Injected into every guest (tree-shaken away unless used).

import { baseUrl } from './base-url.mjs';
import { AbortSignal } from './abort-signal.mjs';
import { Blob } from './blob.mjs';
import { bodyUnusable, bodyUsed, cloneBody, consumeBody, extractBody } from './body.mjs';
import { Headers } from './headers.mjs';
import { ReadableStream } from './readable-stream.mjs';
import { URL } from './url.mjs';

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NORMALIZED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
const FORBIDDEN = ['CONNECT', 'TRACE', 'TRACK'];

/** A method: a token, the standard ones uppercased, CONNECT / TRACE / TRACK refused. */
function normalizeMethod(method) {
	const text = String(method);

	if (!TOKEN.test(text)) throw new TypeError(`Request: invalid method: ${text}`);
	const upper = text.toUpperCase();

	if (FORBIDDEN.includes(upper)) throw new TypeError(`Request: forbidden method: ${text}`);

	return NORMALIZED.includes(upper) ? upper : text;
}

/** An HTTP request. */
// a request made here is never a reload or a history navigation (a getter, as WebIDL has it)
const NOT_NAVIGATION = false;

export class Request {
	/**
	 * @param {string | URL | Request} input
	 * @param {{ method?: string, headers?: object, body?: any, signal?: AbortSignal,
	 *   redirect?: string, credentials?: string, mode?: string, cache?: string }} [init]
	 */
	constructor(input, init) {
		const options = init ?? {};
		const source = input instanceof Request ? input : null;

		// a request has no window to belong to here: only null is accepted
		if (options.window !== undefined && options.window !== null)
			throw new TypeError('Request: window can only be null');

		this._url = source === null ? new URL(String(input), baseUrl()).href : source.url;
		this._method =
			options.method === undefined
				? source === null
					? 'GET'
					: source.method
				: normalizeMethod(options.method);
		this._headers = new Headers(options.headers === undefined ? source?.headers : options.headers);
		this._signal = options.signal ?? source?.signal ?? new AbortSignal();
		this._redirect = options.redirect ?? source?.redirect ?? 'follow';
		this._credentials = options.credentials ?? source?.credentials ?? 'same-origin';
		this._mode = options.mode ?? source?.mode ?? 'cors';
		this._cache = options.cache ?? source?.cache ?? 'default';
		this._referrer = 'about:client';
		this._integrity = '';
		this._keepalive = false;
		this._duplex = 'half';
		this._destination = '';
		this._referrerPolicy = '';
		this._body = null;

		if (options.body !== undefined && options.body !== null) {
			if (this.method === 'GET' || this.method === 'HEAD')
				throw new TypeError('Request: a GET or HEAD request cannot have a body');
			const extracted = extractBody(options.body);

			this._body = { stream: extracted.stream };

			if (extracted.type !== null && !this.headers.has('content-type'))
				this.headers.set('content-type', extracted.type);
		} else if (source !== null && source._body !== null) {
			// the source's body moves here: the source cannot be read after
			if (bodyUnusable(source))
				throw new TypeError('Request: the source body has already been read');
			this._body = source._body;
			source._body = { stream: new ReadableStream({ start: (controller) => controller.close() }) };
			source._body.stream._disturbed = true;
		}
	}

	// the request's attributes, read-only (WebIDL attributes are prototype getters)
	get url() {
		return this._url;
	}

	get method() {
		return this._method;
	}

	get headers() {
		return this._headers;
	}

	get signal() {
		return this._signal;
	}

	get redirect() {
		return this._redirect;
	}

	get credentials() {
		return this._credentials;
	}

	get mode() {
		return this._mode;
	}

	get cache() {
		return this._cache;
	}

	get referrer() {
		return this._referrer;
	}

	get integrity() {
		return this._integrity;
	}

	get keepalive() {
		return this._keepalive;
	}

	get duplex() {
		return this._duplex;
	}

	get destination() {
		return this._destination;
	}

	get referrerPolicy() {
		return this._referrerPolicy;
	}

	get isReloadNavigation() {
		return NOT_NAVIGATION;
	}

	get isHistoryNavigation() {
		return NOT_NAVIGATION;
	}

	/** The body as a ReadableStream of Uint8Arrays, or null. */
	get body() {
		return this._body === null ? null : this._body.stream;
	}

	get bodyUsed() {
		return bodyUsed(this);
	}

	async bytes() {
		return consumeBody(this);
	}

	async arrayBuffer() {
		return (await consumeBody(this)).buffer;
	}

	async text() {
		return new TextDecoder().decode(await consumeBody(this));
	}

	/** The body as a Blob, typed by the content-type header. */
	async blob() {
		return new Blob([await consumeBody(this)], { type: this.headers.get('content-type') ?? '' });
	}

	async json() {
		return JSON.parse(await this.text());
	}

	/** A copy, with the body split between the two. */
	clone() {
		const copy = new Request(this.url, {
			method: this.method,
			headers: this.headers,
			signal: this.signal,
			redirect: this.redirect,
			credentials: this.credentials,
			mode: this.mode,
			cache: this.cache
		});

		copy._body = cloneBody(this);

		return copy;
	}
}
