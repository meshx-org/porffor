# Vendored: Mbed TLS

[Mbed TLS](https://github.com/Mbed-TLS/mbedtls) 3.6.7, the 3.6 LTS branch, from the release
tarball `mbedtls-3.6.7.tar.bz2`
(<https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2>,
tag `mbedtls-3.6.7`, SHA-256 `a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6`,
matching the release's `mbedtls-3.6.7-sha256sum.txt`). Apache-2.0 OR GPL-2.0-or-later
(`LICENSE`); Porffor takes it under Apache-2.0.

Kept, unmodified: `include/` (the `mbedtls/` and `psa/` headers, without its CMakeLists.txt),
`library/*.c` and `library/*.h` (the tarball ships the generated files: `error.c`,
`ssl_debug_helpers_generated.c`, `psa_crypto_driver_wrappers*.{c,h}`), and `LICENSE`. Left out:
`3rdparty/` (Everest and p256-m, off in the configuration), `programs/`, `tests/`, `framework/`,
`scripts/`, `docs/`, `configs/`, `visualc/` and the build files.

Ours: `include/porffor_config.h`, read after the default `mbedtls_config.h`
(`MBEDTLS_USER_CONFIG_FILE`). It trims the library to what an HTTPS client needs: no server
side, DTLS, renegotiation, PSK or non-ECDHE TLS 1.2 key exchanges, legacy ciphers (Camellia,
ARIA, DES) and curves, CRL / CSR / certificate writing, debug layer, self tests, or PSA
persistent key storage. TLS 1.2 (ECDHE with AES-GCM, AES-CBC, ChaCha20-Poly1305) and TLS 1.3
stay. `sources.json` defines `MBEDTLS_USER_CONFIG_FILE` for the library build and names the
header under `config`, so a change to it rebuilds the cached archive (`compiler/deps.js`);
`runtime/host/native/http.mjs` defines it too before its includes, as the two must agree.

`runtime/host/native/http.mjs` (`porffor:http`, which `runtime/fetch.mjs` sends through) calls it
for https: one shared client configuration (CTR-DRBG over the platform entropy, the system's
roots from `SSL_CERT_FILE` / `SSL_CERT_DIR` or the usual bundle paths, peer verification
required, ALPN `http/1.1`), a context per connection with the host as SNI and verified name, and
I/O callbacks over buffers libuv fills and drains, never a socket. A native build with the
runtime (`--runtime`) links every `library/*.c` as a cached archive; a program that never
fetches links none of it, and one that does carries about 230 KB of it (arm64 macOS, -O2).
WASI builds do not use it: a component's fetch goes through `wasi:http`, whose host does TLS.

To update: download a newer 3.6.x release tarball, check its SHA-256 against the release's
sum file, replace `include/` (keeping `porffor_config.h`), `library/*.{c,h}` and `LICENSE`,
regenerate `common` in `sources.json` from `library/*.c`, update the version, URL and hash
above, then fetch over https natively (a good host, and self-signed / expired / wrong-host ones
from badssl.com that must fail).
