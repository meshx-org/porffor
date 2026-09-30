// The SHA-3 family's digests for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/): SHA3-256, SHA3-384 and SHA3-512, and the
// extendable-output cSHAKE128/256 (SP 800-185), TurboSHAKE128/256 and KangarooTwelve (KT128,
// KT256; RFC 9861), whose digest takes an outputLength in bits. Loaded (runtime/globals.json)
// only into a program that names one of them.
//
// The Keccak sponge is C (Porffor.c): these hash megabytes (KangarooTwelve is made for long
// inputs), and a JavaScript Keccak under Porffor runs at about a megabyte in a few hundred
// milliseconds. The encodings around it (cSHAKE's bytepad, KangarooTwelve's tree) are here.

import { operationError } from './crypto-util.mjs';
import { registerAlgorithm } from './subtle-crypto.mjs';

Porffor.c`
#include <stdint.h>
#include <string.h>

// a number JS handed the C, whether Porffor passes it as a jsval or (knowing its type) a double
static inline double porf_keccak_num_jv(jsval v) { return v.val; }
static inline double porf_keccak_num_f64(double v) { return v; }
#define PORF_KECCAK_NUM(x) _Generic((x), jsval: porf_keccak_num_jv, default: porf_keccak_num_f64)(x)

// a Uint8Array's buffer's bytes (the JS passes arrays of their own, with explicit offsets)
static uint8_t *porf_keccak_bytes(u8 *memory, jsval value) {
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  return (uint8_t*)(memory + *((u32*)(memory + ptr + 4)) + 4);
}

static const uint64_t porf_keccak_rc[24] = {
  0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
  0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
  0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
  0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
  0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
  0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};
static const int porf_keccak_rotc[24] = {
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
};
static const int porf_keccak_piln[24] = {
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
};

#define PORF_ROL64(x, n) (((x) << (n)) | ((x) >> (64 - (n))))

// Keccak-f[1600]'s last rounds (24 for SHA-3 and cSHAKE, 12 for TurboSHAKE)
static void porf_keccakf(uint64_t *s, int rounds) {
  uint64_t c[5], t, b[5];
  for (int round = 24 - rounds; round < 24; round++) {
    for (int x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (int x = 0; x < 5; x++) {
      t = c[(x + 4) % 5] ^ PORF_ROL64(c[(x + 1) % 5], 1);
      for (int y = 0; y < 25; y += 5) s[y + x] ^= t;
    }
    t = s[1];
    for (int i = 0; i < 24; i++) {
      int j = porf_keccak_piln[i];
      uint64_t next = s[j];
      s[j] = PORF_ROL64(t, porf_keccak_rotc[i]);
      t = next;
    }
    for (int y = 0; y < 25; y += 5) {
      for (int x = 0; x < 5; x++) b[x] = s[y + x];
      for (int x = 0; x < 5; x++) s[y + x] = b[x] ^ (~b[(x + 1) % 5] & b[(x + 2) % 5]);
    }
    s[0] ^= porf_keccak_rc[round];
  }
}

// the sponge over a then b, padded with the suffix (its domain bits and the first pad bit)
static void porf_keccak(int rounds, uint32_t rate, uint8_t suffix, const uint8_t *a, size_t a_len,
    const uint8_t *b, size_t b_len, uint8_t *out, size_t out_len) {
  uint64_t s[25];
  uint32_t pos = 0;
  memset(s, 0, sizeof(s));
  for (int part = 0; part < 2; part++) {
    const uint8_t *data = part ? b : a;
    size_t len = part ? b_len : a_len;
    for (size_t i = 0; i < len; i++) {
      s[pos >> 3] ^= (uint64_t)data[i] << (8 * (pos & 7));
      if (++pos == rate) {
        porf_keccakf(s, rounds);
        pos = 0;
      }
    }
  }
  s[pos >> 3] ^= (uint64_t)suffix << (8 * (pos & 7));
  s[(rate - 1) >> 3] ^= (uint64_t)0x80 << (8 * ((rate - 1) & 7));
  porf_keccakf(s, rounds);
  pos = 0;
  for (size_t i = 0; i < out_len; i++) {
    if (pos == rate) {
      porf_keccakf(s, rounds);
      pos = 0;
    }
    out[i] = (uint8_t)(s[pos >> 3] >> (8 * (pos & 7)));
    pos++;
  }
}
`;

/**
 * The Keccak sponge over bytes of a, then of b (arrays with buffers of their own), into out.
 * @param {number} rounds 24, or 12 for TurboSHAKE
 * @param {number} rate in bytes
 * @param {number} suffix the domain bits and the first pad bit (SHA-3's 0x06, SHAKE's 0x1F)
 */
function sponge(rounds, rate, suffix, a, aStart, aLength, b, bStart, bLength, out) {
	const outLength = out.length;

	Porffor.c`
{
uint8_t *a_bytes = porf_keccak_bytes(MEM, ${a}) + (size_t)PORF_KECCAK_NUM(${aStart});
uint8_t *b_bytes = porf_keccak_bytes(MEM, ${b}) + (size_t)PORF_KECCAK_NUM(${bStart});
uint8_t *out_bytes = porf_keccak_bytes(MEM, ${out});
porf_keccak((int)PORF_KECCAK_NUM(${rounds}), (uint32_t)PORF_KECCAK_NUM(${rate}),
  (uint8_t)PORF_KECCAK_NUM(${suffix}), a_bytes, (size_t)PORF_KECCAK_NUM(${aLength}), b_bytes,
  (size_t)PORF_KECCAK_NUM(${bLength}), out_bytes, (size_t)PORF_KECCAK_NUM(${outLength}));
}
`;

	return out;
}

const NOTHING = new Uint8Array(1);

/** The sponge over one byte string (a copy of its own: the C reads from its buffer's start). */
const keccak = (rounds, rate, suffix, data, bytes) =>
	sponge(rounds, rate, suffix, data, 0, data.length, NOTHING, 0, 0, new Uint8Array(bytes));

// --- SP 800-185's encodings ---

/** x as big-endian bytes, as few as it takes (at least one). */
function bigEndian(x) {
	const out = [];

	for (let rest = x; rest > 0 || out.length === 0; rest = Math.floor(rest / 256))
		out.unshift(rest % 256);

	return out;
}

const leftEncode = (x) => {
	const bytes = bigEndian(x);

	return [bytes.length, ...bytes];
};

/** bytepad(encode_string(N) || encode_string(S), rate). */
function bytepad(parts, rate) {
	const out = [...leftEncode(rate)];

	for (const part of parts) out.push(...leftEncode(part.length * 8), ...part);

	while (out.length % rate !== 0) out.push(0);

	return Uint8Array.from(out);
}

/** An extendable-output digest's length in bytes: outputLength must be whole bytes. */
function outputBytes(algorithm) {
	if (algorithm.outputLength % 8 !== 0)
		throw operationError(`${algorithm.name}: the output length must be a multiple of 8`);

	return algorithm.outputLength / 8;
}

// --- the algorithms ---

for (const [name, bits] of [
	['SHA3-256', 256],
	['SHA3-384', 384],
	['SHA3-512', 512]
])
	registerAlgorithm({
		name,
		params: { digest: {} },
		digest: (algorithm, data) => keccak(24, 200 - bits / 4, 0x06, data, bits / 8)
	});

/**
 * Registers an extendable-output digest.
 * @param {string} name
 * @param {Record<string, string>} params its parameters beyond outputLength
 * @param {(data: Uint8Array, bytes: number, algorithm: object) => Uint8Array} hash
 */
function registerXof(name, params, hash) {
	registerAlgorithm({
		name,
		params: { digest: { outputLength: 'ulong!', ...params } },
		digest(algorithm, data) {
			const bytes = outputBytes(algorithm);

			return bytes === 0 ? new Uint8Array(0) : hash(data, bytes, algorithm);
		}
	});
}

for (const [name, rate] of [
	['cSHAKE128', 168],
	['cSHAKE256', 136]
])
	registerXof(
		name,
		{ customization: 'buffer', functionName: 'buffer' },
		(data, bytes, algorithm) => {
			const functionName = algorithm.functionName ?? new Uint8Array(0);
			const customization = algorithm.customization ?? new Uint8Array(0);

			// with neither, cSHAKE is SHAKE
			if (functionName.length === 0 && customization.length === 0)
				return keccak(24, rate, 0x1f, data, bytes);
			const prefix = bytepad([functionName, customization], rate);

			return sponge(
				24,
				rate,
				0x04,
				prefix,
				0,
				prefix.length,
				data,
				0,
				data.length,
				new Uint8Array(bytes)
			);
		}
	);

for (const [name, rate] of [
	['TurboSHAKE128', 168],
	['TurboSHAKE256', 136]
])
	registerXof(name, { domainSeparation: 'octet' }, (data, bytes, algorithm) => {
		const separation = algorithm.domainSeparation ?? 0x1f;

		if (separation < 1 || separation > 0x7f)
			throw operationError(`${name}: the domain separation must be 0x01 to 0x7F`);

		return keccak(12, rate, separation, data, bytes);
	});

const CHUNK = 8192;

/** length_encode(x) (RFC 9861): x's big-endian bytes (none for 0), then how many. */
function lengthEncode(x) {
	const bytes = x === 0 ? [] : bigEndian(x);

	return [...bytes, bytes.length];
}

for (const [name, rate, chainBytes] of [
	['KT128', 168, 32],
	['KT256', 136, 64]
])
	registerXof(name, { customization: 'buffer' }, (data, bytes, algorithm) => {
		const customization = algorithm.customization ?? new Uint8Array(0);
		const suffix = lengthEncode(customization.length);
		// S = M || C || length_encode(|C|)
		const s = new Uint8Array(data.length + customization.length + suffix.length);

		s.set(data);
		s.set(customization, data.length);
		s.set(suffix, data.length + customization.length);

		if (s.length <= CHUNK) return keccak(12, rate, 0x07, s, bytes);
		// the tree: S_0, then each later chunk's chaining value, their count and FF FF
		const chunks = Math.ceil(s.length / CHUNK) - 1;
		const tail = lengthEncode(chunks);
		const node = new Uint8Array(8 + chunks * chainBytes + tail.length + 2);

		node[0] = 0x03;

		for (let i = 1; i <= chunks; i++) {
			const start = i * CHUNK;
			const value = sponge(
				12,
				rate,
				0x0b,
				s,
				start,
				Math.min(CHUNK, s.length - start),
				NOTHING,
				0,
				0,
				new Uint8Array(chainBytes)
			);

			node.set(value, 8 + (i - 1) * chainBytes);
		}
		node.set(tail, 8 + chunks * chainBytes);
		node[node.length - 2] = 0xff;
		node[node.length - 1] = 0xff;

		// S_0 || node, as one sponge
		return sponge(12, rate, 0x06, s, 0, CHUNK, node, 0, node.length, new Uint8Array(bytes));
	});
