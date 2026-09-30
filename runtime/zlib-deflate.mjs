// A streaming deflater for CompressionStream: DEFLATE (RFC 1951) in a zlib wrapper
// ('deflate', RFC 1950), a gzip member ('gzip', RFC 1952) or bare ('deflate-raw'), a chunk
// at a time. Each chunk becomes one block: LZ77 matches (hash chains over a 32 KiB window
// that reaches back into earlier chunks) coded with the fixed Huffman codes, or stored when
// that comes out smaller (incompressible input). Output a decoder can read to the end of
// every chunk; finish() adds the last, empty block and the trailer.

import { adler32, crc32 } from './zlib-checksum.mjs';

/** How far back a match may reach (32 KiB), and the longest and shortest match. */
const WINDOW = 32768;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
/** How many earlier positions with the same hash a match search looks at. */
const MAX_CHAIN = 16;
const HASH_BITS = 15;

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

/** The length symbol (257–285) for each match length (3–258), built on first use. */
let lengthCodes;
/** The distance symbol for each distance: 1–256 directly, 257–32768 by (distance - 1) >> 7. */
let distanceCodes;

function buildCodes() {
	lengthCodes = new Uint16Array(MAX_MATCH + 1);

	for (let code = 0; code < 29; code++) {
		const end = code === 28 ? MAX_MATCH + 1 : LENGTH_BASE[code + 1];

		// (not named length: Porffor reads a let `length` as a key like .length)
		for (let size = LENGTH_BASE[code]; size < end; size++) lengthCodes[size] = code;
	}
	// 258 has its own code, though 227 + 31 would reach it
	lengthCodes[MAX_MATCH] = 28;
	distanceCodes = new Uint8Array(512);

	for (let code = 0; code < 30; code++) {
		const end = code === 29 ? WINDOW + 1 : DIST_BASE[code + 1];

		for (let distance = DIST_BASE[code]; distance < end; distance++)
			if (distance <= 256) distanceCodes[distance - 1] = code;
			else distanceCodes[256 + ((distance - 1) >> 7)] = code;
	}
}

const distanceCode = (distance) =>
	distance <= 256 ? distanceCodes[distance - 1] : distanceCodes[256 + ((distance - 1) >> 7)];

/** Bits out, least significant first, into a growing byte buffer. */
class BitWriter {
	constructor() {
		this.bytes = new Uint8Array(1024);
		this.length = 0;
		this.value = 0;
		this.count = 0;
	}

	/** `count` bits of `value` (up to 16), least significant first. */
	write(value, count) {
		this.value |= value << this.count;
		this.count += count;

		while (this.count >= 8) {
			this.byte(this.value & 0xff);
			this.value >>>= 8;
			this.count -= 8;
		}
	}

	/** A Huffman code: its bits most significant first. */
	code(code, bits) {
		let reversed = 0;

		for (let bit = 0; bit < bits; bit++) reversed |= ((code >> bit) & 1) << (bits - 1 - bit);
		this.write(reversed, bits);
	}

	byte(value) {
		if (this.length === this.bytes.length) {
			const grown = new Uint8Array(this.bytes.length * 2);

			grown.set(this.bytes, 0);
			this.bytes = grown;
		}
		this.bytes[this.length++] = value;
	}

	/** Pads the bits to a whole byte. */
	align() {
		if (this.count > 0) this.write(0, 8 - this.count);
	}

	/** The whole bytes written since the last take. */
	take() {
		const out = this.bytes.slice(0, this.length);

		this.length = 0;

		return out;
	}
}

/** A literal or length symbol with the fixed code (RFC 1951 3.2.6). */
function fixedLiteral(writer, symbol) {
	if (symbol < 144) writer.code(0x30 + symbol, 8);
	else if (symbol < 256) writer.code(0x190 + symbol - 144, 9);
	else if (symbol < 280) writer.code(symbol - 256, 7);
	else writer.code(0xc0 + symbol - 280, 8);
}

/** Deflates one stream of a format, a chunk at a time. */
export class Deflater {
	/** @param {'deflate' | 'deflate-raw' | 'gzip'} format */
	constructor(format) {
		if (lengthCodes === undefined) buildCodes();
		this.format = format;
		this.writer = new BitWriter();
		this.check = format === 'gzip' ? 0 : 1;
		this.total = 0;
		// the last WINDOW bytes of input, which a match may reach back into
		this.history = new Uint8Array(0);

		if (format === 'deflate') {
			this.writer.byte(0x78);
			this.writer.byte(0x9c);
		} else if (format === 'gzip')
			for (const byte of [31, 139, 8, 0, 0, 0, 0, 0, 0, 255]) this.writer.byte(byte);
	}

	/**
	 * Takes a chunk of input: the compressed bytes so far (a whole block for it).
	 * @param {Uint8Array} chunk
	 */
	push(chunk) {
		if (chunk.length === 0) return this.writer.take();

		if (this.format === 'gzip') this.check = crc32(this.check, chunk, 0, chunk.length);
		else if (this.format === 'deflate') this.check = adler32(this.check, chunk, 0, chunk.length);
		this.total = (this.total + chunk.length) >>> 0;
		const data = new Uint8Array(this.history.length + chunk.length);

		data.set(this.history, 0);
		data.set(chunk, this.history.length);
		this.block(data, this.history.length, false);
		this.history = data.slice(Math.max(0, data.length - WINDOW));

		return this.writer.take();
	}

	/** The last block and the trailer. */
	finish() {
		const writer = this.writer;

		// a last, empty block with the fixed codes: its header and the end-of-block code
		writer.write(1, 1);
		writer.write(1, 2);
		fixedLiteral(writer, 256);
		writer.align();
		const check = this.check;

		if (this.format === 'deflate')
			for (const shift of [24, 16, 8, 0]) writer.byte((check >>> shift) & 0xff);
		else if (this.format === 'gzip') {
			for (const shift of [0, 8, 16, 24]) writer.byte((check >>> shift) & 0xff);

			for (const shift of [0, 8, 16, 24]) writer.byte((this.total >>> shift) & 0xff);
		}

		return writer.take();
	}

	/**
	 * A block of `data[start, end)` (earlier bytes are the window): the fixed codes, or a
	 * stored block when they would be bigger.
	 */
	block(data, start, last) {
		const symbols = this.matches(data, start);
		// the fixed-code size in bits, against a stored block's
		let bits = 3 + 7;

		for (let i = 0; i < symbols.length; i += 2) {
			const matchLength = symbols[i];

			if (matchLength === 0) bits += symbols[i + 1] < 144 ? 8 : 9;
			else {
				const code = lengthCodes[matchLength];
				const distance = distanceCode(symbols[i + 1]);

				bits += (code + 257 < 280 ? 7 : 8) + LENGTH_EXTRA[code] + 5 + DIST_EXTRA[distance];
			}
		}
		const size = data.length - start;
		const storedBits = Math.ceil(size / 65535) * 40 + size * 8 + 8;

		if (storedBits < bits) this.stored(data, start, last);
		else this.fixed(symbols, last);
	}

	/** Stored blocks (65535 bytes at most each). */
	stored(data, start, last) {
		const writer = this.writer;

		for (let at = start; at < data.length;) {
			const blockLength = Math.min(65535, data.length - at);
			const final = last && at + blockLength === data.length;

			writer.write(final ? 1 : 0, 1);
			writer.write(0, 2);
			writer.align();
			writer.write(blockLength & 0xff, 8);
			writer.write(blockLength >> 8, 8);
			writer.write(~blockLength & 0xff, 8);
			writer.write((~blockLength >> 8) & 0xff, 8);

			for (let i = 0; i < blockLength; i++) writer.byte(data[at + i]);
			at += blockLength;
		}
	}

	/** A block with the fixed codes, of the symbols matches() found. */
	fixed(symbols, last) {
		const writer = this.writer;

		writer.write(last ? 1 : 0, 1);
		writer.write(1, 2);

		for (let i = 0; i < symbols.length; i += 2) {
			const matchLength = symbols[i];

			if (matchLength === 0) {
				fixedLiteral(writer, symbols[i + 1]);
				continue;
			}
			const distance = symbols[i + 1];
			const code = lengthCodes[matchLength];
			const dcode = distanceCode(distance);

			fixedLiteral(writer, code + 257);

			if (LENGTH_EXTRA[code] > 0) writer.write(matchLength - LENGTH_BASE[code], LENGTH_EXTRA[code]);
			writer.code(dcode, 5);

			if (DIST_EXTRA[dcode] > 0) writer.write(distance - DIST_BASE[dcode], DIST_EXTRA[dcode]);
		}
		fixedLiteral(writer, 256);
	}

	/**
	 * LZ77 over `data[start, end)`: pairs of [0, literal] or [length, distance], the longest
	 * match among the last MAX_CHAIN positions with the same three-byte hash.
	 */
	matches(data, start) {
		const end = data.length;
		const head = new Int32Array(1 << HASH_BITS).fill(-1);
		const previous = new Int32Array(end);
		const out = [];
		const hash = (at) =>
			((data[at] << 10) ^ (data[at + 1] << 5) ^ data[at + 2]) & ((1 << HASH_BITS) - 1);
		const insert = (at) => {
			if (at + MIN_MATCH > end) return;
			const h = hash(at);

			previous[at] = head[h];
			head[h] = at;
		};

		for (let at = 0; at < start; at++) insert(at);
		let at = start;

		while (at < end) {
			let bestLength = 0;
			let bestDistance = 0;

			if (at + MIN_MATCH <= end) {
				const limit = Math.min(MAX_MATCH, end - at);
				let candidate = head[hash(at)];
				let chain = MAX_CHAIN;

				while (candidate >= 0 && at - candidate <= WINDOW && chain-- > 0) {
					if (data[candidate + bestLength] === data[at + bestLength]) {
						let matchLength = 0;

						while (matchLength < limit && data[candidate + matchLength] === data[at + matchLength])
							matchLength++;

						if (matchLength > bestLength) {
							bestLength = matchLength;
							bestDistance = at - candidate;

							if (matchLength === limit) break;
						}
					}
					candidate = previous[candidate];
				}
			}

			if (bestLength >= MIN_MATCH) {
				out.push(bestLength, bestDistance);

				for (let i = 0; i < bestLength; i++) insert(at + i);
				at += bestLength;
			} else {
				out.push(0, data[at]);
				insert(at);
				at++;
			}
		}

		return out;
	}
}
