# Server benchmark

`export default { fetch }` served natively by Porffor's runtime (`runtime/host/native/http-server.mjs`: libuv, llhttp) against Node's `http` and Bun, each loaded by [wrk](https://github.com/wg/wrk) in turn.

```sh
node bench/server/run.mjs [results.md]   # needs wrk; Bun is included when installed
```

`DURATION` (seconds, default 10), `CONNECTIONS` (default 50) and `THREADS` (default 2) tune wrk. `UWS_BIN`, a hello-world server built with the uWebSockets mode Porffor had before, adds it to the hello-world rows.

- `app.mjs` is the app Porffor and Bun serve: a route per scenario.
- `node.mjs` is the same on `node:http`.
- `post.lua` is wrk's 1 KB POST.

## Results

2026-09-30, Apple M1 Pro, macOS, `wrk -t2 -c50 -d8s`. Requests per second, mean latency in brackets. Runs vary by about ±10%.

| scenario                 |         Porffor |          Node 26 `http` |      Bun 1.3.14 |
| ------------------------ | --------------: | ----------------------: | --------------: |
| hello, keep-alive        |  87,563 (583us) |          65,360 (788us) |  96,769 (507us) |
| JSON                     | 79,808 (0.96ms) |          62,500 (820us) |  88,900 (554us) |
| POST 1 KB echo           | 67,656 (1.10ms) |         55,165 (0.93ms) |  76,124 (653us) |
| streamed 16 x 1 KB       | 33,841 (1.44ms) |         38,525 (1.34ms) | 34,565 (1.45ms) |
| hello, a connection each | 23,391 (2.09ms) | 10,678 (1.62ms, errors) | 24,069 (3.02ms) |

- **The old uWebSockets mode** served hello world at about 100,000 requests per second in the same setup. It had no runtime: no spec `Request` or `Response`, streams, or `AbortSignal`.
- **Hello world is bound by the kernel:** about three quarters of the server's time is in `read` and `write`, one of each per request.
- **Where the gains came from:**
  - Streamed responses are corked: a response's head and chunks go out in one write when the loop is about to wait. That took them from 9,300 to 34,000 requests per second.
  - A request body that has all arrived is handed to the handler as bytes, with no stream. That took the POST echo from 46,000 to 68,000.

The Porffor build of `app.mjs` is 1.59 MB.
