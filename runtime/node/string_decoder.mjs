// node:string_decoder: StringDecoder, bytes to a string a chunk at a time, a character split
// across chunks held back until the rest of it comes: UTF-8 (through TextDecoder's stream
// mode), UTF-16LE and base64 (whole units and groups), and the byte-per-character encodings.
import { Buffer } from './buffer.mjs';

const toString = (bytes, encoding) => Buffer.prototype.toString.call(bytes, encoding);

const normalize = (encoding) => {
	const name = String(encoding ?? 'utf8').toLowerCase();
	switch (name) {
		case 'utf8':
		case 'utf-8':
			return 'utf8';
		case 'ucs2':
		case 'ucs-2':
		case 'utf16le':
		case 'utf-16le':
			return 'utf16le';
		case 'latin1':
		case 'binary':
			return 'latin1';
		case 'base64':
		case 'base64url':
		case 'ascii':
		case 'hex':
			return name;
	}
	const e = new TypeError(`Unknown encoding: ${encoding}`);
	e.code = 'ERR_UNKNOWN_ENCODING';
	throw e;
};

const bytesOf = (chunk) => {
	if (typeof chunk === 'string') return Buffer.from(chunk);
	if (chunk instanceof Uint8Array) return chunk;
	if (ArrayBuffer.isView(chunk))
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	const e = new TypeError(
		`The "buf" argument must be an instance of Buffer, TypedArray, or DataView. Received ${chunk === null ? 'null' : typeof chunk}`
	);
	e.code = 'ERR_INVALID_ARG_TYPE';
	throw e;
};

/** Decodes bytes to strings chunk by chunk, keeping a split character for the next chunk. */
export class StringDecoder {
	constructor(encoding) {
		this.encoding = normalize(encoding);
		this._utf8 = this.encoding === 'utf8' ? new TextDecoder() : null;
		// bytes held back: the start of a UTF-16 unit or of a base64 group
		this._rest = new Uint8Array(0);
	}

	/** The string for chunk and what was held back before it, less what it cuts short. */
	write(chunk) {
		const bytes = bytesOf(chunk);
		if (this._utf8 !== null) return this._utf8.decode(bytes, { stream: true });
		if (this.encoding !== 'utf16le' && this.encoding !== 'base64' && this.encoding !== 'base64url')
			return toString(bytes, this.encoding);

		const all = new Uint8Array(this._rest.length + bytes.length);
		all.set(this._rest);
		all.set(bytes, this._rest.length);
		const unit = this.encoding === 'utf16le' ? 2 : 3;
		let whole = all.length - (all.length % unit);
		// a UTF-16 high surrogate at the end waits for its low half
		if (unit === 2 && whole >= 2 && (all[whole - 1] & 0xfc) === 0xd8) whole -= 2;
		this._rest = all.slice(whole);
		return toString(all.subarray(0, whole), this.encoding);
	}

	/** What is held back, as a string (a split UTF-8 character as U+FFFD), then chunk's. */
	end(chunk) {
		let out = chunk === undefined ? '' : this.write(chunk);
		if (this._utf8 !== null) out += this._utf8.decode();
		else if (this._rest.length > 0) {
			out += toString(this._rest, this.encoding);
			this._rest = new Uint8Array(0);
		}
		return out;
	}
}

export default { StringDecoder };
