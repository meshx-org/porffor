// structuredClone (HTML: StructuredSerializeInternal and StructuredDeserialize, done in one
// pass): a deep copy that keeps cycles and shared references, copies Dates, RegExps,
// ArrayBuffers and their views, Maps, Sets, Errors and primitive wrappers as themselves,
// and every other object as a plain object of its own enumerable properties. Functions,
// symbols, WeakMaps, WeakSets, WeakRefs and Promises cannot be cloned: DataCloneError.
//
// Not here: the web platform's own serializable objects (Blob, File, ImageData) and its
// non-serializable ones (URL, Headers, streams are copied as plain objects rather than
// refused); resizable ArrayBuffers' maxByteLength.

import { DOMException } from './dom-exception.mjs';

const ERROR_NAMES = [
	'Error',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError'
];

/** The DOMException for a value that cannot be cloned. */
function uncloneable(what) {
	return new DOMException(`${what} could not be cloned`, 'DataCloneError');
}

/** A new Error of the same kind (one of the standard ones), with the message and cause. */
function cloneError(value, memory) {
	const name = ERROR_NAMES.includes(value.name) ? value.name : 'Error';
	const message = value.message === undefined ? undefined : String(value.message);
	const out =
		name === 'EvalError'
			? new EvalError(message)
			: name === 'RangeError'
				? new RangeError(message)
				: name === 'ReferenceError'
					? new ReferenceError(message)
					: name === 'SyntaxError'
						? new SyntaxError(message)
						: name === 'TypeError'
							? new TypeError(message)
							: name === 'URIError'
								? new URIError(message)
								: new Error(message);

	memory.set(value, out);

	if (value.cause !== undefined) out.cause = cloneValue(value.cause, memory);

	return out;
}

/** An ArrayBuffer view over the clone of its buffer (views sharing a buffer still do). */
function cloneView(value, memory) {
	const buffer = cloneValue(value.buffer, memory);
	const out =
		value instanceof DataView
			? new DataView(buffer, value.byteOffset, value.byteLength)
			: new value.constructor(buffer, value.byteOffset, value.length);

	memory.set(value, out);

	return out;
}

/** The own enumerable properties of `value`, cloned onto `out`. */
function copyProperties(value, out, memory) {
	for (const key of Object.keys(value)) out[key] = cloneValue(value[key], memory);

	return out;
}

/** A clone of an object that is none of the built-in kinds with their own copy. */
function cloneObject(value, memory) {
	if (
		value instanceof WeakMap ||
		value instanceof WeakSet ||
		value instanceof Promise ||
		(typeof WeakRef === 'function' && value instanceof WeakRef)
	)
		throw uncloneable('An object');

	if (Array.isArray(value)) {
		const out = new Array(value.length);

		memory.set(value, out);

		return copyProperties(value, out, memory);
	}
	const out = {};

	memory.set(value, out);

	return copyProperties(value, out, memory);
}

/** A clone of `value`, the objects already cloned in `memory` reused. */
function cloneValue(value, memory) {
	const type = typeof value;

	if (type === 'symbol') throw uncloneable('A symbol');

	if (type === 'function') throw uncloneable('A function');

	if (value === null || type !== 'object') return value;
	const seen = memory.get(value);

	if (seen !== undefined) return seen;
	let out;

	if (value instanceof Boolean) out = new Boolean(value.valueOf());
	else if (value instanceof Number) out = new Number(value.valueOf());
	else if (value instanceof String) out = new String(value.valueOf());
	else if (value instanceof Date) out = new Date(value.getTime());
	// lastIndex is not kept
	else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
	else if (value instanceof ArrayBuffer) out = value.slice(0);
	else if (ArrayBuffer.isView(value)) return cloneView(value, memory);
	else if (value instanceof Error) return cloneError(value, memory);
	else if (value instanceof Map) {
		out = new Map();
		memory.set(value, out);

		for (const [key, entry] of value) out.set(cloneValue(key, memory), cloneValue(entry, memory));

		return out;
	} else if (value instanceof Set) {
		out = new Set();
		memory.set(value, out);

		for (const entry of value) out.add(cloneValue(entry, memory));

		return out;
	} else return cloneObject(value, memory);

	memory.set(value, out);

	return out;
}

/**
 * The transfer list: ArrayBuffers, each moved rather than copied. The clone gets its
 * contents now; the original is emptied after the clone (views into it are read first),
 * where ArrayBuffer.prototype.transfer can do that.
 */
function transferList(transfer, memory) {
	const buffers = [];

	if (transfer === undefined) return buffers;

	for (const buffer of transfer) {
		if (!(buffer instanceof ArrayBuffer)) throw uncloneable('A value in the transfer list');

		if (memory.has(buffer))
			throw new DOMException(
				'An ArrayBuffer is listed twice in the transfer list',
				'DataCloneError'
			);
		memory.set(buffer, buffer.slice(0));
		buffers.push(buffer);
	}

	return buffers;
}

/**
 * A deep copy of `value`, as `postMessage` would deliver it.
 * @template T
 * @param {T} value
 * @param {{ transfer?: ArrayBuffer[] }} [options]
 * @returns {T}
 */
export function structuredClone(value, options) {
	const memory = new Map();
	const transferred = transferList(options?.transfer, memory);
	const out = cloneValue(value, memory);

	for (const buffer of transferred) if (typeof buffer.transfer === 'function') buffer.transfer();

	return out;
}
