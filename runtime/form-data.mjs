// FormData (https://xhr.spec.whatwg.org/#interface-formdata): an ordered list of entries,
// each a name and a value that is a string or a File. A component has no forms, so the
// constructor takes none.
//
// keys(), values() and entries() return arrays, as URLSearchParams' do: Porffor's for...of
// takes arrays but not the iterator protocol.
//
// Injected into every guest (tree-shaken away unless used).

import { Blob, File } from './file.mjs';
import { toUSVString } from './url-encoding.mjs';

// (see blob.mjs's TAG)
const TAG = 'FormData';

/**
 * An entry as the spec creates it: the name and a string value as USV strings, a Blob as a
 * File (named "blob" unless it is a File or a filename is given).
 * @param {string} method
 * @param {unknown[]} args
 * @returns {[string, string | File]}
 */
function createEntry(method, args) {
	const [name, value, filename] = args;

	if (args.length < 2)
		throw new TypeError(
			`Failed to execute '${method}' on 'FormData': 2 arguments required, but only ${args.length} present.`
		);

	if (!(value instanceof Blob)) {
		if (args.length > 2)
			throw new TypeError(
				`Failed to execute '${method}' on 'FormData': parameter 2 is not of type 'Blob'.`
			);

		return [toUSVString(name), toUSVString(value)];
	}

	if (value instanceof File && filename === undefined) return [toUSVString(name), value];

	const options = { type: value.type };
	let fileName = 'blob';

	if (value instanceof File) {
		fileName = value.name;
		options.lastModified = value.lastModified;
	}

	if (filename !== undefined) fileName = toUSVString(filename);

	return [toUSVString(name), new File([value], fileName, options)];
}

/** Name-value entries, the values strings or Files, in the order they were added. */
export class FormData {
	/** @param {undefined} [form] */
	constructor(form = undefined, submitter = undefined) {
		if (form !== undefined || submitter !== undefined)
			throw new TypeError(
				"Failed to construct 'FormData': there are no forms here, so the form must be undefined."
			);

		/** @type {[string, string | File][]} */
		this._list = [];
	}

	/**
	 * Adds an entry after the others: (name, value) or (name, blob, filename?).
	 * @param {...unknown} args
	 */
	append(...args) {
		this._list.push(createEntry('append', args));
	}

	/**
	 * Replaces the first entry named `name` and removes the rest, or adds one if there is
	 * none: (name, value) or (name, blob, filename?).
	 * @param {...unknown} args
	 */
	set(...args) {
		const entry = createEntry('set', args);
		const index = this._list.findIndex((pair) => pair[0] === entry[0]);

		if (index === -1) {
			this._list.push(entry);

			return;
		}

		this._list = this._list.filter((pair, at) => at <= index || pair[0] !== entry[0]);
		this._list[index] = entry;
	}

	/** Removes every entry named `name`. */
	delete(name) {
		const key = toUSVString(name);

		this._list = this._list.filter((pair) => pair[0] !== key);
	}

	/** The first value named `name`, or null. */
	get(name) {
		const key = toUSVString(name);
		const found = this._list.find((pair) => pair[0] === key);

		return found === undefined ? null : found[1];
	}

	/** Every value named `name`, in order. */
	getAll(name) {
		const key = toUSVString(name);

		return this._list.filter((pair) => pair[0] === key).map((pair) => pair[1]);
	}

	/** Whether an entry is named `name`. */
	has(name) {
		const key = toUSVString(name);

		return this._list.some((pair) => pair[0] === key);
	}

	/** Calls callback(value, name, this) for each entry. */
	forEach(callback, thisArg) {
		if (typeof callback !== 'function')
			throw new TypeError("Failed to execute 'forEach' on 'FormData': callback is not a function");

		for (const [name, value] of this._list) callback.call(thisArg, value, name, this);
	}

	/** The names, in order. */
	keys() {
		return this._list.map((pair) => pair[0]);
	}

	/** The values, in order. */
	values() {
		return this._list.map((pair) => pair[1]);
	}

	/** The [name, value] pairs, in order. */
	entries() {
		return this._list.map((pair) => [pair[0], pair[1]]);
	}

	[Symbol.iterator]() {
		return this.entries()[Symbol.iterator]();
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}
