// WASI randomness: porffor:random, over the crypto.getRandomValues Porffor builds in (wasi-libc's
// getentropy, which reaches wasi:random/random's get-random-bytes), 65536 bytes at a time: its
// limit per call. runtime/host/native/random.mjs is the same over libuv's uv_random.

// crypto.getRandomValues' limit, in bytes
const QUOTA = 65536;

/**
 * Fills a Uint8Array with random bytes from the platform's CSPRNG, and returns it.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function fill(bytes) {
	for (let at = 0; at < bytes.length; at += QUOTA)
		crypto.getRandomValues(bytes.subarray(at, Math.min(at + QUOTA, bytes.length)));
	return bytes;
}
