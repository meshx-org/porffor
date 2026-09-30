// node:buffer: Buffer, Node's byte array, as a Uint8Array subclass: made from strings in Node's
// encodings (utf8, hex, base64, base64url, latin1/binary, ascii, utf16le/ucs2), arrays and
// ArrayBuffers; read back as strings; and read or written as integers and floats at an offset.
// Views of a Buffer (subarray, slice) are Buffers too, sharing its memory, as in Node.
//
// Plus what the module exports beside it: Blob and File (runtime/file.mjs), atob and btoa, the
// length limits. Not here: the pool Node allocates small buffers from (every Buffer has its own
// ArrayBuffer), transcode, and calling Buffer() without `new`.
import { Blob, File } from '../file.mjs';

export { Blob, File };

// the most bytes a Buffer holds (Node's, 2^53 - 1), and the longest string Node makes (2^29 - 24
// UTF-16 units)
export const kMaxLength = Number.MAX_SAFE_INTEGER;
export const kStringMaxLength = 2 ** 29 - 24;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
export let INSPECT_MAX_BYTES = 50;

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');

// ---- errors, as Node words them ----

const codeError = (Kind, code, message) => {
	const e = new Kind(message);
	e.code = code;
	return e;
};

const typeName = (value) => {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'object') return `an instance of ${value.constructor?.name ?? 'Object'}`;
	if (typeof value === 'string') return `type string ('${value}')`;
	return `type ${typeof value} (${String(value)})`;
};

const unknownEncoding = (encoding) =>
	codeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);

const outOfRange = (name, range, value) =>
	codeError(
		RangeError,
		'ERR_OUT_OF_RANGE',
		`The value of "${name}" is out of range. It must be ${range}. Received ${value}`
	);

const outOfBounds = () =>
	codeError(
		RangeError,
		'ERR_BUFFER_OUT_OF_BOUNDS',
		'Attempt to access memory outside buffer bounds'
	);

// ---- encodings ----

/** An encoding's canonical name, or undefined for one Node does not know. */
const normalizeEncoding = (encoding) => {
	if (encoding === undefined || encoding === null || encoding === '') return 'utf8';
	switch (String(encoding).toLowerCase()) {
		case 'utf8':
		case 'utf-8':
			return 'utf8';
		case 'hex':
			return 'hex';
		case 'base64':
			return 'base64';
		case 'base64url':
			return 'base64url';
		case 'latin1':
		case 'binary':
			return 'latin1';
		case 'ascii':
			return 'ascii';
		case 'ucs2':
		case 'ucs-2':
		case 'utf16le':
		case 'utf-16le':
			return 'utf16le';
		default:
			return undefined;
	}
};

const encodingOrThrow = (encoding) => {
	const name = normalizeEncoding(encoding);
	if (name === undefined) throw unknownEncoding(encoding);
	return name;
};

const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// a base64 (or base64url) character's value, -1 for anything else: Node reads both alphabets
const base64Value = (c) => {
	if (c >= 65 && c <= 90) return c - 65;
	if (c >= 97 && c <= 122) return c - 71;
	if (c >= 48 && c <= 57) return c + 4;
	if (c === 43 || c === 45) return 62;
	if (c === 47 || c === 95) return 63;
	return -1;
};

const hexValue = (c) => {
	if (c >= 48 && c <= 57) return c - 48;
	if (c >= 97 && c <= 102) return c - 87;
	if (c >= 65 && c <= 70) return c - 55;
	return -1;
};

/** A string's bytes in an encoding, as a plain Uint8Array. */
const encodeString = (string, encoding) => {
	switch (encoding) {
		case 'utf8':
			return new TextEncoder().encode(string);
		case 'hex': {
			// pairs of hex digits, up to the first that is not one (as Node stops)
			const n = string.length >>> 1;
			const out = new Uint8Array(n);
			let i = 0;
			for (; i < n; i++) {
				const hi = hexValue(string.charCodeAt(i * 2));
				const lo = hexValue(string.charCodeAt(i * 2 + 1));
				if (hi < 0 || lo < 0) break;
				out[i] = (hi << 4) | lo;
			}
			return i === n ? out : out.subarray(0, i);
		}
		case 'base64':
		case 'base64url': {
			// characters of either alphabet; whitespace, padding and anything else skipped
			const out = new Uint8Array(Math.ceil((string.length * 3) / 4));
			let bits = 0;
			let count = 0;
			let at = 0;
			for (let i = 0; i < string.length; i++) {
				const c = string.charCodeAt(i);
				if (c === 61) break;
				const v = base64Value(c);
				if (v < 0) continue;
				bits = (bits << 6) | v;
				count += 6;
				if (count >= 8) {
					count -= 8;
					out[at++] = (bits >> count) & 0xff;
				}
			}
			return out.subarray(0, at);
		}
		case 'latin1':
		case 'ascii': {
			const out = new Uint8Array(string.length);
			for (let i = 0; i < string.length; i++) out[i] = string.charCodeAt(i) & 0xff;
			return out;
		}
		case 'utf16le': {
			const out = new Uint8Array(string.length * 2);
			for (let i = 0; i < string.length; i++) {
				const c = string.charCodeAt(i);
				out[i * 2] = c & 0xff;
				out[i * 2 + 1] = c >> 8;
			}
			return out;
		}
	}
	throw unknownEncoding(encoding);
};

// String.fromCharCode over bytes (or units), in chunks: one call per character would make a
// long string one concatenation at a time
const CHUNK = 4096;
const charCodes = (codes) => {
	let out = '';
	for (let i = 0; i < codes.length; i += CHUNK)
		out += String.fromCharCode.apply(null, codes.slice(i, i + CHUNK));
	return out;
};

/** Bytes (a Uint8Array) as a string in an encoding. */
const decodeBytes = (bytes, encoding) => {
	switch (encoding) {
		case 'utf8':
			return new TextDecoder().decode(bytes);
		case 'hex': {
			let out = '';
			for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
			return out;
		}
		case 'base64':
		case 'base64url': {
			const alphabet = encoding === 'base64' ? BASE64 : BASE64URL;
			let out = '';
			let i = 0;
			for (; i + 2 < bytes.length; i += 3) {
				const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
				out +=
					alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
			}
			const rest = bytes.length - i;
			const pad = encoding === 'base64' ? '=' : '';
			if (rest === 1) {
				const n = bytes[i] << 16;
				out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + pad + pad;
			} else if (rest === 2) {
				const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
				out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + pad;
			}
			return out;
		}
		case 'latin1':
			return charCodes(Array.from(bytes));
		case 'ascii':
			return charCodes(Array.from(bytes, (b) => b & 0x7f));
		case 'utf16le': {
			const units = [];
			for (let i = 0; i + 1 < bytes.length; i += 2) units.push(bytes[i] | (bytes[i + 1] << 8));
			return charCodes(units);
		}
	}
	throw unknownEncoding(encoding);
};

// how many UTF-8 bytes a string takes, without encoding it
const utf8Length = (string) => {
	let n = 0;
	for (let i = 0; i < string.length; i++) {
		const c = string.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < string.length) {
			const next = string.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				n += 4;
				i++;
			} else n += 3;
		} else n += 3;
	}
	return n;
};

// ---- Buffer ----

// a view as a Buffer: a Uint8Array over the same memory, with Buffer's prototype
const asBuffer = (view) => {
	Object.setPrototypeOf(view, Buffer.prototype);
	return view;
};

const u8 = (value) =>
	value instanceof Uint8Array
		? value
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

// an offset argument: an integer inside [0, max], or Node's error
const checkOffset = (offset, max) => {
	if (offset === undefined) offset = 0;
	if (typeof offset !== 'number')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "offset" argument must be of type number. Received ${typeName(offset)}`
		);
	if (!Number.isInteger(offset)) throw outOfRange('offset', 'an integer', offset);
	if (max < 0) throw outOfBounds();
	if (offset < 0 || offset > max) throw outOfRange('offset', `>= 0 and <= ${max}`, offset);
	return offset;
};

const checkInt = (value, min, max, suffix = '') => {
	if (value < min || value > max || Number.isNaN(value)) {
		const range =
			min === 0 && suffix === ''
				? `>= 0 and <= ${max}`
				: `>= ${min}${suffix} and <= ${max}${suffix}`;
		throw outOfRange('value', range, suffix === 'n' ? `${value}n` : value);
	}
};

/** Node's byte array: a Uint8Array with string encodings and typed reads and writes. */
export class Buffer extends Uint8Array {
	/**
	 * A Buffer of a string (in an encoding, utf8 by default), an array of bytes, an
	 * ArrayBuffer (sharing its memory, from byteOffset for length bytes) or another view
	 * (copied).
	 */
	static from(value, encodingOrOffset, length) {
		if (typeof value === 'string') return Buffer.fromString(value, encodingOrOffset);
		if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
			const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset);
			if (offset > value.byteLength)
				throw codeError(
					RangeError,
					'ERR_BUFFER_OUT_OF_BOUNDS',
					'"offset" is outside of buffer bounds'
				);
			const end = length === undefined ? value.byteLength : offset + Number(length);
			if (end > value.byteLength)
				throw codeError(
					RangeError,
					'ERR_BUFFER_OUT_OF_BOUNDS',
					'"length" is outside of buffer bounds'
				);
			return asBuffer(new Uint8Array(value, offset, end - offset));
		}
		if (ArrayBuffer.isView(value)) {
			// element by element, each truncated to a byte, as Node copies a Uint16Array
			const out = Buffer.allocUnsafe(value.length);
			for (let i = 0; i < value.length; i++) out[i] = Number(value[i]);
			return out;
		}
		if (Array.isArray(value)) {
			const out = Buffer.allocUnsafe(value.length);
			for (let i = 0; i < value.length; i++) out[i] = value[i];
			return out;
		}
		if (value !== null && typeof value === 'object') {
			// { type: 'Buffer', data } (a Buffer's JSON), an array-like, or an object whose
			// primitive value is one of the above
			if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
			if (typeof value.length === 'number') return Buffer.from(Array.from(value));
			const primitive =
				typeof value[Symbol.toPrimitive] === 'function'
					? value[Symbol.toPrimitive]('string')
					: value.valueOf();
			if (primitive !== value && primitive !== null && primitive !== undefined)
				return Buffer.from(primitive, encodingOrOffset, length);
		}
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received ${typeName(value)}`
		);
	}

	/** @internal a string's bytes in an encoding, as a Buffer */
	static fromString(string, encoding) {
		const bytes = encodeString(string, encodingOrThrow(encoding));
		const out = Buffer.allocUnsafe(bytes.length);
		out.set(bytes);
		return out;
	}

	/** size zero bytes, or size bytes of fill (a number, string or bytes, repeated). */
	static alloc(size, fill, encoding) {
		checkSize(size);
		const out = new Buffer(size);
		if (fill !== undefined && fill !== 0 && size > 0) fillBytes(out, fill, 0, size, encoding);
		return out;
	}

	/** size bytes, zeroed here (Node leaves them as they were). */
	static allocUnsafe(size) {
		checkSize(size);
		return new Buffer(size);
	}

	static allocUnsafeSlow(size) {
		return Buffer.allocUnsafe(size);
	}

	/** Whether value is a Buffer. */
	static isBuffer(value) {
		return value instanceof Buffer;
	}

	/** Whether Node knows the encoding. */
	static isEncoding(encoding) {
		return (
			typeof encoding === 'string' && encoding !== '' && normalizeEncoding(encoding) !== undefined
		);
	}

	/** How many bytes a string takes in an encoding (or a view or ArrayBuffer has). */
	static byteLength(value, encoding) {
		if (typeof value !== 'string') {
			if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
			throw codeError(
				TypeError,
				'ERR_INVALID_ARG_TYPE',
				`The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received ${typeName(value)}`
			);
		}
		switch (normalizeEncoding(encoding) ?? 'utf8') {
			case 'utf8':
				return utf8Length(value);
			case 'utf16le':
				return value.length * 2;
			case 'latin1':
			case 'ascii':
				return value.length;
			case 'hex':
				return value.length >>> 1;
			default:
				return encodeString(value, 'base64').length;
		}
	}

	/** The Buffers (or Uint8Arrays) of list, one after the other, in a new Buffer. */
	static concat(list, totalLength) {
		if (!Array.isArray(list))
			throw codeError(
				TypeError,
				'ERR_INVALID_ARG_TYPE',
				`The "list" argument must be an instance of Array. Received ${typeName(list)}`
			);
		if (totalLength === undefined) {
			totalLength = 0;
			for (const item of list) totalLength += item.length;
		}
		const out = Buffer.alloc(totalLength);
		let at = 0;
		for (let i = 0; i < list.length && at < totalLength; i++) {
			const item = list[i];
			if (!(item instanceof Uint8Array))
				throw codeError(
					TypeError,
					'ERR_INVALID_ARG_TYPE',
					`The "list[${i}]" argument must be an instance of Buffer or Uint8Array. Received ${typeName(item)}`
				);
			const n = Math.min(item.length, totalLength - at);
			out.set(n === item.length ? item : item.subarray(0, n), at);
			at += n;
		}
		return out;
	}

	/** -1, 0 or 1: how a sorts against b, byte by byte. */
	static compare(a, b) {
		return compareBytes(a, 0, a.length, b, 0, b.length);
	}

	static copyBytesFrom(view, offset = 0, length) {
		const bytes = u8(view);
		const size = view.BYTES_PER_ELEMENT ?? 1;
		const end = length === undefined ? view.length : offset + length;
		return Buffer.from(bytes.subarray(offset * size, Math.min(end, view.length) * size));
	}

	/** The bytes as a string in an encoding (utf8 by default), from start to end. */
	toString(encoding, start, end) {
		return bytesToString(this, encoding, start, end);
	}

	toLocaleString(encoding, start, end) {
		return bytesToString(this, encoding, start, end);
	}

	/**
	 * Writes a string's bytes (in an encoding) at offset, at most length of them, and no
	 * character in part. write(string, encoding) and write(string, offset, encoding) too.
	 * @returns {number} how many bytes were written
	 */
	write(string, offset, length, encoding) {
		if (typeof offset === 'string') {
			encoding = offset;
			offset = 0;
			length = this.length;
		} else if (typeof length === 'string') {
			encoding = length;
			length = undefined;
		}
		offset = offset === undefined ? 0 : offset;
		if (offset < 0 || offset > this.length)
			throw outOfRange('offset', `>= 0 && <= ${this.length}`, offset);
		const room = this.length - offset;
		length = length === undefined || length > room ? room : length;
		const name = encodingOrThrow(encoding);
		let bytes = encodeString(string, name);
		if (bytes.length > length) {
			let n = length;
			if (name === 'utf8') {
				// back to the start of the character that would be cut
				let start = n;
				while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
				n = start;
			} else if (name === 'utf16le') n -= n % 2;
			bytes = bytes.subarray(0, n);
		}
		this.set(bytes, offset);
		return bytes.length;
	}

	/** A Buffer over bytes start to end of this one's memory (not a copy). */
	subarray(start, end) {
		return asBuffer(Uint8Array.prototype.subarray.call(this, start, end));
	}

	/** As subarray: Node's slice shares memory, unlike Uint8Array's. */
	slice(start, end) {
		return asBuffer(Uint8Array.prototype.subarray.call(this, start, end));
	}

	/** { type: 'Buffer', data: [bytes] }, what JSON.stringify writes. */
	toJSON() {
		return { type: 'Buffer', data: Array.from(this) };
	}

	equals(other) {
		if (!(other instanceof Uint8Array))
			throw codeError(
				TypeError,
				'ERR_INVALID_ARG_TYPE',
				`The "otherBuffer" argument must be an instance of Buffer or Uint8Array. Received ${typeName(other)}`
			);
		return compareBytes(this, 0, this.length, other, 0, other.length) === 0;
	}

	/** -1, 0 or 1: how this (sourceStart to sourceEnd) sorts against target (its range). */
	compare(
		target,
		targetStart = 0,
		targetEnd = target.length,
		sourceStart = 0,
		sourceEnd = this.length
	) {
		if (!(target instanceof Uint8Array))
			throw codeError(
				TypeError,
				'ERR_INVALID_ARG_TYPE',
				`The "target" argument must be an instance of Buffer or Uint8Array. Received ${typeName(target)}`
			);
		return compareBytes(this, sourceStart, sourceEnd, target, targetStart, targetEnd);
	}

	/**
	 * Copies bytes sourceStart to sourceEnd into target at targetStart, as many as fit.
	 * @returns {number} how many were copied
	 */
	copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
		if (sourceStart < 0) throw outOfRange('sourceStart', `>= 0 && <= ${this.length}`, sourceStart);
		if (targetStart < 0) throw outOfRange('targetStart', '>= 0', targetStart);
		sourceEnd = Math.min(sourceEnd, this.length);
		const n = Math.min(sourceEnd - sourceStart, target.length - targetStart);
		if (n <= 0) return 0;
		// through a copy: source and target can be the same memory
		target.set(Uint8Array.prototype.slice.call(this, sourceStart, sourceStart + n), targetStart);
		return n;
	}

	/** Fills offset to end with value (a number, a string in an encoding, or bytes), repeated. */
	fill(value, offset, end, encoding) {
		return fillBytes(this, value, offset, end, encoding);
	}

	/** The first index of value (a byte, a string in an encoding, or bytes) from byteOffset, or -1. */
	indexOf(value, byteOffset, encoding) {
		return searchBytes(this, value, byteOffset, encoding, true);
	}

	lastIndexOf(value, byteOffset, encoding) {
		return searchBytes(this, value, byteOffset, encoding, false);
	}

	includes(value, byteOffset, encoding) {
		return searchBytes(this, value, byteOffset, encoding, true) !== -1;
	}

	swap16() {
		if (this.length % 2 !== 0)
			throw codeError(
				RangeError,
				'ERR_INVALID_BUFFER_SIZE',
				'Buffer size must be a multiple of 16-bits'
			);
		for (let i = 0; i < this.length; i += 2) swap(this, i, i + 1);
		return this;
	}

	swap32() {
		if (this.length % 4 !== 0)
			throw codeError(
				RangeError,
				'ERR_INVALID_BUFFER_SIZE',
				'Buffer size must be a multiple of 32-bits'
			);
		for (let i = 0; i < this.length; i += 4) {
			swap(this, i, i + 3);
			swap(this, i + 1, i + 2);
		}
		return this;
	}

	swap64() {
		if (this.length % 8 !== 0)
			throw codeError(
				RangeError,
				'ERR_INVALID_BUFFER_SIZE',
				'Buffer size must be a multiple of 64-bits'
			);
		for (let i = 0; i < this.length; i += 8)
			for (let j = 0; j < 4; j++) swap(this, i + j, i + 7 - j);
		return this;
	}

	// ---- integers: unsigned and signed, 1 to 6 bytes, little and big endian ----

	readUIntLE(offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		let value = 0;
		for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[offset + i];
		return value;
	}

	readUIntBE(offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		let value = 0;
		for (let i = 0; i < byteLength; i++) value = value * 256 + this[offset + i];
		return value;
	}

	readIntLE(offset, byteLength) {
		const value = this.readUIntLE(offset, byteLength);
		const top = 2 ** (8 * byteLength - 1);
		return value >= top ? value - top * 2 : value;
	}

	readIntBE(offset, byteLength) {
		const value = this.readUIntBE(offset, byteLength);
		const top = 2 ** (8 * byteLength - 1);
		return value >= top ? value - top * 2 : value;
	}

	writeUIntLE(value, offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		checkInt(value, 0, 2 ** (8 * byteLength) - 1);
		return writeBytesLE(this, value, offset, byteLength);
	}

	writeUIntBE(value, offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		checkInt(value, 0, 2 ** (8 * byteLength) - 1);
		return writeBytesBE(this, value, offset, byteLength);
	}

	writeIntLE(value, offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		const top = 2 ** (8 * byteLength - 1);
		checkInt(value, -top, top - 1);
		return writeBytesLE(this, value < 0 ? value + top * 2 : value, offset, byteLength);
	}

	writeIntBE(value, offset, byteLength) {
		offset = checkOffset(offset, this.length - byteLength);
		const top = 2 ** (8 * byteLength - 1);
		checkInt(value, -top, top - 1);
		return writeBytesBE(this, value < 0 ? value + top * 2 : value, offset, byteLength);
	}

	readUInt8(offset) {
		return this.readUIntLE(offset, 1);
	}
	readUInt16LE(offset) {
		return this.readUIntLE(offset, 2);
	}
	readUInt16BE(offset) {
		return this.readUIntBE(offset, 2);
	}
	readUInt32LE(offset) {
		return this.readUIntLE(offset, 4);
	}
	readUInt32BE(offset) {
		return this.readUIntBE(offset, 4);
	}
	readInt8(offset) {
		return this.readIntLE(offset, 1);
	}
	readInt16LE(offset) {
		return this.readIntLE(offset, 2);
	}
	readInt16BE(offset) {
		return this.readIntBE(offset, 2);
	}
	readInt32LE(offset) {
		return this.readIntLE(offset, 4);
	}
	readInt32BE(offset) {
		return this.readIntBE(offset, 4);
	}

	writeUInt8(value, offset) {
		return this.writeUIntLE(value, offset, 1);
	}
	writeUInt16LE(value, offset) {
		return this.writeUIntLE(value, offset, 2);
	}
	writeUInt16BE(value, offset) {
		return this.writeUIntBE(value, offset, 2);
	}
	writeUInt32LE(value, offset) {
		return this.writeUIntLE(value, offset, 4);
	}
	writeUInt32BE(value, offset) {
		return this.writeUIntBE(value, offset, 4);
	}
	writeInt8(value, offset) {
		return this.writeIntLE(value, offset, 1);
	}
	writeInt16LE(value, offset) {
		return this.writeIntLE(value, offset, 2);
	}
	writeInt16BE(value, offset) {
		return this.writeIntBE(value, offset, 2);
	}
	writeInt32LE(value, offset) {
		return this.writeIntLE(value, offset, 4);
	}
	writeInt32BE(value, offset) {
		return this.writeIntBE(value, offset, 4);
	}

	// ---- 64-bit integers, as BigInts ----

	readBigUInt64LE(offset) {
		offset = checkOffset(offset, this.length - 8);
		return (BigInt(this.readUInt32LE(offset + 4)) << 32n) | BigInt(this.readUInt32LE(offset));
	}

	readBigUInt64BE(offset) {
		offset = checkOffset(offset, this.length - 8);
		return (BigInt(this.readUInt32BE(offset)) << 32n) | BigInt(this.readUInt32BE(offset + 4));
	}

	readBigInt64LE(offset) {
		return BigInt.asIntN(64, this.readBigUInt64LE(offset));
	}

	readBigInt64BE(offset) {
		return BigInt.asIntN(64, this.readBigUInt64BE(offset));
	}

	writeBigUInt64LE(value, offset) {
		checkInt(value, 0n, 2n ** 64n - 1n, 'n');
		return writeBig(this, value, offset, true);
	}

	writeBigUInt64BE(value, offset) {
		checkInt(value, 0n, 2n ** 64n - 1n, 'n');
		return writeBig(this, value, offset, false);
	}

	writeBigInt64LE(value, offset) {
		checkInt(value, -(2n ** 63n), 2n ** 63n - 1n, 'n');
		return writeBig(this, BigInt.asUintN(64, value), offset, true);
	}

	writeBigInt64BE(value, offset) {
		checkInt(value, -(2n ** 63n), 2n ** 63n - 1n, 'n');
		return writeBig(this, BigInt.asUintN(64, value), offset, false);
	}

	// ---- floats, through a DataView over the same bytes ----

	readFloatLE(offset) {
		return view(this).getFloat32(checkOffset(offset, this.length - 4), true);
	}
	readFloatBE(offset) {
		return view(this).getFloat32(checkOffset(offset, this.length - 4), false);
	}
	readDoubleLE(offset) {
		return view(this).getFloat64(checkOffset(offset, this.length - 8), true);
	}
	readDoubleBE(offset) {
		return view(this).getFloat64(checkOffset(offset, this.length - 8), false);
	}
	writeFloatLE(value, offset) {
		offset = checkOffset(offset, this.length - 4);
		view(this).setFloat32(offset, value, true);
		return offset + 4;
	}
	writeFloatBE(value, offset) {
		offset = checkOffset(offset, this.length - 4);
		view(this).setFloat32(offset, value, false);
		return offset + 4;
	}
	writeDoubleLE(value, offset) {
		offset = checkOffset(offset, this.length - 8);
		view(this).setFloat64(offset, value, true);
		return offset + 8;
	}
	writeDoubleBE(value, offset) {
		offset = checkOffset(offset, this.length - 8);
		view(this).setFloat64(offset, value, false);
		return offset + 8;
	}

	/** What util.inspect shows: <Buffer 68 69>, the first INSPECT_MAX_BYTES bytes. */
	[inspectSymbol]() {
		const n = Math.min(this.length, INSPECT_MAX_BYTES);
		let out = '<Buffer';
		for (let i = 0; i < n; i++) out += ' ' + HEX[this[i] >> 4] + HEX[this[i] & 15];
		if (this.length > n)
			out += ` ... ${this.length - n} more byte${this.length - n > 1 ? 's' : ''}`;
		return out + '>';
	}
}

// Node's lowercase aliases (readUint8 for readUInt8, ...)
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
	if (/^(read|write)(Big)?UInt/.test(name))
		Buffer.prototype[name.replace('UInt', 'Uint')] = Buffer.prototype[name];
}

Buffer.poolSize = 8192;

const checkSize = (size) => {
	if (typeof size !== 'number')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "size" argument must be of type number. Received ${typeName(size)}`
		);
	if (size < 0 || size > kMaxLength || Number.isNaN(size))
		throw outOfRange('size', `>= 0 && <= ${kMaxLength}`, size);
};

const fillBytes = (target, value, offset, end, encoding) => {
	if (typeof offset === 'string') {
		encoding = offset;
		offset = 0;
		end = target.length;
	} else if (typeof end === 'string') {
		encoding = end;
		end = target.length;
	}
	offset = offset === undefined ? 0 : offset;
	end = end === undefined ? target.length : end;
	if (offset < 0 || offset > target.length)
		throw outOfRange('offset', `>= 0 && <= ${target.length}`, offset);
	if (end < 0 || end > target.length) throw outOfRange('end', `>= 0 && <= ${target.length}`, end);
	if (end <= offset) return target;
	if (typeof value === 'number' || typeof value === 'boolean') {
		Uint8Array.prototype.fill.call(target, Number(value) & 0xff, offset, end);
		return target;
	}
	const bytes =
		typeof value === 'string' ? encodeString(value, encodingOrThrow(encoding)) : u8(value);
	if (bytes.length === 0) {
		if (typeof value === 'string') {
			Uint8Array.prototype.fill.call(target, 0, offset, end);
			return target;
		}
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_VALUE',
			`The argument 'value' is invalid. Received ${value}`
		);
	}
	for (let i = offset, j = 0; i < end; i++, j = (j + 1) % bytes.length) target[i] = bytes[j];
	return target;
};

// Buffer's toString, for its methods to call: a call of .toString on a Buffer in this module
// would be Uint8Array's (Porffor dispatches a typed array's builtin methods by its type)
const bytesToString = (bytes, encoding, start, end) => {
	const length = bytes.length;
	start = start === undefined || start < 0 ? 0 : Math.trunc(start);
	end = end === undefined || end > length ? length : Math.trunc(end);
	const name = encodingOrThrow(encoding);
	if (start >= length || end <= start) return '';
	return decodeBytes(start === 0 && end === length ? bytes : bytes.subarray(start, end), name);
};

const view = (buffer) => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const swap = (bytes, i, j) => {
	const t = bytes[i];
	bytes[i] = bytes[j];
	bytes[j] = t;
};

const writeBytesLE = (bytes, value, offset, n) => {
	for (let i = 0; i < n; i++) {
		bytes[offset + i] = value % 256;
		value = Math.floor(value / 256);
	}
	return offset + n;
};

const writeBytesBE = (bytes, value, offset, n) => {
	for (let i = n - 1; i >= 0; i--) {
		bytes[offset + i] = value % 256;
		value = Math.floor(value / 256);
	}
	return offset + n;
};

const writeBig = (bytes, value, offset, little) => {
	offset = checkOffset(offset, bytes.length - 8);
	const lo = Number(value & 0xffffffffn);
	const hi = Number(value >> 32n);
	if (little) {
		writeBytesLE(bytes, lo, offset, 4);
		writeBytesLE(bytes, hi, offset + 4, 4);
	} else {
		writeBytesBE(bytes, hi, offset, 4);
		writeBytesBE(bytes, lo, offset + 4, 4);
	}
	return offset + 8;
};

const compareBytes = (a, aStart, aEnd, b, bStart, bEnd) => {
	const n = Math.min(aEnd - aStart, bEnd - bStart);
	for (let i = 0; i < n; i++) {
		const x = a[aStart + i];
		const y = b[bStart + i];
		if (x !== y) return x < y ? -1 : 1;
	}
	const la = aEnd - aStart;
	const lb = bEnd - bStart;
	return la < lb ? -1 : la > lb ? 1 : 0;
};

// indexOf / lastIndexOf: value a byte, a string (in an encoding) or bytes
const searchBytes = (bytes, value, byteOffset, encoding, forward) => {
	if (typeof byteOffset === 'string') {
		encoding = byteOffset;
		byteOffset = undefined;
	}
	const length = bytes.length;
	let from = byteOffset === undefined ? (forward ? 0 : length) : Number(byteOffset) || 0;
	if (from < 0) from += length;

	let needle;
	if (typeof value === 'number') needle = [value & 0xff];
	else if (typeof value === 'string') needle = encodeString(value, encodingOrThrow(encoding));
	else if (value instanceof Uint8Array) needle = value;
	else
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "value" argument must be one of type number or string or an instance of Buffer or Uint8Array. Received ${typeName(value)}`
		);

	const n = needle.length;
	if (n === 0) return forward ? Math.min(Math.max(from, 0), length) : Math.min(from, length);
	if (forward) {
		for (let i = Math.max(from, 0); i + n <= length; i++) if (matchAt(bytes, needle, i)) return i;
	} else {
		for (let i = Math.min(from, length - n); i >= 0; i--) if (matchAt(bytes, needle, i)) return i;
	}
	return -1;
};

const matchAt = (bytes, needle, at) => {
	for (let j = 0; j < needle.length; j++) if (bytes[at + j] !== needle[j]) return false;
	return true;
};

/** A Buffer of size bytes (deprecated in Node: allocUnsafeSlow). */
export const SlowBuffer = (size) => Buffer.allocUnsafeSlow(size);

/** Whether bytes are valid UTF-8. */
export const isUtf8 = (input) => {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(u8(input));
		return true;
	} catch {
		return false;
	}
};

/** Whether bytes are all ASCII. */
export const isAscii = (input) => {
	const bytes = u8(input);
	for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
	return true;
};

const atobValue = (data) => atob(data);
const btoaValue = (data) => btoa(data);
export { atobValue as atob, btoaValue as btoa };

export default {
	Buffer,
	SlowBuffer,
	Blob,
	File,
	atob: atobValue,
	btoa: btoaValue,
	constants,
	kMaxLength,
	kStringMaxLength,
	INSPECT_MAX_BYTES,
	isUtf8,
	isAscii
};
