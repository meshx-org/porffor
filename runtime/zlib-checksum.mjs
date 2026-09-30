// The checksums the compression formats carry, and what CompressionStream and
// DecompressionStream share: Adler-32 (RFC 1950, 'deflate') and CRC-32 (RFC 1952, 'gzip'),
// both updated a chunk at a time, and the checks on a format and a chunk.

/** The CRC-32 table (the reflected polynomial 0xedb88320), built on first use. */
let crcTable;

function buildCrcTable() {
	const table = new Int32Array(256);

	for (let n = 0; n < 256; n++) {
		let c = n;

		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}

	return table;
}

/**
 * CRC-32 of `bytes[start, end)`, continued from `crc` (0 to begin).
 * @param {number} crc
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
export function crc32(crc, bytes, start, end) {
	if (crcTable === undefined) crcTable = buildCrcTable();
	const table = crcTable;
	let c = ~crc;

	for (let i = start; i < end; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);

	return ~c >>> 0;
}

/**
 * Adler-32 of `bytes[start, end)`, continued from `adler` (1 to begin).
 * @param {number} adler
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
export function adler32(adler, bytes, start, end) {
	let a = adler & 0xffff;
	let b = adler >>> 16;
	let i = start;

	while (i < end) {
		// 5552 bytes keep the sums below 2^32 before the modulo (zlib's NMAX)
		const stop = Math.min(end, i + 5552);

		for (; i < stop; i++) {
			a += bytes[i];
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}

	return ((b << 16) | a) >>> 0;
}

/** The formats both streams take ('brotli' is not here). */
const FORMATS = ['deflate', 'deflate-raw', 'gzip'];

/**
 * The CompressionFormat enum: `format` as a string, a TypeError unless it is one of them.
 * @param {unknown} format
 * @param {string} owner
 */
export function compressionFormat(format, owner) {
	const name = String(format);

	if (!FORMATS.includes(name))
		throw new TypeError(`${owner}: unsupported compression format '${name}'`);

	return name;
}

/**
 * A chunk as bytes: an ArrayBuffer or an ArrayBufferView (not a shared one), viewed as a
 * Uint8Array over the same memory; a TypeError for anything else.
 * @param {unknown} chunk
 * @param {string} owner
 */
export function chunkBytes(chunk, owner) {
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);

	if (ArrayBuffer.isView(chunk) && chunk.buffer instanceof ArrayBuffer)
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

	throw new TypeError(`${owner}: the chunk is not an ArrayBuffer or ArrayBufferView`);
}
