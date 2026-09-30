// scrypt's C (runtime/c/scrypt, Colin Percival's reference code) over Uint8Arrays: what both
// platforms' porffor:scrypt hash with (host/native/scrypt.mjs, host/wasi/scrypt.mjs). A native
// build links the C as an archive (compiler/deps.js), a WASI build compiles it in when the guest
// hashes (wasi/src/build.mjs).
import './c.mjs';

Porffor.c`
int crypto_scrypt(const uint8_t *, size_t, const uint8_t *, size_t, uint64_t, uint32_t, uint32_t, uint8_t *, size_t);

// a Uint8Array's own bytes (its buffer's, from its byte offset), and how many
static uint8_t *__porffor_u8_data(u8 *memory, jsval value, size_t *len) {
  u32 ptr = value.val < 0 ? (u32)(i32)value.val : (u32)value.val;
  *len = (size_t)*((i32*)(memory + ptr));
  return (uint8_t*)(memory + *((u32*)(memory + ptr + 4)) + 4);
}
`;

/**
 * scrypt of password with salt into out (all Uint8Arrays), here and now: 0, or crypto_scrypt's -1
 * (its work buffer could not be allocated, or r * p >= 2^30).
 */
export function hashSync(password, salt, N, r, p, out) {
	let rc = 0;
	Porffor.c`
{
size_t pw_len, salt_len, out_len;
uint8_t *pw_bytes = __porffor_u8_data(MEM, ${password}, &pw_len);
uint8_t *salt_bytes = __porffor_u8_data(MEM, ${salt}, &salt_len);
uint8_t *out_bytes = __porffor_u8_data(MEM, ${out}, &out_len);
${rc} = crypto_scrypt(pw_bytes, pw_len, salt_bytes, salt_len, (uint64_t)PORF_NUM(${N}),
  (uint32_t)PORF_NUM(${r}), (uint32_t)PORF_NUM(${p}), out_bytes, out_len);
}
`;
	return rc;
}
