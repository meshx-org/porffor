// Native (libuv) clock: porffor:clock's waitFor, as a WASI build has it from wasi:clocks
// (monotonic-clock.wait-for). Each wait is a uv_timer_t on libuv's default loop, which porf_start
// runs once the program's top level is done (porf_event_loop): when it is due, its promise
// settles (porffor:async) and the promise jobs that follow run, before the loop goes on.
import { rtAwait, rtOnCancel, rtSettle, rtToken } from './async.mjs';

// libuv's callback for a wait that is due
function settle(token) {
	rtSettle(token);
	__Porffor_promise_runJobs();
}

Porffor.c`
#include <uv.h>

// the waits in flight (porf_uv_run, the loop: async.mjs): a list (there are few), each a uv_timer_t and its token
typedef struct porf_uv_wait {
  uv_timer_t handle;
  f64 token;
  struct porf_uv_wait *next;
} porf_uv_wait;
static porf_uv_wait *porf_uv_waits = NULL;

static void porf_uv_wait_free(uv_handle_t *handle) {
  free(handle);
}

// a wait off the list, its handle closed (freed once libuv is done with it)
static void porf_uv_wait_drop(porf_uv_wait *wait) {
  for (porf_uv_wait **at = &porf_uv_waits; *at; at = &(*at)->next) {
    if (*at == wait) {
      *at = wait->next;
      break;
    }
  }
  uv_timer_stop(&wait->handle);
  uv_close((uv_handle_t *)&wait->handle, porf_uv_wait_free);
}

static void porf_uv_wait_due(uv_timer_t *handle) {
  porf_uv_wait *wait = (porf_uv_wait *)handle;
  const f64 token = wait->token;
  porf_uv_wait_drop(wait);
  ${settle}(porf_box_num(token));
}

static void porf_uv_wait_start(f64 token, f64 ms) {
  porf_uv_wait *wait = malloc(sizeof(porf_uv_wait));
  if (!wait) abort();
  uv_timer_init(uv_default_loop(), &wait->handle);
  wait->token = token;
  wait->next = porf_uv_waits;
  porf_uv_waits = wait;
  uv_timer_start(&wait->handle, porf_uv_wait_due, (uint64_t)ms, 0);
  porf_uv_loop_use();
}

// whether a wait keeps the loop running (uv_ref / uv_unref: Node's timer ref and unref)
static void porf_uv_wait_ref(f64 token, int ref) {
  for (porf_uv_wait *wait = porf_uv_waits; wait; wait = wait->next) {
    if (wait->token == token) {
      if (ref) uv_ref((uv_handle_t *)&wait->handle);
      else uv_unref((uv_handle_t *)&wait->handle);
      return;
    }
  }
}

static void porf_uv_wait_cancel(f64 token) {
  for (porf_uv_wait *wait = porf_uv_waits; wait; wait = wait->next) {
    if (wait->token == token) {
      porf_uv_wait_drop(wait);
      return;
    }
  }
}
`;

function start(token, ms) {
	Porffor.c`porf_uv_wait_start(PORF_NUM(${token}), PORF_NUM(${ms}));`;
}

function cancel(token) {
	Porffor.c`porf_uv_wait_cancel(PORF_NUM(${token}));`;
}

/** Whether the wait under token keeps the program running: an unreferenced one does not. */
export function refWait(token, ref) {
	const on = ref ? 1 : 0;
	Porffor.c`porf_uv_wait_ref(PORF_NUM(${token}), (int)PORF_NUM(${on}));`;
}

/** A promise that resolves after ns nanoseconds (to the millisecond, as libuv counts). */
export function waitFor(ns) {
	const token = rtToken();
	start(token, Math.ceil(Number(ns) / 1_000_000));
	rtOnCancel(token, () => cancel(token));
	return rtAwait(token, () => undefined);
}
