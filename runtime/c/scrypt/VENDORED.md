# Vendored: scrypt reference implementation

Colin Percival's reference scrypt and the libcperciva pieces it includes, from
[Tarsnap/scrypt](https://github.com/Tarsnap/scrypt) at `cbdef576b8d4640e86b208fa3f063d4ec449110a`
(1.3.3-18), BSD-2-Clause (`COPYRIGHT`). The files are unmodified.

| File                                                                      | From                      |
| ------------------------------------------------------------------------- | ------------------------- |
| `crypto_scrypt-ref.c`                                                     | `runtime/crypto/`         |
| `crypto_scrypt.h`                                                         | `lib-platform/crypto/`    |
| `sha256.c`, `sha256.h`, `sha256_arm.h`, `sha256_shani.h`, `sha256_sse2.h` | `libcperciva/alg/`        |
| `sysendian.h`, `insecure_memzero.c`, `insecure_memzero.h`, `warnp.h`      | `libcperciva/util/`       |
| `cpusupport.h`                                                            | `libcperciva/cpusupport/` |

Built without any `CPUSUPPORT_*` define, so SHA-256 is the portable C code. `warnp.h` is only
included, never called, so `warnp.c` is not here.

A guest gets this only when its code imports `@noble/hashes`' `scrypt.js`: `scripts/bundle.mjs`
points that module at `runtime/scrypt.mjs` and writes `natives.json`, and `src/build.mjs` compiles
these three `.c` files for that guest alone. Output matches Node's `crypto.scrypt` (RFC 7914's
vectors and better-auth's parameters, N=16384 r=16 p=1).

To update: copy the same files from a newer Tarsnap/scrypt checkout, update the commit above, and
build a guest that hashes a password.
