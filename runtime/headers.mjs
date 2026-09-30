// Headers (https://fetch.spec.whatwg.org/#headers-class): names are case-insensitive
// tokens, values are byte strings trimmed of surrounding whitespace that may not hold NUL, CR
// or LF. get() joins the values of one name with ", "; iteration is sorted by name with the
// values of a name combined, except set-cookie, whose values stay separate (getSetCookie()
// has them all), and it follows changes made while iterating, as the spec's iterator does.
//
// A Headers can be immutable (a Response.error()'s, a redirect's, a fetched response's): it
// then refuses append, set and delete. The browser-only guards (forbidden request and response
// header names, no-cors) are left out, as server runtimes leave them out: a server sets Cookie
// and reads Set-Cookie.
//
// Injected into every guest (tree-shaken away unless used).

import { defineInterface, initPairs, isObject, pairIterator } from './webidl.mjs';

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// (see blob.mjs's TAG)
const TAG = 'Headers';

/** A ByteString: every code unit below 256, else a TypeError. */
function byteString(value) {
	const text = `${value}`;

	if (/[^\0-ÿ]/.test(text)) throw new TypeError(`Headers: not a byte string: ${text}`);

	return text;
}

/** A validated, lowercased header name. */
function headerName(name) {
	const text = byteString(name);

	if (!TOKEN.test(text)) throw new TypeError(`Headers: invalid header name: ${text}`);

	return text.toLowerCase();
}

/** A header value, trimmed of HTTP whitespace, checked for NUL, CR and LF. */
function headerValue(value) {
	const text = byteString(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');

	if (/[\0\r\n]/.test(text)) throw new TypeError('Headers: invalid header value');

	return text;
}

/** A Headers' pairs as iteration shows them (see _sorted). */
const sortedPairs = (headers) => headers._sorted();

/** A header list: name-value pairs, names lowercased. */
export class Headers {
	/** @param {Headers | Iterable<[string, string]> | Record<string, string>} [init] */
	constructor(init = undefined) {
		this._list = [];
		this._guard = 'none';

		if (init === undefined) return;

		if (!isObject(init))
			throw new TypeError('Headers: init must be a sequence of pairs or a record');
		const pairs = initPairs(init, 'Headers', byteString);

		for (const [name, value] of pairs) this.append(name, value);
	}

	/** Throws when it may not change (an immutable response's headers). */
	_checkMutable() {
		if (this._guard === 'immutable') throw new TypeError('Headers: these headers are immutable');
	}

	append(name, value) {
		const pair = [headerName(name), headerValue(value)];

		this._checkMutable();
		this._list.push(pair);
	}

	/** Replaces every value of the name with one. */
	set(name, value) {
		const key = headerName(name);
		const text = headerValue(value);

		this._checkMutable();
		const at = this._list.findIndex((pair) => pair[0] === key);

		if (at === -1) this._list.push([key, text]);
		else {
			this._list[at][1] = text;
			this._list = this._list.filter((pair, index) => index <= at || pair[0] !== key);
		}
	}

	delete(name) {
		const key = headerName(name);

		this._checkMutable();
		this._list = this._list.filter((pair) => pair[0] !== key);
	}

	/** The values of the name joined with ", ", or null. */
	get(name) {
		const key = headerName(name);
		const values = this._list.filter((pair) => pair[0] === key).map((pair) => pair[1]);

		return values.length === 0 ? null : values.join(', ');
	}

	has(name) {
		const key = headerName(name);

		return this._list.some((pair) => pair[0] === key);
	}

	/** Every set-cookie value, separately. */
	getSetCookie() {
		return this._list.filter((pair) => pair[0] === 'set-cookie').map((pair) => pair[1]);
	}

	/**
	 * The pairs iteration shows (https://fetch.spec.whatwg.org/#concept-header-list-sort-and-combine):
	 * sorted by name, values combined, set-cookie's kept apart.
	 */
	_sorted() {
		const names = [...new Set(this._list.map((pair) => pair[0]))].sort();
		const out = [];

		for (const name of names) {
			if (name === 'set-cookie') for (const value of this.getSetCookie()) out.push([name, value]);
			else out.push([name, this.get(name)]);
		}

		return out;
	}

	entries() {
		return pairIterator('Headers', this, 'pair', sortedPairs);
	}

	keys() {
		return pairIterator('Headers', this, 'key', sortedPairs);
	}

	values() {
		return pairIterator('Headers', this, 'value', sortedPairs);
	}

	forEach(callback, thisArg = undefined) {
		if (typeof callback !== 'function')
			throw new TypeError('Headers.forEach: callback is not a function');

		for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this);
	}

	[Symbol.iterator]() {
		return this.entries();
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

defineInterface(Headers, 'Headers', { iterable: true });
