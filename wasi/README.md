# @meshx-org/porffor/wasi

Builds JavaScript into WebAssembly (WASI) components with Porffor, the ahead-of-time JavaScript
compiler this repository is (`cli/`, `compiler/`), instead of ComponentizeJS. The Web APIs a guest
gets (fetch, streams, URL, Intl, crypto, timers) are the JS runtime in `runtime/`. The guest's JavaScript is compiled to C; the WIT
boundary is wit-bindgen's C bindings plus glue generated from the same WIT. Any guest that
bundles to one ES module works; the yel guests (Cloud, Sheets, Charts) are the first users.

Compared with the ComponentizeJS builds of the same apps, run through the same host with the same
inputs, the op logs are identical and the components are much smaller (Cloud: 2.4 MB against
15.0 MB raw, 469 KB against 3.49 MB brotli).

## Usage

```sh
wasi-porffor-build --guest .yel-build/cloud.bundle.js --wit wit --world cloud --out build/cloud.wasm
```

`--guest` is the guest as one ESM bundle, the one `yel-solid-build --bundle` writes. Its named
exports are the world's exports; its imports of the world's interfaces (`yel:ui/dom@0.1.0`, …)
become the component's imports.

| Option                     |                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode release` (default) | smallest code: clang `-Oz`, `wasm-opt -Oz` over the whole core module, DWARF, name and producers sections stripped                                                                                            |
| `--mode debug`             | clang `-O1 -g`, no wasm-opt, nothing stripped: traps show function names, `wasm-tools addr2line` maps offsets to Porffor's C and the glue                                                                     |
| `--mode dev`               | clang `-O1` without `-g`, no wasm-opt, nothing stripped: traps still show function names, and a large program compiles much faster than debug                                                                 |
| `--target p2` (default)    | a WASI 0.2 component, what the shell runs today through jco                                                                                                                                                   |
| `--target p3`              | WASI 0.3: async imports and exports, `stream`/`future`, and `async`/`await` in guest code (Porffor's coroutines are P3 threads). wasmtime 49 runs these; jco does not yet                                     |
| `--eh` / `--no-eh`         | wasm exception handling. Default on for p3, off for p2 (jco cannot translate the exceptions proposal); without it, a `throw` inside a `try` traps with a message                                              |
| `--units <n>`              | the program as n C files instead of one (Porffor's `--units`), compiled `--jobs` at a time (default 3) and cached per file. A large guest builds much faster: shell-next goes from 4:52 to 1:49 with 24 units |
| `--work <dir>`             | where the intermediate files go (default: `.wasi-porffor/<world>` beside `--out`)                                                                                                                             |

### From JavaScript

The CLI is a wrapper over `buildComponent`, which takes the same options (camel-cased, as
values: `cflags` an array, `eh` a boolean) and resolves to `{ out, bytes, lift, eh, work }`. A
failed step rejects with its output in the message.

```js
import { buildComponent } from '@meshx-org/porffor/wasi';

await buildComponent({
	guest: 'dist/guest.js',
	wit: 'wit',
	world: 'cloud',
	out: 'dist/cloud.wasm'
});
```

### Vite

`wasiPorffor()` builds the bundle `vite build` makes into a component, emitted as
`<world>.wasm` in place of the JavaScript:

```js
// vite.config.js
import { wasiPorffor } from '@meshx-org/porffor/wasi/vite';

export default {
	build: { lib: { entry: 'src/index.js', formats: ['es'] } },
	plugins: [wasiPorffor({ wit: 'wit', world: 'cloud' })]
};
```

It takes `buildComponent`'s options (but `guest` and `out`) and:

- makes the build one ES module (`codeSplitting: false`; Vite 8), with the world's imports (any
  `namespace:package/interface` specifier; `external` to change that) left out for the glue
  to bind
- turns minification off unless the config sets it (Porffor's output is the same size; names
  stay readable in dev and debug builds)
- works in `node_modules/.wasi-porffor/<world>` unless `work` says otherwise, so `units`
  builds reuse their compiled C across runs
- `fileName` renames the component, and `keepJs` keeps the JavaScript bundle beside it

It applies to `vite build` only. A component is a native compile (clang with LTO, wasm-opt),
seconds to minutes, so `vite dev` serves the guest as JavaScript.

## Toolchain

| Tool                | Found as                                           | Version                              |
| ------------------- | -------------------------------------------------- | ------------------------------------ |
| wasi-sdk            | `WASI_SDK_PATH`, else `~/wasi-sdk-34*`             | 34                                   |
| Porffor             | `PORFFOR_CLI`, else this checkout's `cli/index.js` | this commit                          |
| wit-bindgen         | `WIT_BINDGEN`, else `PATH`                         | 0.51.x (the glue reads its C naming) |
| wasm-tools          | `WASM_TOOLS`, else `PATH`                          |                                      |
| wasm-opt (binaryen) | `WASM_OPT`, else `PATH`                            |                                      |

## fetch()

`fetch()` over `wasi:http@0.3.0` (`client.send`), injected with `Response`, `Headers` and
`EventSource` into guests whose world imports `wasi:http/client@0.3.0`: method, headers, string /
`Uint8Array` / `ArrayBuffer` / `ReadableStream` bodies; `status`, `ok`, `headers`, `body` (a
`ReadableStream` read from the host only as it is read), `text()`, `json()`, `bytes()`,
`arrayBuffer()`; `signal`. Not yet: `FormData`, redirect modes (the host decides).

`EventSource` parses the event stream as it arrives (data / event / id / retry, comments, CR / LF /
CRLF, a leading BOM) and reconnects with `Last-Event-ID` after the retry delay, which needs the
timers (a world that imports the monotonic clock).

## Serving HTTP

A world that exports `wasi:http/handler@0.3.0` is a server, and the guest's default export is a
fetch handler, as Cloudflare Workers and Hono write one:

```js
export default {
	async fetch(request, env, ctx) {
		return new Response('hi');
	}
};
```

Each request is a `Request` whose body streams in from the host; the `Response` goes back with its
head first and its body streamed out after it. `env` is the process environment (when the world
imports `wasi:cli/environment@0.3.0`); `ctx.waitUntil` is there for compatibility. A handler that
throws or returns no `Response` answers 500. `wasmtime serve -S p3=y` runs it.

`Request`, `Response` (`json`, `redirect`, `error`, `clone`) and `Headers` follow the Fetch
standard and are injected into every guest, not only servers.

### Concurrent calls

Several async export calls run in one instance at once, each on its own thread (lifted stackful),
sharing one waitable set: one thread at a time waits and dispatches events, the others park and
are woken after each event to see whether their call has settled (`rt_wait_turn`). A thread stays
alive until the host calls it started have finished, since wasmtime delivers a call's result to the
thread that made it. A call's promise that waits on nothing the host will finish aborts the
component, unless another call is still running.

## Streams

The web streams are injected into every guest and tree-shaken away unless used (a guest that uses
none of them builds to the same bytes): `ReadableStream` (sources with `start` / `pull` / `cancel`,
`getReader()`, `cancel()`, `locked`, `pipeTo()`, `pipeThrough()`), `WritableStream` (sinks with
`start` / `write` / `close` / `abort`, `getWriter()` with `ready` / `desiredSize` backpressure),
`TransformStream` (`transform` / `flush`), and `TextDecoderStream` / `TextEncoderStream`. Not here:
byte streams and BYOB readers, `tee`, `ReadableStream.from`.

Porffor's `for await` takes only its own iterables (arrays, strings, its generators), not the async
iterator protocol, so `for await (const chunk of stream)` does not work; `stream.values()` is an
async generator that does: `for await (const chunk of response.body.values())`. Porffor does not
close an iterator on `break` either: a loop left early keeps the stream locked, so cancel it
(`response.body.cancel()` after releasing, or read through a reader and `reader.cancel()`).

## Events and structuredClone

`EventTarget`, `Event`, `CustomEvent` and `MessageEvent` follow the DOM Standard as Node has it:
no tree, so an event is only dispatched at its target. Listeners run in order, once per type,
callback and capture, with `once`, `passive` and `signal`; a listener that throws is reported to
the console and the others still run. `AbortSignal` and `EventSource` are EventTargets.
`__test__/events.test.mjs` compares a guest's dispatches with Node's, except where Node departs
from the standard (every listener after the first sees `eventPhase` 0 and no `currentTarget`, and
a nested dispatch throws Node's own error, not an `InvalidStateError`).

`structuredClone` copies what HTML's structured serialization does, cycles and shared references
included, and throws a `DataCloneError` for functions, symbols, weak collections and promises;
`__test__/structured-clone.test.mjs` compares it with Node's. Web platform objects (`URL`,
`Headers`, streams) are copied as plain objects rather than refused.

## Blob and File

`Blob` and `File` follow the File API: parts are strings (UTF-8), `ArrayBuffer`s, views and other
Blobs, `type` is lowercased (or dropped if it is not printable ASCII), `endings: 'native'`
converts line endings to `\n`, and `slice()` clamps its range as the spec does. `text()`,
`arrayBuffer()`, `bytes()` and `stream()` read it. A component has no files, so a `File` is a
Blob with a `name` and a `lastModified` time. A Blob is also a Fetch body (`new Response(blob)`
takes its type as the content-type) and `Request`/`Response` have `blob()`.
`__test__/blob.test.mjs` compares them with Node's. Two cases follow the spec where Node does not:
a lone `\r` is converted by `endings: 'native'`, and `lastModified` is truncated to an integer.

## Intl

`Intl` (`DateTimeFormat`, `NumberFormat`, `PluralRules`, `ListFormat`, `Collator`, `Locale`,
`getCanonicalLocales`, `supportedValuesOf`) is injected into guests whose world includes
`meshx:intl/imports@0.1.0` (`wit/meshx-intl-0.1.0` at the repo root). The guest carries no locale
data: `runtime/intl.mjs` reads and checks the options, and the host formats. A browser or Node host
passes the calls through to its own `Intl`; `__test__/intl/host/` is that host, and
`__test__/intl.test.mjs` checks that a guest's output matches Node's `Intl` exactly, down to the
order of `resolvedOptions()`. A native host would answer from ICU4X. Not yet: `RelativeTimeFormat`,
`DisplayNames`, `Segmenter`, and the prototype methods (`toLocaleString`, `localeCompare`,
`normalize`), which are Porffor builtins.

## URL

`URL` and `URLSearchParams` are injected into every guest and tree-shaken away unless used: the
URL standard's parser as its state machine (`runtime/url-parser.mjs`), every component getter and
setter, `origin`, `searchParams` kept in step with `search`, `URL.canParse` and `URL.parse`.
`__test__/url.test.mjs` runs a corpus of 980 parses (inputs against bases) and 1,260 setter cases
in a component and compares every component with Node's `URL`.

Not here: UTS #46's full mapping for non-ASCII domains (fullwidth letters, NFC, the validity
checks); a Unicode domain is lowercased and punycoded, which covers ordinary names.
`URLSearchParams`' `keys()` / `values()` / `entries()` return arrays, since Porffor's `for...of`
takes arrays but not iterator objects; `for (... of params)` itself does not work.

## AbortController

`AbortController`, `AbortSignal` (`abort`, `timeout`, `any`, `throwIfAborted`, listeners and
`onabort`) and `DOMException` are injected into every guest; Porffor has none of them. An abort
cancels what is in flight with the host: `fetch` cancels its `send` subtask or the body read or
write it is waiting on, and the promise rejects with the signal's reason. `AbortSignal.timeout`
needs the timers, so it works only in worlds that import the monotonic clock.

## Timers and performance

`setTimeout`, `setInterval`, `clearTimeout` and `clearInterval` are
`@meshx-org/porffor/runtime/timers`, over `wasi:clocks/monotonic-clock@0.3.0` (`wait-for`). The build
injects them into any guest whose world imports that interface, so guest code uses the globals
as usual. Clearing a timer cancels its `wait-for` subtask with the host.

`performance.now()`, `timeOrigin` and User Timing (`mark`, `measure`, `getEntries*`,
`clearMarks`, `clearMeasures`, `toJSON`) are Porffor builtins in the fork.

## Time zone

Date's local time (`getHours`, `getTimezoneOffset`, `toString`, `Date.parse` of a date-time
without an offset) and `Temporal.Now` (`timeZoneId()` and the `*ISO` defaults) read the host's
time zone. In a world that imports `wasi:clocks/timezone@0.3.0` (unstable, feature
`clocks-timezone`), glue.c answers Porffor's hooks with `iana-id` and `utc-offset`; a host
that returns none gives UTC, as does a world without the import. Only the host's own zone has
real offsets: another named zone reads as UTC, since the guest carries no zone data. wasmtime
has no `wasi:clocks/timezone`, so the test plugs in a provider component with wac.

## Yielding to the host

`scheduler.yield()`, `setImmediate` / `clearImmediate` and `requestIdleCallback` /
`cancelIdleCallback` are `@meshx-org/porffor/runtime/scheduler`, injected into guests whose world has
async functions. In an async export, a yield gives the host a turn (the component model's
`thread.yield`) before it resolves, so a long computation that awaits `scheduler.yield()` now and
then lets the host run meanwhile. A sync export cannot give the host a turn: its yields resolve
once the microtasks have run. An idle callback gets the browser's usual 50 ms budget.

## Randomness

`Math.random` and `crypto.getRandomValues` / `crypto.randomUUID` are Porffor builtins in the fork,
fed by `getentropy`, which wasi-libc implements with `wasi:random/random` (0.2 or 0.3, per
target). `Math.random`'s generator is seeded from it on first use, so every instance draws its own
sequence. `getRandomValues` takes integer typed arrays up to 65536 bytes; where the spec throws a
`DOMException` it throws a `TypeError` (TypeMismatchError) or `RangeError` (QuotaExceededError),
naming it in the message.

## crypto.subtle

`crypto.subtle` is JavaScript over [@noble/hashes](https://github.com/paulmillr/noble-hashes) and
[@noble/curves](https://github.com/paulmillr/noble-curves) (`runtime/subtle-crypto.mjs`), injected only
into a guest whose code names `subtle`, so a program that only draws random values carries none of
it. It covers `digest` (SHA-1, SHA-256, SHA-384, SHA-512), HMAC and Ed25519: `generateKey`,
`importKey` and `exportKey` (`raw` and `jwk` for HMAC; `raw`, `spki`, `pkcs8` and `jwk` for Ed25519),
`sign` and `verify`, with `CryptoKey` and the spec's `DOMException`s. Every other algorithm and
operation (`encrypt`, `deriveBits`, `wrapKey`, and the rest) rejects with `NotSupportedError`.
`__test__/crypto-subtle.test.mjs` compares results with Node's Web Crypto, byte for byte where the
output is deterministic (RFC 8032's Ed25519 vector included). One case follows the spec where Node
does not: exporting an Ed25519 private key as `raw` is an `InvalidAccessError`, not a
`NotSupportedError`. The code is not constant time beyond HMAC's `verify`, so it suits signing
tokens and checking signatures, not a side-channel-hostile host.

## How the runtime works

Porffor compiles the language; this package is the runtime around it, the part Node or a
browser plays for V8: the event loop, timers, fetch and the other platform APIs, and the WIT
boundary. Its C lives in `runtime/` (`core.c`: the value queue, job loop and stdio; `async.c`:
async exports and the operations they wait on), its JS in `runtime/`, and the JS side of the bridge
between them is the generated `js/rt.mjs`, which guest code imports as `rt-bridge`.

`scripts/gen-glue.mjs` reads the WIT and wit-bindgen's C header and emits one JS module per imported
interface (jco's JS shapes: camelCase, `{ tag, val }` variants, `undefined` for none, a thrown
`payload` for a result's error), an export router, and `glue.c`. Values cross between JS and C as
a flat sequence of primitives in one queue, so C never needs Porffor's object layout.
Porffor's C is compiled as it comes out, configured by preprocessor switches the fork provides:
`PORF_NO_MAIN` (glue.c calls `porf_start` from the first export, and `porf_run_jobs` at every
export's exit), `PORF_GC_DEFER` (a collection due mid-allocation waits for `porf_gc_run_pending`
at export entry, since the conservative scan cannot see wasm locals) and `PORF_NO_EH` (no
setjmp/longjmp without wasm exception handling). The two directions of the boundary are
`Porffor.c` in the generated JS: `js/rt.mjs` calls the queue's C functions, and `js/entry.mjs`
defines `rt_call_exp(id)` with `${rtExp}`, which Porffor compiles to a C function taking a
`jsval` per parameter.

Async (`runtime/c/async.c`): async exports are lifted stackful, the export's thread waiting on
one waitable set while promises are pending. Every async operation is started on that thread,
never on a coroutine's: wasmtime keeps host work tied to the thread that started it after that
thread has exited (a remainder of wasmtime #13890), and Porffor's awaits are short-lived threads.
Cancelling goes through the same queue: JS rejects the promise at once, and the export's thread
cancels the subtask, stream or future operation later. A drop of a stream end waits behind a queued
cancellation of that end.

Code that reaches a provided global through `globalThis` (`globalThis.URL`, `typeof
globalThis.fetch`, as libraries feature-detect) is not something injection rewrites, so the bundler
makes a first pass to find those names and installs them on `globalThis` (writable, configurable,
not enumerable) before any guest code runs. Only the names found are installed, so the rest stay
tree-shaken; a name built at run time (`globalThis[name]`) is not found.

Library modules in `runtime/` import the globals they use rather than relying on injection (esbuild
does not inject into injected files); timers come from `wasi-porffor:timers`, which the build points
at `runtime/timers.mjs` or, without a clock, at `runtime/no-timers.mjs`.

## Tests

```sh
pnpm test
```

`__test__/fetch.test.mjs`, `timers.test.mjs`, `random.test.mjs` and `timezone.test.mjs` build
their fixture guests (`__test__/<name>/guest.mjs`) for P3 and run them in wasmtime (49+,
`WASMTIME` or `PATH`); fetch runs against a local server, and timezone needs wac (`WAC` or
`PATH`). It skips, with the reason printed, when wasmtime or
the toolchain is missing. The fixture's `wasi:*` WIT is the WASI project's (Apache-2.0 WITH
LLVM-exception), from the `wasip3` 0.8.0 release (`wasi-0.3.0`).

## Web platform tests

`wpt/` runs [web-platform-tests](https://github.com/web-platform-tests/wpt) against the shims, the
way Porffor's `test262/` runs test262:

```sh
pnpm wpt:setup                  # sparse checkout of the directories run, into wpt/wpt
pnpm wpt                        # all of them
pnpm wpt url                    # a directory; one file prints each subtest
pnpm wpt -- --threads=28        # or a number in wpt/.threads
```

It runs the `.any.js` tests of the directories in `wpt/read.mjs` (URL, Encoding, WebCrypto, File
API, Fetch, Streams, events and abort, structured clone, timers, hr-time, console, FormData,
compression), once per `// META: variant`, leaving out those only for a window. Each test becomes
one program (`wpt/guest.mjs`), as WPT's server wraps a test for a worker:

- `testharness.js`, with the names it puts on the global object declared as bindings, since
  Porffor binds free names at compile time;
- the META scripts, then the test;
- an offline `fetch` that serves the files the test fetches by a literal path.

That program is bundled with `runtime/`'s shims the way a guest is (`scripts/bundle.mjs`), then
compiled natively, not as a component: Porffor to C, run by `tcc -run` (or `cc` when tcc is
missing). That is about a second a test, where a component build is over ten. The one piece of the
host it needs, the clock under `runtime/timers.mjs`, is `wpt/native-loop.mjs`:

- it drains the promise jobs, then fires the earliest timer in real time, and so on;
- it stops when the harness reports.

A test passes when the harness finished and every subtest passed. Results go to
`wpt/results.json`; each run prints the change against the last one and what started or stopped
passing (`wpt/diff.json`). Porffor is the one `PORFFOR_CLI` names, as for builds.
