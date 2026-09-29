// The async half of the glue (component model async, WASI P3): pending operations and
// the event dispatch that settles their JS promises. Included by glue.c, after
// core.c, when the world has async functions, streams or futures. glue.c defines
// RT_W(x) and RT_WU(x) as the world's prefixes (fetcher_##x, FETCHER_##x).
//
// An operation that cannot finish at once (an async import's subtask, a stream or
// future read or write) is joined to a waitable set under a token; JS keeps the
// promise's resolver under the same token (rtAwait in js/async.mjs). When its event
// arrives, rt_async_complete lifts the result into the queue and rtSettle resolves
// the promise from it. Events arrive in an async export's callback, or through a poll
// at the end of every other export.

enum { RT_OP_SUBTASK, RT_OP_READ, RT_OP_WRITE };

#ifdef RT_TRACE
#define RT_TRACE_OP(what, a, b) fprintf(stderr, "[rt] %s %u %u\n", what, (unsigned)(a), (unsigned)(b))
#else
#define RT_TRACE_OP(what, a, b) ((void)0)
#endif

typedef struct rt_pending {
  u32 waitable;  // the subtask, or the stream or future end
  u32 token;     // the JS promise's key
  int kind;      // RT_OP_*
  int op;        // the import or helper (its rtImp id), to lift the result
  void* data;    // a call record or future buffer, freed by rt_async_complete
  int weak;      // a write nobody waits on: does not keep an async export alive
  u32 thread;    // who started it (rt_self: it may not end before this finishes)
} rt_pending;

// ---- several async export calls at once ----
// Each async export call is one of several at once, sharing the pending table. wasmtime
// delivers an operation's event only to the call that started it, so each joins what it
// starts to a waitable set of its own and waits on that; a call with nothing of its own
// to wait for parks and is woken whenever another has settled something, to see whether
// its call has. A call outlives the host work it started.
//
// Two ways to run them, chosen at build time (RT_STACKFUL, from Porffor's PORF_STACKFUL):
// - stackful: each call runs on its own thread (lifted stackful), blocking in
//   waitable-set.wait; a parked thread is suspended and resumed (thread builtins). A
//   stackful coroutine needs this: it runs on a thread of its own, and switches back.
// - callback: each call is a task lifted with a callback. It never blocks: a turn of its
//   loop ends by returning WAIT (on a waitable set), YIELD or EXIT to the host, which
//   calls back with the next event. A parked task waits on a read of a stream<()> of its
//   own, and is woken by a write to it (as wit-bindgen's Rust and MoonBit runtimes do).
//   No thread builtin is used: with every coroutine stackless, nothing needs a thread.

#ifndef RT_STACKFUL
#error "RT_STACKFUL: how async exports are lifted (set by wasi-porffor-build)"
#endif
#if RT_STACKFUL != PORF_STACKFUL
#error "RT_STACKFUL and the program's PORF_STACKFUL disagree"
#endif

#if RT_STACKFUL
__attribute__((__import_module__("$root"), __import_name__("[thread-index]")))
extern u32 rt_thread_index(void);
__attribute__((__import_module__("$root"), __import_name__("[thread-suspend]")))
extern u32 rt_thread_suspend(void);
__attribute__((__import_module__("$root"), __import_name__("[thread-resume-later]")))
extern void rt_thread_resume_later(u32 thread);

/** Who is running: the thread (an async export call's own, or a sync export's). */
static u32 rt_self(void) { return rt_thread_index(); }
#else
// the wake-up channel, a stream<()>: made through these $root imports, which the
// component linker turns into the canonical built-ins without a stream type in the WIT
__attribute__((__import_module__("$root"), __import_name__("[stream-new-unit]")))
extern uint64_t rt_unit_new(void);
__attribute__((__import_module__("$root"), __import_name__("[async-lower][stream-read-unit]")))
extern u32 rt_unit_read(u32 end, void* buffer, u32 count);
__attribute__((__import_module__("$root"), __import_name__("[async-lower][stream-write-unit]")))
extern u32 rt_unit_write(u32 end, const void* buffer, u32 count);
__attribute__((__import_module__("$root"), __import_name__("[stream-cancel-read-unit]")))
extern u32 rt_unit_cancel_read(u32 end);
__attribute__((__import_module__("$root"), __import_name__("[stream-drop-readable-unit]")))
extern void rt_unit_drop_readable(u32 end);
__attribute__((__import_module__("$root"), __import_name__("[stream-drop-writable-unit]")))
extern void rt_unit_drop_writable(u32 end);

/** An async export call (a task), across the callbacks it takes. */
typedef struct rt_task {
  u32 id;                  // what its operations are recorded under (never 0: sync exports)
  f64 js;                  // the JS task id of its promise (rtTaskStart)
  int returned;            // task.return done: waiting only for host work it started
  int yielding;            // returned YIELD for yields: settle them when called back
  u32 wake_read, wake_write;  // its stream<()> (0: none yet)
  int wake_reading;        // a read of it is pending, in the task's set
} rt_task;

static u32 rt_next_task = 1;
// the task whose call or callback is running (NULL: a sync export). A plain global:
// the host runs one call or callback of an instance at a time
static rt_task* rt_cur = NULL;
// per task, found again in each of its callbacks: they all run on its implicit thread.
// Not context slot 0: on wasm32-wasip3 libc keeps the thread's TLS there
static _Thread_local rt_task* rt_task_here = NULL;

/** Who is running: the task (an async export call), or 0 for a sync export. */
static u32 rt_self(void) { return rt_cur ? rt_cur->id : 0; }
#endif

static rt_pending* rt_pend = NULL;
static u32 rt_npend = 0, rt_cappend = 0;
static u32 rt_next_token = 1;

static void rt_async_complete(int op, void* data, u32 code);  // generated in glue.c
static void rt_async_start(int op, void* data, u32 token);     // generated in glue.c
static u32 rt_async_cancel(int op, u32 waitable);              // generated in glue.c
static void rt_async_abandon(int op, void* data);              // generated in glue.c

// Every settlement goes through here: a settled promise has queued microtasks, and the
// loop must run them before it decides there is nothing left to do but wait.
static u32 rt_settles = 0;
static void rt_settle(u32 token) {
  rt_settles++;
  rt_call_settle(token);
}

// A waitable set per async export thread: wasmtime delivers an operation's event only
// to a wait on the thread that started it, so each waits on its own set, never on
// another's. Everything else (sync exports, polling as they leave) shares one set.
typedef struct rt_thread_set { u32 thread; u32 set; } rt_thread_set;
static rt_thread_set* rt_sets = NULL;
static u32 rt_nsets = 0, rt_capsets = 0;
static u32 rt_shared_set = 0;

/** The set sync exports' operations join. */
static u32 rt_shared_waitset(void) {
  if (rt_shared_set == 0) rt_shared_set = RT_W(waitable_set_new)();
  return rt_shared_set;
}

/** The caller's waitable set: its own for an async export call, else the shared one. */
static u32 rt_waitset(void) {
  const u32 me = rt_self();
  for (u32 i = 0; i < rt_nsets; i++)
    if (rt_sets[i].thread == me) return rt_sets[i].set;
  return rt_shared_waitset();
}

/** Gives the caller, an async export call, a set of its own. */
static void rt_waitset_own(void) {
  if (rt_nsets == rt_capsets) {
    rt_capsets = rt_capsets ? rt_capsets * 2 : 8;
    rt_sets = realloc(rt_sets, (size_t)rt_capsets * sizeof(rt_thread_set));
    if (!rt_sets) rt_fail("out of memory tracking waitable sets");
  }
  rt_sets[rt_nsets++] = (rt_thread_set){rt_self(), RT_W(waitable_set_new)()};
}

/** Drops the caller's set as it ends (empty: its operations are all done). */
static void rt_waitset_drop(void) {
  const u32 me = rt_self();
  for (u32 i = 0; i < rt_nsets; i++) {
    if (rt_sets[i].thread != me) continue;
    RT_W(waitable_set_drop)(rt_sets[i].set);
    rt_sets[i] = rt_sets[--rt_nsets];
    return;
  }
}

// A Uint8Array the host reads from or writes into until the event is kept alive by
// JS (rtAwait holds it), not here: the collector does not scan this table.
static u32 rt_pending_add(u32 waitable, int kind, int op, void* data, int weak, u32 token) {
  if (rt_npend == rt_cappend) {
    rt_cappend = rt_cappend ? rt_cappend * 2 : 16;
    rt_pend = realloc(rt_pend, (size_t)rt_cappend * sizeof(rt_pending));
    if (!rt_pend) rt_fail("out of memory tracking async operations");
  }
#ifdef RT_TRACE
  fprintf(stderr, "[rt] pending %u kind %d op %d token %u\n", waitable, kind, op, token);
#endif
  rt_pend[rt_npend++] = (rt_pending){waitable, token, kind, op, data, weak, rt_self()};
  RT_W(waitable_join)(waitable, rt_waitset());
  return token;
}

// ---- starting operations on the export's thread ----
// An async operation is started on the thread of the export that is running, never on
// a coroutine's: Porffor's awaits are P3 threads that end when their function returns,
// and wasmtime keeps working on behalf of the thread that started a host call after it
// has returned (a worker delivering to that thread fails once it has exited). JS asks
// for an operation; it is queued here with its token and started by rt_start_deferred
// in the export's event loop, on a thread that outlives everything it waits for.

typedef struct rt_deferred { int op; void* data; u32 token; int weak; } rt_deferred;
enum { RT_DEFER_CANCEL = -1 };  // a queued cancellation: token names the operation
static rt_deferred* rt_defq = NULL;
static u32 rt_ndef = 0, rt_capdef = 0;

/** Queues an operation; the token is its promise's key. */
static u32 rt_defer(int op, void* data, int weak) {
  if (rt_ndef == rt_capdef) {
    rt_capdef = rt_capdef ? rt_capdef * 2 : 16;
    rt_defq = realloc(rt_defq, (size_t)rt_capdef * sizeof(rt_deferred));
    if (!rt_defq) rt_fail("out of memory queueing async operations");
  }
  const u32 token = rt_next_token++;
  rt_defq[rt_ndef++] = (rt_deferred){op, data, token, weak};
  return token;
}

/** Starts every queued operation (on the calling thread: the export's). */
static void rt_cancel_started(u32 token);

static void rt_start_deferred(void) {
  while (rt_ndef > 0) {
    // start in request order; a start can settle a promise but never queues directly
    const rt_deferred d = rt_defq[0];
    memmove(rt_defq, rt_defq + 1, (size_t)(--rt_ndef) * sizeof(rt_deferred));
    if (d.op == RT_DEFER_CANCEL) rt_cancel_started(d.token);
    else rt_async_start(d.op, d.data, d.token);
  }
}

// ---- cancellation (AbortSignal, clearTimeout) ----
// JS has already rejected the operation's promise; here the host's side of it ends. An
// operation still queued is dropped without ever starting. A started one is cancelled
// on the export's thread, like every other call into the host: the subtask, or the
// stream or future read or write, is cancelled and taken out of the set. What it had
// already produced by then (a subtask that returned, bytes a read got) is lifted and
// thrown away; a resource in it is not dropped, and lives until the instance does.

/** Ends a started operation with the host (the export's thread). */
static void rt_cancel_started(u32 token) {
  u32 i = 0;
  while (i < rt_npend && rt_pend[i].token != token) i++;
  if (i == rt_npend) return;  // it finished meanwhile: its settlement found no promise
  const rt_pending p = rt_pend[i];
  rt_pend[i] = rt_pend[--rt_npend];
  RT_TRACE_OP("cancel", p.waitable, token);
  // out of the set first: a synchronous cancel traps on a waitable still in one
  RT_W(waitable_join)(p.waitable, 0);
  const u32 code = rt_async_cancel(p.op, p.waitable);
  if (p.kind == RT_OP_SUBTASK) {
    if ((code & 0xf) == RT_WU(SUBTASK_RETURNED)) {
      rt_async_complete(p.op, p.data, 0);
      rt_reset();
    } else {
      rt_async_abandon(p.op, p.data);
    }
    RT_W(subtask_drop)(p.waitable);
    return;
  }
  rt_async_complete(p.op, p.data, code);
  rt_reset();
}

/**
 * Whether a cancellation of an operation on this stream or future end is still queued:
 * dropping the end must wait behind it (an end with a read or write pending cannot be
 * dropped), so glue.c queues the drop too.
 */
static int rt_cancel_queued(u32 end) {
  for (u32 i = 0; i < rt_ndef; i++) {
    if (rt_defq[i].op != RT_DEFER_CANCEL) continue;
    for (u32 j = 0; j < rt_npend; j++)
      if (rt_pend[j].token == rt_defq[i].token && rt_pend[j].waitable == end) return 1;
  }
  return 0;
}

/** Cancels an operation: dropped at once if queued, else cancelled on the export's thread. */
static void rt_cancel(u32 token) {
  for (u32 i = 0; i < rt_ndef; i++) {
    if (rt_defq[i].token != token || rt_defq[i].op == RT_DEFER_CANCEL) continue;
    rt_async_abandon(rt_defq[i].op, rt_defq[i].data);
    memmove(rt_defq + i, rt_defq + i + 1, (size_t)(--rt_ndef - i) * sizeof(rt_deferred));
    return;
  }
  // nothing waits on it any more; the queued cancellation does not keep an export alive
  for (u32 i = 0; i < rt_npend; i++)
    if (rt_pend[i].token == token) rt_pend[i].weak = 1;
  if (rt_ndef == rt_capdef) {
    rt_capdef = rt_capdef ? rt_capdef * 2 : 16;
    rt_defq = realloc(rt_defq, (size_t)rt_capdef * sizeof(rt_deferred));
    if (!rt_defq) rt_fail("out of memory queueing async operations");
  }
  rt_defq[rt_ndef++] = (rt_deferred){RT_DEFER_CANCEL, NULL, token, 1};
}

/** Operations an async export must still wait for. */
static u32 rt_strong_pending(void) {
  u32 n = 0;
  for (u32 i = 0; i < rt_ndef; i++) n += !rt_defq[i].weak;
  for (u32 i = 0; i < rt_npend; i++) n += !rt_pend[i].weak;
  return n;
}

/** One event: its operation's result into the queue, then its promise settled. */
static void rt_dispatch(const RT_W(event_t)* ev) {
  if (ev->event == RT_WU(EVENT_NONE)) return;
#ifdef RT_TRACE
  fprintf(stderr, "[rt] event %d waitable %u code %u (pending:", (int)ev->event, ev->waitable, ev->code);
  for (u32 j = 0; j < rt_npend; j++) fprintf(stderr, " %u/k%d/op%d", rt_pend[j].waitable, rt_pend[j].kind, rt_pend[j].op);
  fprintf(stderr, ")\n");
#endif
  // a subtask reports each state change; only its return finishes it
  if (ev->event == RT_WU(EVENT_SUBTASK) && (ev->code & 0xf) != RT_WU(SUBTASK_RETURNED)) return;
  u32 i = 0;
  while (i < rt_npend && rt_pend[i].waitable != ev->waitable) i++;
  if (i == rt_npend) return;  // not ours (or already settled)
  const rt_pending p = rt_pend[i];
  rt_pend[i] = rt_pend[--rt_npend];

#ifdef RT_TRACE
#define RT_T(m) fprintf(stderr, "[rt]   %s\n", m)
#else
#define RT_T(m) ((void)0)
#endif
  RT_W(waitable_join)(p.waitable, 0);  // out of the set
  RT_T("left the set");
  if (p.kind == RT_OP_SUBTASK) RT_W(subtask_drop)(p.waitable);
  RT_T("subtask dropped");
  rt_reset();
  rt_async_complete(p.op, p.data, ev->code);
  RT_T("completed");
  rt_settle(p.token);
  RT_T("settled");
}

/**
 * Without blocking, until nothing moves: starts what JS queued, runs the microtasks any
 * settlement queued, and delivers every ready event (whose microtasks may queue more).
 */
// Starting a queued operation is an async export's job, never a sync export's: a host may
// run the start as a call that suspends the caller (jco's async-lowered imports suspend
// through JSPI), which a sync export cannot do. So a sync export only delivers what has
// finished, and what it queued (a timer the module's top level set in the constructor,
// say) is started by the next async export's loop.
static void rt_async_poll_with(int start) {
  for (;;) {
    const u32 before = rt_settles;
    const u32 queued = start ? rt_ndef : 0;
    if (start) rt_start_deferred();
    if (rt_settles != before || queued != 0) {
      porf_run_jobs();
      continue;
    }
    if (rt_npend == 0) return;
#ifdef RT_TRACE
    RT_TRACE_OP("poll set", rt_waitset(), rt_npend);
#endif
    RT_W(event_t) ev;
    RT_W(waitable_set_poll)(rt_waitset(), &ev);
    if (ev.event == RT_WU(EVENT_NONE)) return;
    rt_dispatch(&ev);
    porf_run_jobs();
  }
}

/** An async export's loop: start what is queued, deliver what has finished. */
static void rt_async_poll(void) { rt_async_poll_with(1); }

/** A sync export's end: deliver what has finished, start nothing. */
static void rt_async_deliver(void) { rt_async_poll_with(0); }

// ---- stream and future ends in JS values ----

/** A queued stream read or write: the end and the Uint8Array's bytes. */
typedef struct rt_stream_op { uint32_t h; uint8_t* b; size_t n; } rt_stream_op;

/** The bytes of a Uint8Array argument: its data pointer and length. */
static uint8_t* rt_pop_bytes(size_t* len) {
  const jsval v = rt_pop();
  if (v.type != 81) rt_fail("expected a Uint8Array");  // TYPES.uint8array
  const u32 body = (u32)v.val;
  *len = *(u32*)(MEM + body);
  // bufferPtr (+4) already includes the view's byte offset; the bytes start 4 past it
  return (uint8_t*)(MEM + *(u32*)(MEM + body + 4) + 4);
}

/** A stream read or write's outcome: the count, and whether the other end is gone. */
static void rt_push_stream_result(u32 code) {
  rt_push_num((f64)RT_WU(WAITABLE_COUNT)(code));
  rt_push_bool(RT_WU(WAITABLE_STATE)(code) == RT_WU(WAITABLE_DROPPED));
}

// ---- yields (scheduler.yield, setImmediate, requestIdleCallback) ----
// A yield is a promise settled after the host has had a turn: an async export's loop
// sees yields waiting, calls thread.yield (the host runs other tasks meanwhile), then
// settles them. A sync export cannot give the host a turn; its yields settle once the
// microtasks have run (rt_drain_yields, at LEAVE).

static u32* rt_yq = NULL;
static u32 rt_nyield = 0, rt_capyield = 0;

/** Asks for a yield; the token is its promise's key. */
static u32 rt_yield_request(void) {
  if (rt_nyield == rt_capyield) {
    rt_capyield = rt_capyield ? rt_capyield * 2 : 16;
    rt_yq = realloc(rt_yq, (size_t)rt_capyield * sizeof(u32));
    if (!rt_yq) rt_fail("out of memory queueing yields");
  }
  const u32 token = rt_next_token++;
  rt_yq[rt_nyield++] = token;
  return token;
}

/** Settles the yields asked for so far (not ones asked for meanwhile); whether any were. */
static int rt_settle_yields(void) {
  if (rt_nyield == 0) return 0;
  u32* batch = rt_yq;
  const u32 n = rt_nyield;
  rt_yq = NULL;
  rt_nyield = rt_capyield = 0;
  for (u32 i = 0; i < n; i++) {
    rt_reset();
    rt_settle(batch[i]);
  }
  free(batch);
  return 1;
}

/** A sync export's yields: settled, with what they lead to, until none are left. */
static void rt_drain_yields(void) {
  while (rt_settle_yields()) {
    porf_run_jobs();
    rt_async_deliver();
  }
}

// ---- waiting: on a call's own set, or parked ----

static u32 rt_calls = 0;         // async export calls running
static u32 rt_woken_at = 0;      // rt_settles when the parked calls were last woken

/** Host work the caller started that has not finished (it must outlive it). */
static u32 rt_thread_outstanding(void) {
  const u32 me = rt_self();
  u32 n = 0;
  for (u32 i = 0; i < rt_npend; i++) n += rt_pend[i].thread == me && !rt_pend[i].weak;
  return n;
}

#if RT_STACKFUL
static u32* rt_parked = NULL;    // threads suspended until something settles
static u32 rt_nparked = 0, rt_capparked = 0;

/** Wakes every parked thread (each looks again at its own call). */
static void rt_wake_parked(void) {
  const u32 n = rt_nparked;
  rt_woken_at = rt_settles;
  rt_nparked = 0;
  for (u32 i = 0; i < n; i++) rt_thread_resume_later(rt_parked[i]);
}

/**
 * Waits for something to happen. A thread with host work of its own waits on its own
 * set and dispatches the event (then everyone parked is woken to look); one without
 * parks until another thread has settled something.
 */
static void rt_wait_turn(const char* who) {
  // what this thread settled while running is news to the parked: they look before it
  // blocks, perhaps for long (a response body nobody reads keeps its request open)
  if (rt_settles != rt_woken_at) rt_wake_parked();
  if (rt_thread_outstanding() == 0 && rt_calls > 1) {
    if (rt_strong_pending() == 0) {
      // nothing the host will finish: another call may still move things along
      RT_W(thread_yield)();
      return;
    }
    if (rt_nparked == rt_capparked) {
      rt_capparked = rt_capparked ? rt_capparked * 2 : 8;
      rt_parked = realloc(rt_parked, (size_t)rt_capparked * sizeof(u32));
      if (!rt_parked) rt_fail("out of memory parking threads");
    }
    rt_parked[rt_nparked++] = rt_thread_index();
    RT_TRACE_OP("park", rt_thread_index(), rt_npend);
    rt_thread_suspend();
    return;
  }
  if (rt_strong_pending() == 0) {
    fputs("porffor component glue: ", stderr);
    fputs(who, stderr);
    fputs(": its promise waits on nothing the host will finish\n", stderr);
    abort();
  }
  RT_W(event_t) ev;
  RT_TRACE_OP("wait", rt_thread_index(), rt_npend);
  // the only call, with nothing of its own: what is pending was started by sync exports
  RT_W(waitable_set_wait)(rt_thread_outstanding() > 0 ? rt_waitset() : rt_shared_waitset(), &ev);
  // no guest code is on any export's stack here: a GC safe point
  porf_gc_run_pending();
  rt_dispatch(&ev);
  rt_wake_parked();
}
#else
static rt_task** rt_parked = NULL;  // tasks waiting on their stream<()> until something settles
static u32 rt_nparked = 0, rt_capparked = 0;

/** Wakes every parked task but the running one: a unit written to its stream<()>. */
static void rt_wake_parked(void) {
  rt_woken_at = rt_settles;
  u32 kept = 0;
  for (u32 i = 0; i < rt_nparked; i++) {
    rt_task* t = rt_parked[i];
    // the running task looks again anyway; it stays parked, its read still pending
    if (t == rt_cur) {
      rt_parked[kept++] = t;
      continue;
    }
    // its read is pending, so the write completes at once; the read's event is the
    // task's, in its own set, and calls it back
    if (t->wake_reading) (void)rt_unit_write(t->wake_write, NULL, 1);
  }
  rt_nparked = kept;
}

/** Parks the running task: a read of its stream<()>, pending in its set, wakes it. */
static void rt_park(rt_task* t) {
  if (t->wake_read == 0) {
    const uint64_t ends = rt_unit_new();
    t->wake_read = (u32)ends;
    t->wake_write = (u32)(ends >> 32);
  }
  if (!t->wake_reading) {
    const u32 rc = rt_unit_read(t->wake_read, NULL, 1);
    if (rc != RT_WU(WAITABLE_STATUS_BLOCKED)) rt_fail("wake-up stream: a read that did not wait");
    t->wake_reading = 1;
    RT_W(waitable_join)(t->wake_read, rt_waitset());
  }
  for (u32 i = 0; i < rt_nparked; i++)
    if (rt_parked[i] == t) return;
  if (rt_nparked == rt_capparked) {
    rt_capparked = rt_capparked ? rt_capparked * 2 : 8;
    rt_parked = realloc(rt_parked, (size_t)rt_capparked * sizeof(rt_task*));
    if (!rt_parked) rt_fail("out of memory parking tasks");
  }
  rt_parked[rt_nparked++] = t;
  RT_TRACE_OP("park", t->id, rt_npend);
}

/** A new task: the running async export call, with a waitable set of its own. */
static rt_task* rt_task_start(void) {
  rt_task* t = calloc(1, sizeof(rt_task));
  if (!t) rt_fail("out of memory starting an async export call");
  t->id = rt_next_task++;
  rt_task_here = t;
  rt_cur = t;
  rt_waitset_own();
  rt_calls++;
  return t;
}

/**
 * A callback of the running task: its event (an operation's, or the wake-up read's)
 * dispatched, the yields it returned YIELD for settled, and the parked woken if
 * anything settled.
 */
static rt_task* rt_task_resume(const RT_W(event_t)* ev) {
  rt_task* t = rt_task_here;
  if (!t) rt_fail("async export callback without its task");
  rt_cur = t;
  if (t->wake_reading && ev->event == RT_WU(EVENT_STREAM_READ) && ev->waitable == t->wake_read) {
    t->wake_reading = 0;
    RT_W(waitable_join)(t->wake_read, 0);
  } else rt_dispatch(ev);
  if (t->yielding) {
    t->yielding = 0;
    rt_settle_yields();
  }
  if (rt_settles != rt_woken_at) rt_wake_parked();
  return t;
}

/** Ends a turn of the running task with a callback code for the host. */
static u32 rt_task_turn(u32 code) {
  rt_cur = NULL;
  return code;
}

/** The running task is done (returned, and its host work finished): EXIT. */
static u32 rt_task_end(rt_task* t) {
  for (u32 i = 0; i < rt_nparked; i++)
    if (rt_parked[i] == t) {
      rt_parked[i] = rt_parked[--rt_nparked];
      break;
    }
  if (t->wake_reading) {
    // out of the set first: a read still in one cannot be cancelled
    RT_W(waitable_join)(t->wake_read, 0);
    (void)rt_unit_cancel_read(t->wake_read);
  }
  if (t->wake_read) {
    rt_unit_drop_readable(t->wake_read);
    rt_unit_drop_writable(t->wake_write);
  }
  rt_waitset_drop();
  rt_calls--;
  // the loop is someone else's now: whatever this task settled, the parked look at
  rt_wake_parked();
  rt_task_here = NULL;
  free(t);
  return rt_task_turn(RT_WU(CALLBACK_CODE_EXIT));
}

/**
 * What the running task waits for, as a callback code. With host work of its own it
 * waits on its own set; without it parks (waits on its stream<()>) until another has
 * settled something; with nothing the host will finish, it yields: another call may
 * still move things along.
 */
static u32 rt_task_wait(rt_task* t, const char* who) {
  // what this task settled while running is news to the parked: they look before it
  // waits, perhaps for long (a response body nobody reads keeps its request open)
  if (rt_settles != rt_woken_at) rt_wake_parked();
  if (rt_thread_outstanding() == 0 && rt_calls > 1) {
    if (rt_strong_pending() == 0) return rt_task_turn(RT_WU(CALLBACK_CODE_YIELD));
    rt_park(t);
    const u32 set = rt_waitset();
    return rt_task_turn(RT_WU(CALLBACK_CODE_WAIT)(set));
  }
  if (rt_strong_pending() == 0) {
    fputs("porffor component glue: ", stderr);
    fputs(who, stderr);
    fputs(": its promise waits on nothing the host will finish\n", stderr);
    abort();
  }
  RT_TRACE_OP("wait", t->id, rt_npend);
  // the only call, with nothing of its own: what is pending was started by sync exports
  // (a local: wit-bindgen's CALLBACK_CODE_WAIT does not parenthesize its argument)
  const u32 set = rt_thread_outstanding() > 0 ? rt_waitset() : rt_shared_waitset();
  return rt_task_turn(RT_WU(CALLBACK_CODE_WAIT)(set));
}
#endif
