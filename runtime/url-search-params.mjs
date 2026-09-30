// URLSearchParams for a Porffor-compiled guest (https://url.spec.whatwg.org/#interface-urlsearchparams):
// a list of name-value pairs, parsed from and serialized to
// application/x-www-form-urlencoded. One that belongs to a URL (url.searchParams) writes
// every change back to that URL's query. Iteration follows the list as it changes, as the
// spec's iterator does.
//
// Injected into every guest (tree-shaken away unless used), like ./url.mjs.

import { parseForm, serializeForm, toUSVString } from './url-encoding.mjs';
import { defineInterface, initPairs, isObject, pairIterator } from './webidl.mjs';

/** A URLSearchParams' pairs, as they are now. */
const listPairs = (params) => params._list;

/** A query string's name-value pairs, as URLs and forms carry them. */
export class URLSearchParams {
	/**
	 * @param {string | [string, string][] | Record<string, string> | URLSearchParams} [init]
	 *   a query string (a leading ? is dropped), pairs, or a record of names to values
	 */
	constructor(init = undefined) {
		this._list = [];
		this._url = null; // the URL record this belongs to, if any

		if (init === undefined || init === null) return;

		if (isObject(init)) {
			const sequence = init[Symbol.iterator] !== undefined && init[Symbol.iterator] !== null;

			for (const pair of initPairs(init, 'URLSearchParams', toUSVString)) {
				// a record's key met twice once converted (lone surrogates) keeps its first place
				const at = sequence ? -1 : this._list.findIndex((entry) => entry[0] === pair[0]);

				if (at === -1) this._list.push(pair);
				else this._list[at][1] = pair[1];
			}

			return;
		}
		const text = toUSVString(init);

		this._list = parseForm(text.startsWith('?') ? text.slice(1) : text);
	}

	/** How many pairs there are. */
	get size() {
		return this._list.length;
	}

	/** Writes the list back to the URL this belongs to. */
	_update() {
		if (this._url === null) return;
		const query = serializeForm(this._list);

		this._url.query = query === '' ? null : query;
	}

	/** Adds a pair at the end. */
	append(name, value) {
		this._list.push([toUSVString(name), toUSVString(value)]);
		this._update();
	}

	/** Removes every pair with the name (and, given one, the value). */
	delete(name, value = undefined) {
		const key = toUSVString(name);
		const only = value === undefined ? undefined : toUSVString(value);

		this._list = this._list.filter(
			(pair) => pair[0] !== key || (only !== undefined && pair[1] !== only)
		);
		this._update();
	}

	/** The first value with the name, or null. */
	get(name) {
		const key = toUSVString(name);
		const found = this._list.find((pair) => pair[0] === key);

		return found === undefined ? null : found[1];
	}

	/** Every value with the name. */
	getAll(name) {
		const key = toUSVString(name);

		return this._list.filter((pair) => pair[0] === key).map((pair) => pair[1]);
	}

	/** Whether a pair has the name (and, given one, the value). */
	has(name, value = undefined) {
		const key = toUSVString(name);
		const only = value === undefined ? undefined : toUSVString(value);

		return this._list.some((pair) => pair[0] === key && (only === undefined || pair[1] === only));
	}

	/** Sets the first pair with the name to the value and removes the others (or appends). */
	set(name, value) {
		const key = toUSVString(name);
		const text = toUSVString(value);
		const at = this._list.findIndex((pair) => pair[0] === key);

		if (at === -1) this._list.push([key, text]);
		else {
			this._list[at][1] = text;
			this._list = this._list.filter((pair, index) => index <= at || pair[0] !== key);
		}
		this._update();
	}

	/** Sorts the pairs by name (by UTF-16 code units), keeping equal names in order. */
	sort() {
		const indexed = this._list.map((pair, index) => ({ pair, index }));

		indexed.sort((left, right) => {
			if (left.pair[0] < right.pair[0]) return -1;

			if (left.pair[0] > right.pair[0]) return 1;

			return left.index - right.index;
		});
		this._list = indexed.map((entry) => entry.pair);
		this._update();
	}

	/** Calls callback(value, name, this) for each pair. */
	forEach(callback, thisArg = undefined) {
		if (typeof callback !== 'function')
			throw new TypeError('URLSearchParams.forEach: callback is not a function');

		for (let index = 0; index < this._list.length; index++) {
			const [name, value] = this._list[index];

			callback.call(thisArg, value, name, this);
		}
	}

	/** The names, in order. */
	keys() {
		return pairIterator('URLSearchParams', this, 'key', listPairs);
	}

	/** The values, in order. */
	values() {
		return pairIterator('URLSearchParams', this, 'value', listPairs);
	}

	/** The [name, value] pairs, in order. */
	entries() {
		return pairIterator('URLSearchParams', this, 'pair', listPairs);
	}

	[Symbol.iterator]() {
		return this.entries();
	}

	/** The pairs as application/x-www-form-urlencoded. */
	toString() {
		return serializeForm(this._list);
	}
}

defineInterface(URLSearchParams, 'URLSearchParams', { iterable: true });
