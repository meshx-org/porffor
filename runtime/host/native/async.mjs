// Native (libuv) async bridge: porffor:async, as a WASI build's glue has it (wasi/scripts/
// gen-glue.mjs, js/async.mjs). A pending host operation is a promise under a token; the host
// (libuv's callback) settles it through rtSettle, and rtCancel ends the host's side of it. The
// runtime (runtime/timers.mjs, ...) is written against these, whichever layer drives the loop.
// libuv's default loop is run by porf_start once the program's top level is done
// (porf_event_loop), when anything is pending on it.
import '../c.mjs';

const pending = new Map();
// how to end each pending operation on the host's side (what its host module registered)
const cancels = new Map();
let lastToken = 0;
let nextToken = 0;

/** A new operation's token (the WASI glue's come from C). */
export function rtToken() {
	return ++nextToken;
}

/** What ends the host's side of an operation, for rtCancel. */
export function rtOnCancel(token, cancel) {
	cancels.set(token, cancel);
}

/**
 * A promise settled by rtSettle(token); keep stays reachable until then. rtLastToken names it
 * right after the call that made it, for rtCancel.
 */
export function rtAwait(token, lift, keep) {
	lastToken = token;
	return new Promise((resolve, reject) => {
		pending.set(token, [resolve, reject, lift, keep]);
	});
}

/** The token of the operation the latest call is waiting for; 0 when it finished at once. */
export function rtLastToken() {
	return lastToken;
}

/**
 * Cancels a pending operation: its promise rejects with reason now, and the host's side of it
 * ends. False when it had already settled.
 */
export function rtCancel(token, reason) {
	const p = pending.get(token);
	if (p === undefined) return false;
	pending.delete(token);
	const cancel = cancels.get(token);
	cancels.delete(token);
	if (cancel !== undefined) cancel();
	p[1](reason);
	return true;
}

/** An operation that finished at once. */
export function rtNow(lift) {
	lastToken = 0;
	try {
		return Promise.resolve(lift());
	} catch (e) {
		return Promise.reject(e);
	}
}

/** The host's word that an operation is done: its promise settles with what lift makes. */
export function rtSettle(token) {
	const p = pending.get(token);
	cancels.delete(token);
	if (p === undefined) return 0;
	pending.delete(token);
	let v;
	try {
		v = p[2]();
	} catch (e) {
		p[1](e);
		return 0;
	}
	p[0](v);
	return 0;
}

// libuv's callback for a yield whose turn has come
function settleYield(token) {
	rtSettle(token);
	__Porffor_promise_runJobs();
}

Porffor.c`
#include <uv.h>

static void porf_uv_run(void) {
  uv_run(uv_default_loop(), UV_RUN_DEFAULT);
}

// one turn: what a top-level await waits on (nonzero while anything is still pending)
static int porf_uv_step(void) {
  return uv_run(uv_default_loop(), UV_RUN_ONCE);
}

// the loop is porf_start's to run once the top level is done, and a top-level await's meanwhile
static void porf_uv_loop_use(void) {
  porf_event_loop = porf_uv_run;
  porf_event_loop_step = porf_uv_step;
}

// the yields waiting for the loop's next turn (after its I/O: its check phase, as Node's
// setImmediate), and the idle handle that keeps the loop from blocking on I/O while there are any
static uv_check_t porf_uv_check;
static uv_idle_t porf_uv_idle;
static int porf_uv_check_ready = 0;
static f64 *porf_uv_yields = NULL;
static size_t porf_uv_yields_len = 0, porf_uv_yields_cap = 0;

static void porf_uv_idle_noop(uv_idle_t *handle) {
  (void)handle;
}

static void porf_uv_check_run(uv_check_t *handle) {
  (void)handle;
  // this turn's yields: one queued meanwhile waits for the next
  const size_t n = porf_uv_yields_len;
  f64 *due = malloc(n * sizeof(f64) + 1);
  memcpy(due, porf_uv_yields, n * sizeof(f64));
  porf_uv_yields_len = 0;
  for (size_t i = 0; i < n; i++) ${settleYield}(porf_box_num(due[i]));
  free(due);
  if (porf_uv_yields_len == 0) {
    uv_check_stop(&porf_uv_check);
    uv_idle_stop(&porf_uv_idle);
  }
}

static void porf_uv_yield_add(f64 token) {
  if (!porf_uv_check_ready) {
    uv_check_init(uv_default_loop(), &porf_uv_check);
    uv_idle_init(uv_default_loop(), &porf_uv_idle);
    porf_uv_check_ready = 1;
  }
  if (porf_uv_yields_len == porf_uv_yields_cap) {
    porf_uv_yields_cap = porf_uv_yields_cap * 2 + 16;
    porf_uv_yields = realloc(porf_uv_yields, porf_uv_yields_cap * sizeof(f64));
    if (!porf_uv_yields) abort();
  }
  porf_uv_yields[porf_uv_yields_len++] = token;
  uv_check_start(&porf_uv_check, porf_uv_check_run);
  uv_idle_start(&porf_uv_idle, porf_uv_idle_noop);
  porf_uv_loop_use();
}

static void porf_uv_yield_cancel(f64 token) {
  for (size_t i = 0; i < porf_uv_yields_len; i++) {
    if (porf_uv_yields[i] == token) {
      memmove(porf_uv_yields + i, porf_uv_yields + i + 1, (porf_uv_yields_len - i - 1) * sizeof(f64));
      porf_uv_yields_len--;
      return;
    }
  }
}
`;

function yieldAdd(token) {
	Porffor.c`porf_uv_yield_add(PORF_NUM(${token}));`;
}

function yieldCancel(token) {
	Porffor.c`porf_uv_yield_cancel(PORF_NUM(${token}));`;
}

/** A promise settled after the loop has had a turn: its I/O, then this (Node's setImmediate). */
export function rtYield() {
	const token = rtToken();
	yieldAdd(token);
	rtOnCancel(token, () => yieldCancel(token));
	return rtAwait(token, () => undefined);
}
