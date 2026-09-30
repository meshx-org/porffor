# Vendored: libuv

[libuv](https://github.com/libuv/libuv) `v1.53.0` (`840404ce8ba7cc0204be52389a6cfff9f2c90fb6`), MIT
(`LICENSE`, `LICENSE-extra`). The files are unmodified: `include/`, and `src/` without `src/win/`
(Windows is not built yet) or anything else of the repository (docs, tests, build files).

The event loop of a native build with the runtime (`porf native --runtime`): its timers
(`setTimeout`, `setInterval`) and, later, its asynchronous I/O. A WASI build does not use it: there
the host drives the loop (`runtime/timers.mjs`, over `wasi:clocks`).

`sources.json` lists what to compile on each system, as libuv's `CMakeLists.txt` has it; the
compiler builds those once into a cached archive (`compiler/libuv.js`) and links it only into
programs built with the runtime.
