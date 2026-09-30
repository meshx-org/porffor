// A streaming inflater for DecompressionStream: DEFLATE (RFC 1951) in a zlib wrapper
// ('deflate', RFC 1950), a gzip member ('gzip', RFC 1952) or bare ('deflate-raw'), fed a
// chunk at a time. Input that stops mid-symbol waits for the next chunk: the decoder goes
// back to the last whole unit (a header, a symbol, a stored run) and resumes there. Corrupt
// input, a bad checksum, bytes after the end and an end that never comes are TypeErrors, as
// zlib (which browsers use) reports them.

import { adler32, crc32 } from './zlib-checksum.mjs';

/** Thrown inside the decoder when the input runs out; the step is retried with more. */
const NEED_INPUT = {};

/** The window a back-reference reaches into (32 KiB). */
const WINDOW = 32768;

const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
	163, 195, 227, 258
];
const LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
	3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const DIST_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];
/** The order a dynamic block sends its code length code lengths in. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const corrupt = (what) => new TypeError(`DecompressionStream: ${what}`);

/**
 * A canonical Huffman code as a lookup table indexed by the next `bits` input bits (least
 * significant first): each entry is symbol << 4 | code length, or -1 where no code is.
 * A TypeError for an over-subscribed set, or an incomplete one (but a single code of length
 * 1, as zlib allows); null when there are no codes at all.
 * @param {Uint8Array} lengths
 * @param {string} what
 */
function huffmanTable(lengths, what) {
	// (no variable is named length: Porffor reads a let `length` as a key like .length)
	const count = new Int32Array(16);
	let maxLength = 0;

	for (let i = 0; i < lengths.length; i++) {
		// += 1, not ++: Porffor's ++ on a typed array element does not store
		count[lengths[i]] += 1;

		if (lengths[i] > maxLength) maxLength = lengths[i];
	}

	if (maxLength === 0) return null;
	count[0] = 0;
	let left = 1;

	for (let bits = 1; bits <= 15; bits++) {
		left = left * 2 - count[bits];

		if (left < 0) throw corrupt(`invalid ${what} (over-subscribed)`);
	}

	if (left > 0 && maxLength !== 1) throw corrupt(`invalid ${what} (incomplete)`);
	const next = new Int32Array(16);
	let code = 0;

	for (let bits = 1; bits <= 15; bits++) {
		code = (code + count[bits - 1]) << 1;
		next[bits] = code;
	}
	const size = 1 << maxLength;
	const table = new Int32Array(size).fill(-1);

	for (let symbol = 0; symbol < lengths.length; symbol++) {
		const bits = lengths[symbol];

		if (bits === 0) continue;
		const assigned = next[bits];

		next[bits] += 1;
		// the code's bits reversed: the input gives them most significant first
		let reversed = 0;

		for (let bit = 0; bit < bits; bit++) reversed |= ((assigned >> bit) & 1) << (bits - 1 - bit);

		for (let index = reversed; index < size; index += 1 << bits)
			table[index] = (symbol << 4) | bits;
	}

	return { table, bits: maxLength };
}

/** The fixed codes' tables (RFC 1951 3.2.6), built on first use. */
let fixedTables;

function fixedCodes() {
	if (fixedTables === undefined) {
		const lengths = new Uint8Array(288);

		for (let i = 0; i < 288; i++) lengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
		// 32 codes, though 30 and 31 never occur (a complete code)
		const distances = new Uint8Array(32).fill(5);

		fixedTables = [huffmanTable(lengths, 'fixed codes'), huffmanTable(distances, 'fixed codes')];
	}

	return fixedTables;
}

/** Inflates one stream of a format, a chunk at a time. */
export class Inflater {
	/** @param {'deflate' | 'deflate-raw' | 'gzip'} format */
	constructor(format) {
		this.format = format;
		this.input = new Uint8Array(0);
		// the read position, in bits into input
		this.bit = 0;
		// what comes next: header, block, stored, codes, trailer, done
		this.stage = format === 'deflate-raw' ? 'block' : 'header';
		this.last = false;
		this.storedLeft = 0;
		this.lengths = null;
		this.distances = null;
		// the output so far that a back-reference can reach, and how much of it is new
		this.out = new Uint8Array(65536);
		this.outLength = 0;
		this.emitted = 0;
		this.check = format === 'gzip' ? 0 : 1;
		this.total = 0;
		this.trailing = false;
	}

	/** Whether the stream has ended (its trailer read, for a wrapped format). */
	get ended() {
		return this.stage === 'done';
	}

	/**
	 * Takes a chunk of input: the bytes it decompresses to (maybe none). A TypeError for
	 * corrupt input or input after the end; `trailing` turns true when this chunk went on
	 * past the end (what came before is still returned).
	 * @param {Uint8Array} chunk
	 */
	push(chunk) {
		if (chunk.length > 0) {
			if (this.stage === 'done') throw corrupt('input after the end of the stream');
			const start = this.bit >> 3;
			const rest = this.input.length - start;
			const input = new Uint8Array(rest + chunk.length);

			input.set(this.input.subarray(start), 0);
			input.set(chunk, rest);
			this.input = input;
			this.bit -= start * 8;
		}
		let mark = this.bit;

		try {
			while (this.stage !== 'done') {
				mark = this.bit;
				this.step();
			}
		} catch (reason) {
			if (reason !== NEED_INPUT) throw reason;
			this.bit = mark;
		}
		// bytes after the end: the caller hands out what came before, then fails (trailing)
		this.trailing = this.stage === 'done' && this.bit < this.input.length * 8;

		return this.take();
	}

	/** The output not handed out yet; keeps the window a back-reference may reach. */
	take() {
		const out = this.out.slice(this.emitted, this.outLength);

		if (this.format === 'gzip')
			this.check = crc32(this.check, this.out, this.emitted, this.outLength);
		else if (this.format === 'deflate')
			this.check = adler32(this.check, this.out, this.emitted, this.outLength);
		this.total = (this.total + (this.outLength - this.emitted)) >>> 0;

		if (this.outLength > WINDOW * 2) {
			this.out.copyWithin(0, this.outLength - WINDOW, this.outLength);
			this.outLength = WINDOW;
		}
		this.emitted = this.outLength;

		return out;
	}

	/** The next `count` bits (up to 24), least significant first. */
	bits(count) {
		if (count === 0) return 0;
		const bit = this.bit;

		if (bit + count > this.input.length * 8) throw NEED_INPUT;
		const input = this.input;
		let byte = bit >> 3;
		let value = input[byte] >> (bit & 7);
		let got = 8 - (bit & 7);

		while (got < count) {
			value |= input[++byte] << got;
			got += 8;
		}
		this.bit = bit + count;

		return value & ((1 << count) - 1);
	}

	/** The next whole byte (after the current one's remaining bits are skipped). */
	byte() {
		this.align();

		return this.bits(8);
	}

	align() {
		this.bit = (this.bit + 7) & ~7;
	}

	/** Decodes one symbol of a Huffman code. */
	symbol(code) {
		const bit = this.bit;
		const available = this.input.length * 8 - bit;
		const input = this.input;
		let byte = bit >> 3;
		// peek up to the table's width, with what input there is
		let value = byte < input.length ? input[byte] >> (bit & 7) : 0;
		let got = 8 - (bit & 7);

		while (got < code.bits && ++byte < input.length) {
			value |= input[byte] << got;
			got += 8;
		}
		const entry = code.table[value & ((1 << code.bits) - 1)];

		if (entry === -1) {
			if (available < code.bits) throw NEED_INPUT;

			throw corrupt('invalid code');
		}
		const length = entry & 15;

		if (length > available) throw NEED_INPUT;
		this.bit = bit + length;

		return entry >> 4;
	}

	/** Makes room for `count` more output bytes. */
	reserve(count) {
		if (this.outLength + count <= this.out.length) return;
		let size = this.out.length * 2;

		while (size < this.outLength + count) size *= 2;
		const grown = new Uint8Array(size);

		grown.set(this.out.subarray(0, this.outLength), 0);
		this.out = grown;
	}

	/** One whole unit of input: a header, a block header, a symbol, a stored run, a trailer. */
	step() {
		const stage = this.stage;

		if (stage === 'header') this.header();
		else if (stage === 'block') this.blockHeader();
		else if (stage === 'stored') this.storedRun();
		else if (stage === 'codes') this.codes();
		else if (stage === 'trailer') this.trailer();
	}

	header() {
		if (this.format === 'deflate') {
			const cmf = this.bits(8);
			const flg = this.bits(8);

			if ((cmf & 15) !== 8) throw corrupt('unknown compression method');

			if (cmf >> 4 > 7) throw corrupt('invalid window size');

			if ((cmf * 256 + flg) % 31 !== 0) throw corrupt('incorrect header check');

			if (flg & 32) throw corrupt('a preset dictionary is needed');
		} else {
			const start = this.bit >> 3;

			if (this.bits(8) !== 31 || this.bits(8) !== 139) throw corrupt('incorrect header check');

			if (this.bits(8) !== 8) throw corrupt('unknown compression method');
			const flags = this.bits(8);

			if (flags & 0xe0) throw corrupt('unknown header flags set');
			// mtime, xfl, os
			this.bits(24);
			this.bits(24);

			if (flags & 4) {
				const length = this.bits(16);

				for (let i = 0; i < length; i++) this.bits(8);
			}

			if (flags & 8) while (this.bits(8) !== 0);

			if (flags & 16) while (this.bits(8) !== 0);

			if (flags & 2) {
				const expected = crc32(0, this.input, start, this.bit >> 3) & 0xffff;

				if (this.bits(16) !== expected) throw corrupt('header crc mismatch');
			}
		}
		this.stage = 'block';
	}

	blockHeader() {
		const last = this.bits(1);
		const type = this.bits(2);

		if (type === 0) {
			this.align();
			const length = this.bits(16);
			const complement = this.bits(16);

			if ((length ^ 0xffff) !== complement) throw corrupt('invalid stored block lengths');
			this.storedLeft = length;
			this.stage = 'stored';
		} else if (type === 1) {
			[this.lengths, this.distances] = fixedCodes();
			this.stage = 'codes';
		} else if (type === 2) {
			this.dynamicTables();
			this.stage = 'codes';
		} else throw corrupt('invalid block type');
		this.last = last === 1;
	}

	dynamicTables() {
		const literalCount = this.bits(5) + 257;
		const distanceCount = this.bits(5) + 1;
		const codeLengthCount = this.bits(4) + 4;

		if (literalCount > 286 || distanceCount > 30)
			throw corrupt('too many length or distance symbols');
		const codeLengths = new Uint8Array(19);

		for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = this.bits(3);
		const codeLengthCode = huffmanTable(codeLengths, 'code lengths set');

		if (codeLengthCode === null) throw corrupt('invalid code lengths set');
		const lengths = new Uint8Array(literalCount + distanceCount);
		let index = 0;

		while (index < lengths.length) {
			const symbol = this.symbol(codeLengthCode);

			if (symbol < 16) {
				lengths[index++] = symbol;
				continue;
			}
			let repeat;
			let value = 0;

			if (symbol === 16) {
				if (index === 0) throw corrupt('invalid bit length repeat');
				value = lengths[index - 1];
				repeat = 3 + this.bits(2);
			} else repeat = symbol === 17 ? 3 + this.bits(3) : 11 + this.bits(7);

			if (index + repeat > lengths.length) throw corrupt('invalid bit length repeat');

			while (repeat-- > 0) lengths[index++] = value;
		}

		if (lengths[256] === 0) throw corrupt('invalid code -- missing end-of-block');
		this.lengths = huffmanTable(lengths.subarray(0, literalCount), 'literal/lengths set');
		this.distances = huffmanTable(lengths.subarray(literalCount), 'distances set');
	}

	/** As much of a stored block as the input has (at least one byte, or the block's end). */
	storedRun() {
		if (this.storedLeft > 0) {
			const at = this.bit >> 3;
			const count = Math.min(this.storedLeft, this.input.length - at);

			if (count === 0) throw NEED_INPUT;
			this.reserve(count);
			this.out.set(this.input.subarray(at, at + count), this.outLength);
			this.outLength += count;
			this.bit += count * 8;
			this.storedLeft -= count;

			return;
		}
		this.endBlock();
	}

	/** One literal, length and distance pair, or the end of the block. */
	codes() {
		const symbol = this.symbol(this.lengths);

		if (symbol < 256) {
			this.reserve(1);
			this.out[this.outLength++] = symbol;

			return;
		}

		if (symbol === 256) {
			this.endBlock();

			return;
		}

		if (symbol > 285) throw corrupt('invalid literal/length code');
		const length = LENGTH_BASE[symbol - 257] + this.bits(LENGTH_EXTRA[symbol - 257]);

		if (this.distances === null) throw corrupt('invalid distance code');
		const code = this.symbol(this.distances);

		if (code > 29) throw corrupt('invalid distance code');
		const distance = DIST_BASE[code] + this.bits(DIST_EXTRA[code]);

		if (distance > this.outLength) throw corrupt('invalid distance too far back');
		this.reserve(length);
		const out = this.out;
		let from = this.outLength - distance;
		let to = this.outLength;

		for (let i = 0; i < length; i++) out[to++] = out[from++];
		this.outLength = to;
	}

	endBlock() {
		this.stage = this.last ? (this.format === 'deflate-raw' ? 'done' : 'trailer') : 'block';

		if (this.stage === 'done') this.align();
	}

	trailer() {
		// the checksums cover everything decompressed, up to here
		this.align();
		const length = this.format === 'gzip' ? 8 : 4;

		if (this.input.length - (this.bit >> 3) < length) throw NEED_INPUT;
		const at = this.bit >> 3;
		const input = this.input;
		const { out, emitted, outLength } = this;

		if (this.format === 'gzip') {
			const check = crc32(this.check, out, emitted, outLength);
			const crc =
				(input[at] | (input[at + 1] << 8) | (input[at + 2] << 16) | (input[at + 3] << 24)) >>> 0;
			const size =
				(input[at + 4] | (input[at + 5] << 8) | (input[at + 6] << 16) | (input[at + 7] << 24)) >>>
				0;

			if (crc !== check) throw corrupt('incorrect data check');

			if (size !== (this.total + outLength - emitted) >>> 0)
				throw corrupt('incorrect length check');
		} else {
			const check = adler32(this.check, out, emitted, outLength);
			const adler =
				((input[at] << 24) | (input[at + 1] << 16) | (input[at + 2] << 8) | input[at + 3]) >>> 0;

			if (adler !== check) throw corrupt('incorrect data check');
		}
		this.bit += length * 8;
		this.stage = 'done';
	}
}
