// Native (libuv) randomness: porffor:random. uv_random with no loop is synchronous: it reads the
// platform's CSPRNG (getrandom, getentropy, /dev/urandom) into the bytes in one call, of any
// length, where crypto.getRandomValues stops at 65536. runtime/host/wasi/random.mjs is the same
// over wasi:random.
import '../c.mjs';

Porffor.c`
#include <uv.h>

// a Uint8Array's own bytes (its buffer's, from its byte offset), and how many
static uint8_t *__porffor_random_u8(u8 *memory, jsval value, size_t *len) {
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  *len = (size_t)*((i32*)(memory + ptr));
  return (uint8_t*)(memory + *((u32*)(memory + ptr + 4)) + 4);
}
`;

/**
 * Fills a Uint8Array with random bytes from the platform's CSPRNG, and returns it.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function fill(bytes) {
	let rc = 0;
	Porffor.c`
{
size_t n;
uint8_t *data = __porffor_random_u8(MEM, ${bytes}, &n);
${rc} = n > 0 ? uv_random(NULL, NULL, data, n, 0, NULL) : 0;
}
`;
	if (rc !== 0) throw new Error(`porffor: no random bytes from the platform (uv_random: ${rc})`);
	return bytes;
}
