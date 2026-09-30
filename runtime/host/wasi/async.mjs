// WASI async bridge: porffor:async, over the component's glue (wasi/scripts/gen-glue.mjs writes
// it per build as js/async.mjs: its cancel and yield are imports of this build's). A pending host
// operation is a promise under a token the glue's C gave it; the host settles it through the
// component's event loop. runtime/host/native/async.mjs is the same over libuv.
export { rtAwait, rtCancel, rtLastToken, rtNow, rtSettle, rtYield } from 'rt-async';
