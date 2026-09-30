// PBKDF2 for the Web Crypto shim (https://w3c.github.io/webcrypto/#pbkdf2): RFC 8018's PBKDF2
// with HMAC over SHA-1, SHA-256, SHA-384 or SHA-512, in C (Porffor.c). A password hash runs to
// hundreds of thousands of HMACs, and @noble/hashes' JavaScript under Porffor takes seconds for
// 100000 iterations (SHA-512: ~8 s) where this C takes milliseconds. Loaded
// (runtime/globals.json) only into a program that names 'PBKDF2'.

import { registerKdf } from './crypto-kdf.mjs';
import { operationError } from './crypto-util.mjs';

Porffor.c`
#include <stdint.h>
#include <string.h>

// a number JS handed the C, whether Porffor passes it as a jsval or (knowing its type) a double
static inline double porf_pbkdf2_num_jv(jsval v) { return v.val; }
static inline double porf_pbkdf2_num_f64(double v) { return v; }
#define PORF_PBKDF2_NUM(x) _Generic((x), jsval: porf_pbkdf2_num_jv, default: porf_pbkdf2_num_f64)(x)

// a Uint8Array's bytes (from its buffer's start: the JS passes arrays of their own) and how many
static uint8_t *porf_pbkdf2_bytes(u8 *memory, jsval value, size_t *len) {
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  *len = (size_t)*((i32*)(memory + ptr));
  return (uint8_t*)(memory + *((u32*)(memory + ptr + 4)) + 4);
}

// SHA-1 (bits 1), SHA-256, SHA-384 and SHA-512 (FIPS 180-4), as one streaming context
typedef struct {
  int bits;
  uint32_t h32[8];
  uint64_t h64[8];
  uint8_t buf[128];
  uint32_t fill;
  uint64_t total;
} porf_sha;

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define ROL32(x, n) (((x) << (n)) | ((x) >> (32 - (n))))
#define ROR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

static const uint32_t porf_k256[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

static const uint64_t porf_k512[80] = {
  0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
  0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
  0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
  0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
  0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
  0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
  0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
  0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
  0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
  0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
  0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
  0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
  0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
  0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
  0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
  0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
  0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
  0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
  0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
  0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL
};

static uint32_t porf_be32(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static uint64_t porf_be64(const uint8_t *p) {
  return ((uint64_t)porf_be32(p) << 32) | porf_be32(p + 4);
}

static void porf_sha_block(porf_sha *s, const uint8_t *p) {
  if (s->bits == 1) {
    uint32_t w[80], a = s->h32[0], b = s->h32[1], c = s->h32[2], d = s->h32[3], e = s->h32[4];
    for (int i = 0; i < 16; i++) w[i] = porf_be32(p + i * 4);
    for (int i = 16; i < 80; i++) w[i] = ROL32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      uint32_t t = ROL32(a, 5) + f + e + k + w[i];
      e = d; d = c; c = ROL32(b, 30); b = a; a = t;
    }
    s->h32[0] += a; s->h32[1] += b; s->h32[2] += c; s->h32[3] += d; s->h32[4] += e;
  } else if (s->bits == 256) {
    uint32_t w[64], v[8];
    for (int i = 0; i < 16; i++) w[i] = porf_be32(p + i * 4);
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    for (int i = 0; i < 8; i++) v[i] = s->h32[i];
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = v[7] + (ROR32(v[4], 6) ^ ROR32(v[4], 11) ^ ROR32(v[4], 25)) +
        ((v[4] & v[5]) ^ (~v[4] & v[6])) + porf_k256[i] + w[i];
      uint32_t t2 = (ROR32(v[0], 2) ^ ROR32(v[0], 13) ^ ROR32(v[0], 22)) +
        ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
      v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1;
      v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
    }
    for (int i = 0; i < 8; i++) s->h32[i] += v[i];
  } else {
    uint64_t w[80], v[8];
    for (int i = 0; i < 16; i++) w[i] = porf_be64(p + i * 8);
    for (int i = 16; i < 80; i++) {
      uint64_t s0 = ROR64(w[i - 15], 1) ^ ROR64(w[i - 15], 8) ^ (w[i - 15] >> 7);
      uint64_t s1 = ROR64(w[i - 2], 19) ^ ROR64(w[i - 2], 61) ^ (w[i - 2] >> 6);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    for (int i = 0; i < 8; i++) v[i] = s->h64[i];
    for (int i = 0; i < 80; i++) {
      uint64_t t1 = v[7] + (ROR64(v[4], 14) ^ ROR64(v[4], 18) ^ ROR64(v[4], 41)) +
        ((v[4] & v[5]) ^ (~v[4] & v[6])) + porf_k512[i] + w[i];
      uint64_t t2 = (ROR64(v[0], 28) ^ ROR64(v[0], 34) ^ ROR64(v[0], 39)) +
        ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
      v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1;
      v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
    }
    for (int i = 0; i < 8; i++) s->h64[i] += v[i];
  }
}

static uint32_t porf_sha_block_len(int bits) { return bits >= 384 ? 128 : 64; }
static uint32_t porf_sha_out_len(int bits) { return bits == 1 ? 20 : (uint32_t)bits / 8; }

static void porf_sha_init(porf_sha *s, int bits) {
  static const uint32_t iv1[5] = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
  static const uint32_t iv256[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
  static const uint64_t iv384[8] = { 0xcbbb9d5dc1059ed8ULL, 0x629a292a367cd507ULL,
    0x9159015a3070dd17ULL, 0x152fecd8f70e5939ULL, 0x67332667ffc00b31ULL, 0x8eb44a8768581511ULL,
    0xdb0c2e0d64f98fa7ULL, 0x47b5481dbefa4fa4ULL };
  static const uint64_t iv512[8] = { 0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL,
    0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL, 0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
    0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL };
  memset(s, 0, sizeof(*s));
  s->bits = bits;
  if (bits == 1) memcpy(s->h32, iv1, sizeof(iv1));
  else if (bits == 256) memcpy(s->h32, iv256, sizeof(iv256));
  else memcpy(s->h64, bits == 384 ? iv384 : iv512, sizeof(iv512));
}

static void porf_sha_update(porf_sha *s, const uint8_t *data, size_t len) {
  uint32_t block = porf_sha_block_len(s->bits);
  s->total += len;
  while (len > 0) {
    uint32_t take = block - s->fill;
    if (take > len) take = (uint32_t)len;
    memcpy(s->buf + s->fill, data, take);
    s->fill += take;
    data += take;
    len -= take;
    if (s->fill == block) {
      porf_sha_block(s, s->buf);
      s->fill = 0;
    }
  }
}

static void porf_sha_final(porf_sha *s, uint8_t *out) {
  uint32_t block = porf_sha_block_len(s->bits);
  uint32_t length_bytes = block == 128 ? 16 : 8;
  uint64_t bits = s->total * 8;
  uint8_t pad[144] = { 0x80 };
  uint32_t padding = (s->fill < block - length_bytes ? block : 2 * block) - s->fill - length_bytes;
  for (int i = 0; i < 8; i++) pad[padding + length_bytes - 1 - i] = (uint8_t)(bits >> (i * 8));
  porf_sha_update(s, pad, padding + length_bytes);
  uint32_t n = porf_sha_out_len(s->bits);
  for (uint32_t i = 0; i < n; i++) {
    if (s->bits <= 256) out[i] = (uint8_t)(s->h32[i / 4] >> (24 - (i % 4) * 8));
    else out[i] = (uint8_t)(s->h64[i / 8] >> (56 - (i % 8) * 8));
  }
}

// PBKDF2-HMAC: the HMAC's keyed inner and outer states are made once and copied per block
static void porf_pbkdf2(int bits, const uint8_t *pw, size_t pw_len, const uint8_t *salt,
    size_t salt_len, uint32_t iterations, uint8_t *out, size_t out_len) {
  uint32_t block = porf_sha_block_len(bits), hlen = porf_sha_out_len(bits);
  uint8_t key[128] = { 0 }, pad[128], u[64], t[64], counter[4];
  porf_sha inner, outer, work;
  if (pw_len > block) {
    porf_sha_init(&work, bits);
    porf_sha_update(&work, pw, pw_len);
    porf_sha_final(&work, key);
  } else if (pw_len > 0) memcpy(key, pw, pw_len);
  for (uint32_t i = 0; i < block; i++) pad[i] = key[i] ^ 0x36;
  porf_sha_init(&inner, bits);
  porf_sha_update(&inner, pad, block);
  for (uint32_t i = 0; i < block; i++) pad[i] = key[i] ^ 0x5c;
  porf_sha_init(&outer, bits);
  porf_sha_update(&outer, pad, block);
  for (uint32_t index = 1, at = 0; at < out_len; index++) {
    counter[0] = (uint8_t)(index >> 24); counter[1] = (uint8_t)(index >> 16);
    counter[2] = (uint8_t)(index >> 8); counter[3] = (uint8_t)index;
    work = inner;
    porf_sha_update(&work, salt, salt_len);
    porf_sha_update(&work, counter, 4);
    porf_sha_final(&work, u);
    work = outer;
    porf_sha_update(&work, u, hlen);
    porf_sha_final(&work, u);
    memcpy(t, u, hlen);
    for (uint32_t round = 1; round < iterations; round++) {
      work = inner;
      porf_sha_update(&work, u, hlen);
      porf_sha_final(&work, u);
      work = outer;
      porf_sha_update(&work, u, hlen);
      porf_sha_final(&work, u);
      for (uint32_t i = 0; i < hlen; i++) t[i] ^= u[i];
    }
    size_t take = out_len - at < hlen ? out_len - at : hlen;
    memcpy(out + at, t, take);
    at += take;
  }
}
`;

/** The C's name for each hash: SHA-1 is 1, the others their bits. */
const HASH_BITS = { 'SHA-1': 1, 'SHA-256': 256, 'SHA-384': 384, 'SHA-512': 512 };

/** PBKDF2 of the password and salt into out (Uint8Arrays of their own). */
function pbkdf2Into(bits, password, salt, iterations, out) {
	Porffor.c`
{
size_t pw_len, salt_len, out_len;
uint8_t *pw_bytes = porf_pbkdf2_bytes(MEM, ${password}, &pw_len);
uint8_t *salt_bytes = porf_pbkdf2_bytes(MEM, ${salt}, &salt_len);
uint8_t *out_bytes = porf_pbkdf2_bytes(MEM, ${out}, &out_len);
porf_pbkdf2((int)PORF_PBKDF2_NUM(${bits}), pw_bytes, pw_len, salt_bytes, salt_len,
  (uint32_t)PORF_PBKDF2_NUM(${iterations}), out_bytes, out_len);
}
`;
}

registerKdf(
	'PBKDF2',
	{ hash: 'hash!', iterations: 'ulong!', salt: 'buffer!' },
	(algorithm, secret, bytes) => {
		const out = new Uint8Array(bytes);

		// (copies: the C reads each array from its buffer's start)
		pbkdf2Into(
			HASH_BITS[algorithm.hash.name],
			secret.slice(),
			algorithm.salt.slice(),
			algorithm.iterations,
			out
		);

		return out;
	},
	(algorithm) => {
		if (algorithm.iterations === 0) throw operationError('PBKDF2: iterations cannot be 0');
	}
);
