// Request (https://fetch.spec.whatwg.org/#request-class): an absolute URL, a method
// (the standard ones uppercased), headers, a body (none for GET and HEAD) read once
// (./body.mjs), and a signal; made from a URL string or another Request plus init.
// fetch() takes one; a server's fetch handler is given one.
//
// Injected into every guest (tree-shaken away unless used).

import { baseUrl } from './base-url.mjs';
import { AbortSignal } from './abort-signal.mjs';
import { Blob } from './blob.mjs';
import {
	bodyUnusable,
	bodyUsed,
	cloneBody,
	consumeBody,
	consumeFormData,
	consumeTextStream,
	extractBody,
	keptBody,
	KnownBody,
	listHas
} from './body.mjs';
import { Headers } from './headers.mjs';
import { ReadableStream } from './readable-stream.mjs';
import { blobUrlStore, URL } from './url.mjs';
import { defineInterface } from './webidl.mjs';

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

// the RequestInit enums (WebIDL: another value is a TypeError)
const REFERRER_POLICIES = [
	'',
	'no-referrer',
	'no-referrer-when-downgrade',
	'same-origin',
	'origin',
	'strict-origin',
	'origin-when-cross-origin',
	'strict-origin-when-cross-origin',
	'unsafe-url'
];
const MODES = ['same-origin', 'no-cors', 'cors', 'navigate'];
const CREDENTIALS = ['omit', 'same-origin', 'include'];
const CACHES = ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'];
const REDIRECTS = ['follow', 'error', 'manual'];
const PRIORITIES = ['high', 'low', 'auto'];
const DUPLEXES = ['half'];
// the methods a no-cors request may have (CORS-safelisted)
const SIMPLE_METHODS = ['GET', 'HEAD', 'POST'];

/** An init member of an enum type: the value as a string, a TypeError when not one of them. */
function enumMember(options, key, values, fallback) {
	const value = options[key];

	if (value === undefined) return fallback;
	const text = `${value}`;

	if (!values.includes(text))
		throw new TypeError(`Request: '${text}' is not a valid value for ${key}`);

	return text;
}

/**
 * A request's referrer from init.referrer: 'no-referrer' for '', 'client' for about:client or
 * another origin's URL, else the URL; a TypeError when it does not parse.
 */
function parseReferrer(value) {
	const text = `${value}`;

	if (text === '') return 'no-referrer';
	const base = baseUrl();
	let parsed;

	try {
		parsed = new URL(text, base);
	} catch {
		throw new TypeError(`Request: invalid referrer: ${text}`);
	}

	if (parsed.href === 'about:client') return 'client';

	if (base !== undefined && parsed.origin !== new URL(base).origin) return 'client';

	return parsed.href;
}

/**
 * A stream that reads `stream` (which becomes used): a body moved to a new Request, the old
 * one keeping its stream object, disturbed.
 */
function proxyStream(stream) {
	const reader = stream.getReader();

	stream._disturbed = true;

	return new ReadableStream({
		pull(controller) {
			return reader.read().then(({ value, done }) => {
				if (done) controller.close();
				else controller.enqueue(value);
			});
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/** An HTTP request. */
// a request made here is never a reload or a history navigation (a getter, as WebIDL has it)
const NOT_NAVIGATION = false;

export class Request {
	/**
	 * @param {string | URL | Request} input
	 * @param {{ method?: string, headers?: object, body?: any, signal?: AbortSignal,
	 *   redirect?: string, credentials?: string, mode?: string, cache?: string,
	 *   referrer?: string, referrerPolicy?: string, integrity?: string, keepalive?: boolean,
	 *   priority?: string, duplex?: string }} [init]
	 */
	constructor(input, init = undefined) {
		const options = init ?? {};
		const source = input instanceof Request ? input : null;
		// everything is checked before the source's body moves: a failure leaves it unused

		if (source === null) {
			let parsed;

			try {
				parsed = new URL(`${input}`, baseUrl());
			} catch {
				throw new TypeError(`Request: invalid URL: ${input}`);
			}

			if (parsed.username !== '' || parsed.password !== '')
				throw new TypeError(`Request: a URL with credentials: ${parsed.href}`);
			this._url = parsed.href;
			// a blob: URL is resolved now: revoking it later does not take the blob away
			const { resolve } = blobUrlStore();

			this._blob = parsed.protocol === 'blob:' && resolve !== null ? resolve(parsed.href) : null;
		} else {
			this._url = source.url;
			this._blob = source._blob;
		}

		// a request has no window to belong to here: only null is accepted
		if (options.window !== undefined && options.window !== null)
			throw new TypeError('Request: window can only be null');
		this._referrer =
			options.referrer === undefined
				? (source?._referrer ?? 'client')
				: parseReferrer(options.referrer);
		this._referrerPolicy = enumMember(
			options,
			'referrerPolicy',
			REFERRER_POLICIES,
			source?.referrerPolicy ?? ''
		);
		this._mode = enumMember(options, 'mode', MODES, source?.mode ?? 'cors');

		if (this._mode === 'navigate')
			throw new TypeError("Request: a request's mode cannot be 'navigate'");
		this._credentials = enumMember(
			options,
			'credentials',
			CREDENTIALS,
			source?.credentials ?? 'same-origin'
		);
		this._cache = enumMember(options, 'cache', CACHES, source?.cache ?? 'default');

		if (this._cache === 'only-if-cached' && this._mode !== 'same-origin')
			throw new TypeError("Request: cache 'only-if-cached' needs mode 'same-origin'");
		this._redirect = enumMember(options, 'redirect', REDIRECTS, source?.redirect ?? 'follow');
		this._integrity =
			options.integrity === undefined ? (source?.integrity ?? '') : `${options.integrity}`;
		this._keepalive =
			options.keepalive === undefined ? (source?.keepalive ?? false) : Boolean(options.keepalive);
		this._priority = enumMember(options, 'priority', PRIORITIES, source?._priority ?? 'auto');
		this._duplex = enumMember(options, 'duplex', DUPLEXES, 'half');
		this._method =
			options.method === undefined
				? source === null
					? 'GET'
					: source.method
				: normalizeMethod(options.method);
		// a signal of its own, following the given one (init's, else the source request's)
		const followed = options.signal === undefined ? source?.signal : options.signal;

		if (followed !== undefined && followed !== null && !(followed instanceof AbortSignal))
			throw new TypeError("Request: signal is not of type 'AbortSignal'");
		this._signal = AbortSignal.any(followed === undefined || followed === null ? [] : [followed]);
		this._destination = '';

		if (this._mode === 'no-cors' && !SIMPLE_METHODS.includes(this._method))
			throw new TypeError(`Request: a no-cors request cannot be a ${this._method}`);
		this._headers = new Headers(options.headers === undefined ? source?.headers : options.headers);
		const sourceBody = source === null ? null : source._body;
		const hasInitBody = options.body !== undefined && options.body !== null;

		if ((hasInitBody || sourceBody !== null) && (this._method === 'GET' || this._method === 'HEAD'))
			throw new TypeError('Request: a GET or HEAD request cannot have a body');
		this._body = null;

		if (hasInitBody) {
			const bodyIsStream = options.body instanceof ReadableStream;

			if (this._keepalive && bodyIsStream)
				throw new TypeError('Request: a keepalive request cannot have a stream body');

			if (bodyIsStream && options.duplex === undefined)
				throw new TypeError("Request: a stream body needs duplex: 'half'");
			const extracted = extractBody(options.body);

			this._body = keptBody(extracted);

			// (the type is a valid value: added without Headers' checks)
			if (extracted.type !== null && !listHas(this._headers._list, 'content-type'))
				this._headers._list.push(['content-type', extracted.type]);
		}

		// the source's body moves here (or is dropped for init's): the source is used after
		if (sourceBody !== null && this._body === null) {
			if (bodyUnusable(source))
				throw new TypeError('Request: the source body has already been read');
			this._body = { stream: proxyStream(sourceBody.stream) };
		} else if (sourceBody !== null) sourceBody.stream._disturbed = true;
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
		// (a server's request makes its signal once it is asked for: incomingRequest)
		if (this._signal === null) this._signal = new AbortSignal();

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

	/** '' for no referrer, about:client for the client, else the referrer's URL. */
	get referrer() {
		if (this._referrer === 'no-referrer') return '';

		return this._referrer === 'client' ? 'about:client' : this._referrer;
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

	/** The body as a stream of the strings its UTF-8 decodes to. */
	textStream() {
		return consumeTextStream(this);
	}

	/** The body as a FormData (multipart/form-data or application/x-www-form-urlencoded). */
	async formData() {
		return consumeFormData(this);
	}

	/** A copy, with the body split between the two. */
	clone() {
		if (bodyUnusable(this)) throw new TypeError('Request: the body has already been read');
		const copy = new Request(this.url, {
			method: this.method,
			headers: this.headers,
			signal: this.signal,
			redirect: this.redirect,
			credentials: this.credentials,
			mode: this.mode,
			cache: this.cache,
			referrerPolicy: this.referrerPolicy,
			integrity: this.integrity,
			keepalive: this.keepalive,
			priority: this._priority
		});

		copy._referrer = this._referrer;
		copy._blob = this._blob;
		copy._body = cloneBody(this);

		return copy;
	}
}

/**
 * A request a server received (runtime/serve.mjs): made as the constructor would make it from
 * `new Request(url, { method, headers, body, signal })`, without the checks a request a program
 * makes needs. The URL is already absolute and parsed, the headers already valid (the server's
 * HTTP parser, or the host's, checked them), and the method is taken as it came: a server is
 * given CONNECT and TRACE, which the constructor refuses to make.
 * @param {string} url
 * @param {string} method
 * @param {Headers} headers
 * @param {ReadableStream | KnownBody | null} body a KnownBody when all of it had come already
 * @param {AbortSignal | null} signal null: made when first asked for (most handlers never do)
 */
export function incomingRequest(url, method, headers, body, signal) {
	// (a literal: made with its shape at once, twice as fast as setting each on Object.create's)
	return {
		__proto__: Request.prototype,
		_url: url,
		_blob: null,
		_referrer: 'client',
		_referrerPolicy: '',
		_mode: 'cors',
		_credentials: 'same-origin',
		_cache: 'default',
		_redirect: 'follow',
		_integrity: '',
		_keepalive: false,
		_priority: 'auto',
		_duplex: 'half',
		_method: method,
		_signal: signal,
		_destination: '',
		_headers: headers,
		_body: body === null || body instanceof KnownBody ? body : { stream: body }
	};
}

defineInterface(Request, 'Request', {
	promises: ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']
});
