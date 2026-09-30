# Vendored: llhttp

[llhttp](https://github.com/nodejs/llhttp) `v9.4.3` (tag `release/v9.4.3`, commit
`0e815792b167a9bd8ace259b95b7da953776c288`), MIT (`LICENSE`). Node's HTTP/1.1 parser, from the
release tarball <https://github.com/nodejs/llhttp/archive/refs/tags/release/v9.4.3.tar.gz>
(SHA-256 `1eb813c7437b31a87496a1cd3ed79f00746720f5e7e29c79b42c02cb69f36c39`). A release ships the C
that llparse generates, so no build step is needed.

Kept, unmodified: `src/llhttp.c` (the generated parser), `src/api.c` and `src/http.c` (its API and
the callbacks it is built with), `include/llhttp.h`, and `LICENSE`. Left out: `LICENSE-MIT` (the
same license, worded differently), the CMake, gyp and pkg-config build files, and `README.md`.

The native server (`runtime/host/native/http-server.mjs`, `porffor:http-server`) parses requests
with it: one parser per connection, fed what each read brings, its callbacks copying the request
head and body out, and stopped (`HPE_PAUSED`) after each message so pipelined requests are
answered in order. `sources.json` lists what to compile; the compiler builds it once into a cached
archive (`compiler/deps.js`) and links it into programs built with the runtime. An archive only
brings in what the program calls, so a program that does not serve carries none of it.

The fetch client (`runtime/host/native/http.mjs`) still parses responses in JS. It could use the
same library with an `HTTP_RESPONSE` parser: the head and body callbacks the server has, plus
`llhttp_finish` for a body that ends with the connection, and `on_headers_complete` returning 1 for
a HEAD request's response (no body, whatever its headers say).
