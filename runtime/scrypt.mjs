// @noble/hashes' scrypt (scrypt.js), in C: Colin Percival's reference code (runtime/c/scrypt),
// which runs about a hundred times faster than noble's JavaScript does under Porffor
// (N=16384 r=16: ~0.1 s against ~10 s). The build points `@noble/hashes/scrypt.js` here, and
// compiles the C, only for a guest whose code imports it (scripts/bundle.mjs), so a library
// that hashes passwords with noble (better-auth does) gets it without a change.
//
// Same exports, options and checks as noble 2.2.0, so the output and the errors match. Two
// differences: `asyncTick` is accepted and ignored, since the C runs in one go (scryptAsync
// blocks the instance for the hash, ~0.1 s), and `onProgress` is called once, with 1, at
// the end. The work buffer is the C's (malloc and free), outside Porffor's heap.

import { nativeScrypt } from 'wasi-porffor:scrypt-native';

// noble's defaults: dkLen 32, and maxmem 1 GiB + 1 KiB
const DEFAULT_DK_LEN = 32;
const KIB = 1024;
const GIB = 1_073_741_824;
const DEFAULT_MAXMEM = GIB + KIB;
// the block size is 128 * r bytes
const BLOCK_BYTES_PER_R = 128;
// 2^32
const POW32 = 4_294_967_296;
// the bound noble puts on p and dkLen: (2^32 - 1) * 32, a SHA-256 output's bytes
const HASH_BYTES = DEFAULT_DK_LEN;

/**
 * A password or salt as bytes: a string as UTF-8, a Uint8Array as it is.
 * @param {string | Uint8Array} data
 * @param {string} title
 * @returns {Uint8Array}
 */
function inputBytes(data, title) {
	if (typeof data === 'string') return new TextEncoder().encode(data);

	if (!(data instanceof Uint8Array))
		throw new TypeError(`"${title}" expected Uint8Array or string, got ${typeof data}`);

	return data;
}

/**
 * @param {unknown} value
 * @param {string} title
 */
function checkInteger(value, title) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`"${title}" expected integer >= 0, got ${value}`);
}

/**
 * @typedef {object} ScryptOpts
 * @property {number} N CPU and memory cost, a power of 2
 * @property {number} r block size
 * @property {number} p parallelization
 * @property {number} [dkLen] output length in bytes (32)
 * @property {number} [asyncTick] ignored: the C runs in one go
 * @property {number} [maxmem] the most memory the hash may take (1 GiB + 1 KiB)
 * @property {(progress: number) => void} [onProgress] called once, with 1, at the end
 */

/**
 * N a power of 2 up to 2^32, and p and dkLen within RFC 7914's bounds, as noble checks them.
 * @param {number} cost N
 * @param {number} parallelization p
 * @param {number} dkLen
 * @param {number} blockSize 128 * r
 */
function checkRanges(cost, parallelization, dkLen, blockSize) {
	if (cost <= 1 || (cost & (cost - 1)) !== 0 || cost > POW32)
		throw new Error('"N" expected a power of 2, and 2^1 <= N <= 2^32');

	if (parallelization < 1 || parallelization > ((POW32 - 1) * HASH_BYTES) / blockSize)
		throw new Error('"p" expected integer 1..((2^32 - 1) * 32) / (128 * r)');

	if (dkLen < 1 || dkLen > (POW32 - 1) * HASH_BYTES)
		throw new Error('"dkLen" expected integer 1..(2^32 - 1) * 32');
}

/**
 * Checks the options as noble does; the bytes the hash takes (noble's accounting).
 * @param {ScryptOpts} opts
 * @returns {number}
 */
function checkOpts(opts) {
	const { N, r, p, dkLen, asyncTick, maxmem, onProgress } = opts;

	for (const [value, title] of [
		[N, 'N'],
		[r, 'r'],
		[p, 'p'],
		[dkLen, 'dkLen'],
		[asyncTick, 'asyncTick'],
		[maxmem, 'maxmem']
	])
		checkInteger(value, title);

	if (onProgress !== undefined && typeof onProgress !== 'function')
		throw new Error('progressCb must be a function');

	const blockSize = BLOCK_BYTES_PER_R * r;

	checkRanges(N, p, dkLen, blockSize);

	const memUsed = blockSize * (N + p + 1);

	if (memUsed > maxmem)
		throw new Error(
			'"maxmem" limit was hit: memUsed(128*r*(N+p+1))=' + memUsed + ', maxmem=' + maxmem
		);

	return memUsed;
}

/**
 * scrypt (RFC 7914) of `password` with `salt`.
 * @param {string | Uint8Array} password
 * @param {string | Uint8Array} salt
 * @param {ScryptOpts} opts
 * @returns {Uint8Array}
 */
export function scrypt(password, salt, opts) {
	const {
		N,
		r,
		p,
		dkLen = DEFAULT_DK_LEN,
		asyncTick = 0,
		maxmem = DEFAULT_MAXMEM,
		onProgress
	} = opts ?? {};
	const memUsed = checkOpts({ N, r, p, dkLen, asyncTick, maxmem, onProgress });

	const out = new Uint8Array(dkLen);
	const status = nativeScrypt(
		inputBytes(password, 'password'),
		inputBytes(salt, 'salt'),
		N,
		r,
		p,
		out
	);

	// crypto_scrypt returns -1 when it cannot allocate its work buffer or when r * p >= 2^30
	// (noble lets that through); -2 is the bridge refusing an argument that is not a Uint8Array
	if (status !== 0)
		throw new Error(
			status === -1
				? `scrypt: the native hash failed (a ${memUsed}-byte work buffer, or r * p >= 2^30)`
				: `scrypt: the native hash failed (${status})`
		);

	if (onProgress !== undefined) onProgress(1);

	return out;
}

/**
 * scrypt, as a promise. The hash itself runs in one go (see the top of this file).
 * @param {string | Uint8Array} password
 * @param {string | Uint8Array} salt
 * @param {ScryptOpts} opts
 * @returns {Promise<Uint8Array>}
 */
export async function scryptAsync(password, salt, opts) {
	return scrypt(password, salt, opts);
}
