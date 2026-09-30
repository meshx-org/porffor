// Response (https://fetch.spec.whatwg.org/#response-class): constructed from a body
// (string, bytes, URLSearchParams, a ReadableStream, or none) with status, statusText and
// headers; Response.json / redirect / error; the body read once (./body.mjs), or cloned.
// fetch() makes its responses over the platform's (./fetch.mjs, porffor:http).
//
// Injected into every guest (tree-shaken away unless used).

import { baseUrl } from './base-url.mjs';
import { Blob } from './blob.mjs';
import {
	bodyUsed,
	cloneBody,
	consumeBody,
	consumeFormData,
	consumeTextStream,
	extractBody,
	keptBody,
	listHas
} from './body.mjs';
import { Headers } from './headers.mjs';
import { URL } from './url.mjs';
import { defineInterface } from './webidl.mjs';

/** Statuses a response may not have a body with. */
const NULL_BODY = [101, 103, 204, 205, 304];
const REDIRECTS = [301, 302, 303, 307, 308];

/** An HTTP response: status, headers, and a body read once. */
export class Response {
	/**
	 * @param {string | ArrayBuffer | ArrayBufferView | URLSearchParams | ReadableStream | null} [body]
	 * @param {{ status?: number, statusText?: string, headers?: object }} [init]
	 */
	constructor(body = null, init = undefined) {
		const options = init ?? {};
		const status = options.status === undefined ? 200 : Number(options.status);

		if (!(status >= 200 && status <= 599) || !Number.isInteger(status))
			throw new RangeError(`Response: status ${status} is outside 200 to 599`);
		this._status = status;
		this._statusText = options.statusText === undefined ? '' : `${options.statusText}`;

		// a reason-phrase: tabs, spaces and visible or obs-text bytes only
		if (this._statusText !== '' && /[^\t\x20-\x7e\x80-\xff]/.test(this._statusText))
			throw new TypeError(`Response: invalid statusText: ${this._statusText}`);
		this._headers = new Headers(options.headers);
		this._type = 'default';
		this._url = '';
		this._redirected = false;
		this._body = null;

		if (body !== undefined && body !== null) {
			if (NULL_BODY.includes(status))
				throw new TypeError(`Response: a ${status} response cannot have a body`);
			const extracted = extractBody(body);

			this._body = keptBody(extracted);

			// (the type is a valid value: added without Headers' checks)
			if (extracted.type !== null && !listHas(this._headers._list, 'content-type'))
				this._headers._list.push(['content-type', extracted.type]);
		}
	}

	/** A JSON response: the data serialized, content-type application/json. */
	static json(data, init = undefined) {
		const text = JSON.stringify(data);

		if (text === undefined) throw new TypeError('Response.json: the data cannot be serialized');
		const response = new Response(text, init);

		// the type the text implied, unless init gave one
		if (init?.headers === undefined || !new Headers(init.headers).has('content-type'))
			for (const pair of response._headers._list)
				if (pair[0] === 'content-type') pair[1] = 'application/json';

		return response;
	}

	/** A redirect to the URL (a 302 unless a redirect status is given). */
	static redirect(url, status = undefined) {
		const code = status === undefined ? 302 : Number(status);

		if (!REDIRECTS.includes(code))
			throw new RangeError(`Response.redirect: ${code} is not a redirect status`);
		const response = new Response(null, { status: code });

		response.headers.set('location', new URL(String(url), baseUrl()).href);
		response._headers._guard = 'immutable';

		return response;
	}

	/** A network error: status 0, type 'error'. */
	static error() {
		const response = new Response(null);

		response._status = 0;
		response._type = 'error';
		response._headers._guard = 'immutable';

		return response;
	}

	// the response's attributes, read-only (WebIDL attributes are prototype getters)
	get status() {
		return this._status;
	}

	get statusText() {
		return this._statusText;
	}

	get headers() {
		return this._headers;
	}

	get type() {
		return this._type;
	}

	get url() {
		return this._url;
	}

	get redirected() {
		return this._redirected;
	}

	get ok() {
		return this.status >= 200 && this.status <= 299;
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
		const copy = new Response(null, {
			status: this.status === 0 ? 200 : this.status,
			statusText: this.statusText,
			headers: this.headers
		});

		copy._status = this.status;
		copy._type = this.type;
		copy._url = this.url;
		copy._redirected = this.redirected;
		copy._headers._guard = this.headers._guard;
		copy._body = cloneBody(this);

		return copy;
	}
}

defineInterface(Response, 'Response', {
	promises: ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']
});
