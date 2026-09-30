// Native HTTP server: porffor:http-server, a fetch handler (runtime/serve.mjs) served over HTTP/1.1
// on libuv's TCP (uv_listen, uv_read_start / uv_try_write / uv_write on its default loop, which
// porf_start runs), requests parsed by the vendored llhttp (Node's parser: runtime/c/llhttp,
// linked as a cached archive by compiler/deps.js). runtime/host/wasi/http-server.mjs is the same
// as a wasi:http handler export.
//
// The C below owns the connections and the bytes. llhttp is fed what each read brings, and its
// callbacks copy the request head (method, target, headers with their names lower-cased) into one
// buffer and the body into another. A parser stops (HPE_PAUSED) after each message: the next
// request on the connection (keep-alive, or pipelined behind it) is parsed only once this one is
// answered, so responses go out in order, and what waits meanwhile is bounded (the socket is not
// read past it). No JS runs inside llhttp_execute: once it returns, a new request is handed to JS
// (incoming), waits for body bytes or for writes to drain are settled (./async.mjs tokens), and a
// client that went away is told (gone: the request's signal aborts).
//
// JS makes the Request (runtime/request.mjs's incomingRequest: the target is taken as it is when
// C found it plain, parsed with URL otherwise), asks the app (serve.mjs's respond) and writes the
// Response: head and body in one write when the body's bytes are known now (a string, bytes,
// JSON), content-length framed; a stream chunk by chunk as it gives them, chunked (HTTP/1.0: until
// the connection closes), each write waiting while the socket's queue is long (backpressure).
// HEAD gets the head alone. Keep-alive follows the request (llhttp_should_keep_alive); a response
// whose request body was not read drops the rest of it before the next request is parsed.
import { rtAwait, rtSettle, rtToken } from './async.mjs';
import { environment } from './environment.mjs';
import { abortSignal } from '../../abort-signal.mjs';
import { KnownBody, listHas } from '../../body.mjs';
import { DOMException } from '../../dom-exception.mjs';
import { Headers } from '../../headers.mjs';
import { ReadableStream } from '../../readable-stream.mjs';
import { incomingRequest } from '../../request.mjs';
import { Response } from '../../response.mjs';
import { checkApp, respond } from '../../serve.mjs';
import { URL } from '../../url.mjs';

/** Queued bytes past which a streamed response waits for the socket to drain. */
const HIGH = 262_144;
// srvFlags: the target and Host were plain (the URL is theirs as they are), there is a body
const PLAIN = 1;
const HAS_BODY = 2;
// srvRespond's flags: a content-length, the body's bytes now, a streamed body, the app's own date
const LENGTH = 1;
const BODY = 2;
const STREAM = 4;
const OWN_DATE = 8;
/** Statuses a response has no body with (and no content-length is made up for). */
const NO_BODY = [204, 304];
// the headers the server frames a response with itself, whatever the app set
const FRAMING = ['connection', 'content-length', 'keep-alive', 'transfer-encoding'];

/** An outcome nobody needs to see. */
const ignore = () => undefined;
/** The app being served (one per program). */
let app = null;
/** The requests being answered, by their connection's pointer. */
const inFlight = new Map();

// libuv's callback for a wait that is over (body bytes, a drained socket, a closed connection)
function settle(token) {
	rtSettle(token);
	__Porffor_promise_runJobs();
}

// C's word that a connection has a request: it is answered from here on
function incoming(ptr) {
	start(ptr);
	__Porffor_promise_runJobs();
}

// C's word that a request's client went away before its response was done: its signal aborts,
// and a streamed body being written is cancelled
function gone(ptr) {
	const state = inFlight.get(ptr);

	if (state !== undefined && state.request !== null) {
		const reason = new DOMException('The client closed the connection', 'AbortError');

		state.gone = true;
		abortSignal(state.request.signal, reason);

		if (state.reader !== null) state.reader.cancel(reason).then(ignore, ignore);
	}
	__Porffor_promise_runJobs();
}

Porffor.c`
#include <uv.h>
#include <llhttp.h>
#include <arpa/inet.h>
#include <signal.h>
#include <stddef.h>
#include <strings.h>
#include <time.h>

// srvFlags (PLAIN and HAS_BODY in the JS) and srvRespond's flags (LENGTH, BODY, STREAM, OWN_DATE)
#define PORF_SRV_PLAIN 1
#define PORF_SRV_HAS_BODY 2
#define PORF_SRV_LENGTH 1
#define PORF_SRV_BODY 2
#define PORF_SRV_STREAM 4
#define PORF_SRV_OWN_DATE 8

// body bytes read ahead of JS before the socket stops being read (the client then waits)
#define PORF_SRV_HIGH (256 * 1024)
// what a write queue drains to before a streamed response goes on
#define PORF_SRV_LOW (64 * 1024)
// unparsed bytes buffered behind a request being answered (pipelined requests) before the
// socket stops being read
#define PORF_SRV_BEHIND (64 * 1024)
// the longest request head (target and headers): larger is answered 431, as Node does past 16 KiB
#define PORF_SRV_HEAD_MAX (64 * 1024)

typedef struct {
  u8 *data;
  size_t len, cap;
} porf_srv_buf;

static void porf_srv_reserve(porf_srv_buf *buf, size_t more) {
  if (buf->cap - buf->len >= more) return;
  size_t cap = buf->cap * 2 + more;
  u8 *next = realloc(buf->data, cap);
  if (!next) abort();
  buf->data = next;
  buf->cap = cap;
}

static void porf_srv_append(porf_srv_buf *buf, const void *bytes, size_t len) {
  porf_srv_reserve(buf, len);
  memcpy(buf->data + buf->len, bytes, len);
  buf->len += len;
}

typedef struct porf_srv {
  uv_tcp_t tcp;
  int port;
} porf_srv;

// one connection: its socket, its parser, the bytes either way, and where its request is
typedef struct porf_srv_conn {
  uv_tcp_t tcp;
  uv_shutdown_t shutdown;
  llhttp_t parser;
  porf_srv_buf in;     // bytes read; those from in_at on are not parsed yet
  size_t in_at;
  porf_srv_buf head;   // the request head for JS: method \0 target \0 (name \0 value \0)*
  porf_srv_buf body;   // body bytes JS has not taken
  size_t value_at;     // where the header value being read starts in head
  size_t name_at;      // where its name starts
  int head_ready;      // a head parsed, not yet handed to JS
  int busy;            // a request is with JS: from incoming until srvFinish
  int complete;        // the request's message has ended (its body too)
  int paused;          // the parser stopped after a message; the next one waits
  int discard;         // the response is done: the rest of the body is dropped
  int keep;            // the connection stays open after this response
  int minor;           // the request's HTTP/1.minor
  int flags;           // srvFlags
  int expect;          // the client waits for 100 Continue before its body
  int hosts;           // Host headers in the request (RFC 9112: exactly one in HTTP/1.1)
  int chunked;         // the response's body is streamed chunked
  int error;           // a request that cannot be parsed: the status to answer (400, 431)
  int reading;         // the socket is being read
  int eof;             // the client has sent all it will (it may still read)
  int gone;            // the client went away: its socket failed, or ended mid-request
  int queued;          // a pump is due on the loop's next turn (porf_srv_later)
  int left;            // the client ended its side while its request was being answered
  int told;            // JS has heard it (gone)
  int closing;         // uv_close or uv_shutdown called
  int refs;            // what keeps it: its handle, JS's request, a pump under way
  int pumping, repump;
  f64 body_wait;       // the token of a wait for body bytes (0: none)
  f64 drain_wait;      // the token of a wait for the write queue to drain (0: none)
  porf_srv_buf out;    // a streamed response's bytes not yet written: corked (porf_srv_cork)
  int out_listed;      // on the list of connections flushed before the loop waits
  struct porf_srv_conn *next_out;
} porf_srv_conn;

static llhttp_settings_t porf_srv_settings;
static int porf_srv_settings_ready = 0;

static void porf_srv_free(porf_srv_conn *c) {
  if (c->refs > 0) return;
  free(c->in.data);
  free(c->head.data);
  free(c->body.data);
  free(c->out.data);
  free(c);
}

static void porf_srv_closed(uv_handle_t *handle) {
  porf_srv_conn *c = handle->data;
  c->refs--;
  porf_srv_free(c);
}

static void porf_srv_stop_reading(porf_srv_conn *c) {
  if (!c->reading) return;
  uv_read_stop((uv_stream_t *)&c->tcp);
  c->reading = 0;
}

// the socket closed now, whatever is still queued
static void porf_srv_close(porf_srv_conn *c) {
  if (c->closing) return;
  c->out.len = 0;
  c->closing = 1;
  c->gone = 1;
  porf_srv_stop_reading(c);
  uv_close((uv_handle_t *)&c->tcp, porf_srv_closed);
}

static void porf_srv_shut(uv_shutdown_t *req, int status) {
  porf_srv_conn *c = req->data;
  (void)status;
  uv_close((uv_handle_t *)&c->tcp, porf_srv_closed);
}

static void porf_srv_flush(porf_srv_conn *c);

// the socket closed once what is queued is written (what is corked first)
static void porf_srv_end(porf_srv_conn *c) {
  if (c->closing) return;
  porf_srv_flush(c);
  if (c->closing) return;
  c->closing = 1;
  c->gone = 1;
  porf_srv_stop_reading(c);
  c->shutdown.data = c;
  if (uv_shutdown(&c->shutdown, (uv_stream_t *)&c->tcp, porf_srv_shut) < 0)
    uv_close((uv_handle_t *)&c->tcp, porf_srv_closed);
}

// a write under way: its bytes are its own
typedef struct {
  uv_write_t req;
  porf_srv_conn *conn;
  u8 *data;
} porf_srv_write;

static void porf_srv_pump(porf_srv_conn *c);

static void porf_srv_written(uv_write_t *req, int status) {
  porf_srv_write *w = (porf_srv_write *)req;
  porf_srv_conn *c = w->conn;
  free(w->data);
  free(w);
  if (status < 0 && !c->closing) {
    c->gone = 1;
    porf_srv_close(c);
  }
  if (c->drain_wait != 0 && (c->gone || uv_stream_get_write_queue_size((uv_stream_t *)&c->tcp) <= PORF_SRV_LOW)) porf_srv_pump(c);
}

// bytes out (taking data, a malloc'd buffer whose first len bytes go), after what is queued:
// straight to the socket when nothing is, the rest queued. -1 once the client is gone
static int porf_srv_send(porf_srv_conn *c, u8 *data, size_t len) {
  if (c->gone || c->closing) {
    free(data);
    return -1;
  }
  // corked bytes go first: they were written before these
  if (c->out.len > 0) porf_srv_flush(c);
  if (c->closing) {
    free(data);
    return -1;
  }
  size_t done = 0;
  uv_stream_t *stream = (uv_stream_t *)&c->tcp;
  if (uv_stream_get_write_queue_size(stream) == 0) {
    uv_buf_t buf = uv_buf_init((char *)data, (unsigned int)len);
    const int n = uv_try_write(stream, &buf, 1);
    if (n > 0) done = (size_t)n;
    else if (n < 0 && n != UV_EAGAIN) {
      free(data);
      porf_srv_close(c);
      return -1;
    }
  }
  if (done == len) {
    free(data);
    return 0;
  }
  porf_srv_write *w = malloc(sizeof(porf_srv_write));
  if (!w) abort();
  w->conn = c;
  w->data = data;
  uv_buf_t rest = uv_buf_init((char *)data + done, (unsigned int)(len - done));
  if (uv_write(&w->req, stream, &rest, 1, porf_srv_written) < 0) {
    free(data);
    free(w);
    porf_srv_close(c);
    return -1;
  }
  return 0;
}

static int porf_srv_send_copy(porf_srv_conn *c, const char *text, size_t len) {
  u8 *data = malloc(len + 1);
  if (!data) abort();
  memcpy(data, text, len);
  return porf_srv_send(c, data, len);
}

// Corked output: a streamed response's head and chunks gather on the connection, and go in one
// write when the loop is about to wait for I/O (a prepare handle: every promise job the handler's
// stream ran this turn has run), or once PORF_SRV_CORK bytes have gathered, or before a write that
// is not corked. A stream that gives its chunks at once is then one write, not one per chunk.
#define PORF_SRV_CORK (64 * 1024)
static porf_srv_conn *porf_srv_outs = NULL;
static uv_prepare_t porf_srv_prep;
static int porf_srv_prep_ready = 0, porf_srv_prep_on = 0;

static void porf_srv_flush(porf_srv_conn *c) {
  if (c->out.len == 0) return;
  u8 *data = c->out.data;
  const size_t len = c->out.len;
  c->out.data = NULL;
  c->out.len = c->out.cap = 0;
  porf_srv_send(c, data, len);
}

static void porf_srv_flush_all(uv_prepare_t *handle) {
  (void)handle;
  while (porf_srv_outs) {
    porf_srv_conn *c = porf_srv_outs;
    porf_srv_outs = c->next_out;
    c->out_listed = 0;
    porf_srv_flush(c);
    c->refs--;
    porf_srv_free(c);
  }
  uv_prepare_stop(&porf_srv_prep);
  porf_srv_prep_on = 0;
}

// bytes corked (copied): -1 once the client is gone
static int porf_srv_cork(porf_srv_conn *c, const u8 *data, size_t len) {
  if (c->gone || c->closing) return -1;
  porf_srv_append(&c->out, data, len);
  if (c->out.len >= PORF_SRV_CORK) {
    porf_srv_flush(c);
    return c->closing ? -1 : 0;
  }
  if (!c->out_listed) {
    c->out_listed = 1;
    c->refs++;
    c->next_out = porf_srv_outs;
    porf_srv_outs = c;
    if (!porf_srv_prep_ready) {
      uv_prepare_init(uv_default_loop(), &porf_srv_prep);
      uv_unref((uv_handle_t *)&porf_srv_prep);
      porf_srv_prep_ready = 1;
    }
    if (!porf_srv_prep_on) {
      uv_prepare_start(&porf_srv_prep, porf_srv_flush_all);
      porf_srv_prep_on = 1;
    }
  }
  return 0;
}

// the bytes waiting to be written: corked and queued
static size_t porf_srv_pending(porf_srv_conn *c) {
  return c->out.len + uv_stream_get_write_queue_size((uv_stream_t *)&c->tcp);
}

// the Date header's value, made again once the loop's clock (uv_now: no system call) says a
// second has passed
static char porf_srv_date[32];
static time_t porf_srv_date_at = -1;
static u64 porf_srv_date_ms = 0;

static const char *porf_srv_now(void) {
  const u64 ms = uv_now(uv_default_loop());
  if (porf_srv_date_at != -1 && ms - porf_srv_date_ms < 1000) return porf_srv_date;
  porf_srv_date_ms = ms;
  const time_t now = time(NULL);
  if (now != porf_srv_date_at) {
    static const char *days[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    static const char *months[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    struct tm tm;
    gmtime_r(&now, &tm);
    snprintf(porf_srv_date, sizeof(porf_srv_date), "%s, %02d %s %04d %02d:%02d:%02d GMT", days[tm.tm_wday], tm.tm_mday, months[tm.tm_mon], tm.tm_year + 1900, tm.tm_hour, tm.tm_min, tm.tm_sec);
    porf_srv_date_at = now;
  }
  return porf_srv_date;
}

// a status's reason phrase, when the Response has no statusText
static const char *porf_srv_reason(int status) {
  switch (status) {
    case 100: return "Continue";
    case 101: return "Switching Protocols";
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 203: return "Non-Authoritative Information";
    case 204: return "No Content";
    case 205: return "Reset Content";
    case 206: return "Partial Content";
    case 207: return "Multi-Status";
    case 300: return "Multiple Choices";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 402: return "Payment Required";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 406: return "Not Acceptable";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 410: return "Gone";
    case 411: return "Length Required";
    case 412: return "Precondition Failed";
    case 413: return "Content Too Large";
    case 414: return "URI Too Long";
    case 415: return "Unsupported Media Type";
    case 416: return "Range Not Satisfiable";
    case 417: return "Expectation Failed";
    case 418: return "I'm a Teapot";
    case 421: return "Misdirected Request";
    case 422: return "Unprocessable Content";
    case 425: return "Too Early";
    case 426: return "Upgrade Required";
    case 428: return "Precondition Required";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 451: return "Unavailable For Legal Reasons";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    case 505: return "HTTP Version Not Supported";
    case 507: return "Insufficient Storage";
    case 511: return "Network Authentication Required";
    default: return "";
  }
}

// a number's decimal digits (base 10) or hex digits (base 16) appended
static void porf_srv_put_uint(porf_srv_buf *out, u64 n, int base) {
  char digits[24];
  int at = 24;
  do {
    const int d = (int)(n % (u64)base);
    digits[--at] = (char)(d < 10 ? '0' + d : 'a' + d - 10);
    n /= (u64)base;
  } while (n > 0);
  porf_srv_append(out, digits + at, (size_t)(24 - at));
}

// llhttp's callbacks: the head copied for JS, the body kept for it, a stop after each message
static porf_srv_conn *porf_srv_of(llhttp_t *parser) {
  return (porf_srv_conn *)parser->data;
}

static int porf_srv_head_add(porf_srv_conn *c, const char *at, size_t len, int lower) {
  if (c->head.len + len > PORF_SRV_HEAD_MAX) {
    c->error = 431;
    return -1;
  }
  porf_srv_reserve(&c->head, len + 1);
  u8 *out = c->head.data + c->head.len;
  if (lower) for (size_t i = 0; i < len; i++) out[i] = (u8)((at[i] >= 'A' && at[i] <= 'Z') ? at[i] + 32 : at[i]);
  else memcpy(out, at, len);
  c->head.len += len;
  return 0;
}

static int porf_srv_on_begin(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  c->head.len = 0;
  c->complete = 0;
  c->expect = 0;
  c->hosts = 0;
  c->flags = 0;
  return 0;
}

static int porf_srv_on_url(llhttp_t *parser, const char *at, size_t len) {
  return porf_srv_head_add(porf_srv_of(parser), at, len, 0);
}

static int porf_srv_on_field(llhttp_t *parser, const char *at, size_t len) {
  porf_srv_conn *c = porf_srv_of(parser);
  if (c->name_at == (size_t)-1) c->name_at = c->head.len;
  return porf_srv_head_add(c, at, len, 1);
}

static int porf_srv_on_value(llhttp_t *parser, const char *at, size_t len) {
  porf_srv_conn *c = porf_srv_of(parser);
  if (c->value_at == (size_t)-1) c->value_at = c->head.len;
  return porf_srv_head_add(c, at, len, 0);
}

static int porf_srv_on_part_end(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  if (porf_srv_head_add(c, "", 0, 0) < 0) return -1;
  c->head.data[c->head.len++] = 0;
  return 0;
}

static int porf_srv_on_field_end(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  c->value_at = (size_t)-1;
  return porf_srv_on_part_end(parser);
}

static int porf_srv_on_value_end(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  // (an empty value has no data callback: it starts here)
  if (c->value_at == (size_t)-1) c->value_at = c->head.len;
  // trailing whitespace is no part of a value (llhttp leaves it; the leading is skipped)
  while (c->head.len > c->value_at && (c->head.data[c->head.len - 1] == ' ' || c->head.data[c->head.len - 1] == 9)) c->head.len--;
  const size_t value_len = c->head.len - c->value_at;
  const u8 *name = c->head.data + c->name_at;
  if (c->value_at - c->name_at == 5 && !memcmp(name, "host", 4)) c->hosts++;
  if (c->value_at - c->name_at == 7 && !memcmp(name, "expect", 6) && value_len == 12 && !strncasecmp((const char *)c->head.data + c->value_at, "100-continue", 12)) c->expect = 1;
  c->name_at = (size_t)-1;
  return porf_srv_on_part_end(parser);
}

// a target JS can take as it is: an origin-form path whose URL is the same text (no dot
// segments, backslashes or bytes the URL parser would escape)
static int porf_srv_plain_target(const u8 *s, size_t len) {
  if (len == 0 || s[0] != '/') return 0;
  for (size_t i = 0; i < len; i++) {
    const u8 ch = s[i];
    if (ch <= 32 || ch >= 127 || ch == '"' || ch == '<' || ch == '>' || ch == '\\' || ch == '^' || ch == 96 || ch == '{' || ch == '|' || ch == '}' || ch == '#') return 0;
    if (ch == '?') return 1;
    if (ch == '.' && s[i - 1] == '/') return 0;
    if (ch == '%' && i + 2 < len && s[i + 1] == '2' && (s[i + 2] == 'e' || s[i + 2] == 'E')) return 0;
  }
  return 1;
}

// a Host the URL parser leaves as it is: a lower-case name (not one it would read as an IPv4
// address) or a dotted-quad address, and a port that is not 80
static int porf_srv_plain_host(const u8 *s, size_t len) {
  size_t end = len;
  for (size_t i = 0; i < len; i++) if (s[i] == ':') { end = i; break; }
  if (end == 0) return 0;
  if (end < len) {
    const size_t digits = len - end - 1;
    if (digits == 0 || digits > 5 || s[end + 1] == '0') return 0;
    for (size_t i = end + 1; i < len; i++) if (s[i] < '0' || s[i] > '9') return 0;
    if (digits == 2 && s[end + 1] == '8' && s[end + 2] == '0') return 0;
  }
  // the last label decides whether it is an address: a digit starts one
  size_t last = 0;
  for (size_t i = 0; i < end; i++) {
    const u8 ch = s[i];
    if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '.')) return 0;
    if (ch == '.') last = i + 1;
  }
  if (s[end - 1] == '.' || s[0] == '.') return 0;
  if (s[last] < '0' || s[last] > '9') return 1;
  int parts = 0;
  size_t at = 0;
  while (at < end) {
    size_t n = 0;
    int value = 0;
    while (at + n < end && s[at + n] >= '0' && s[at + n] <= '9') value = value * 10 + (s[at + n++] - '0');
    if (n == 0 || n > 3 || value > 255 || (n > 1 && s[at] == '0')) return 0;
    parts++;
    at += n;
    if (at < end) {
      if (s[at] != '.') return 0;
      at++;
    }
  }
  return parts == 4;
}

static int porf_srv_on_head_end(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  // the method first: head is then method \0 target \0 (name \0 value \0)*
  const char *method = llhttp_method_name((llhttp_method_t)llhttp_get_method(parser));
  const size_t n = strlen(method);
  porf_srv_reserve(&c->head, n + 1);
  memmove(c->head.data + n + 1, c->head.data, c->head.len);
  memcpy(c->head.data, method, n);
  c->head.data[n] = 0;
  c->head.len += n + 1;
  c->minor = llhttp_get_http_minor(parser);
  // RFC 9112 3.2: a 400 for more than one Host, or (HTTP/1.1) none
  if (c->hosts > 1 || (c->hosts == 0 && c->minor >= 1)) {
    c->error = 400;
    return -1;
  }
  c->keep = llhttp_should_keep_alive(parser);
  if (llhttp_get_upgrade(parser)) c->keep = 0;
  if ((parser->flags & F_CHUNKED) || parser->content_length > 0) c->flags |= PORF_SRV_HAS_BODY;
  // plain: the target (after the method) and the Host header's value
  const u8 *target = c->head.data + n + 1;
  const size_t target_len = strlen((const char *)target);
  if (porf_srv_plain_target(target, target_len)) {
    size_t at = n + 1 + target_len + 1;
    while (at < c->head.len) {
      const u8 *name = c->head.data + at;
      const size_t name_len = strlen((const char *)name);
      const u8 *value = name + name_len + 1;
      const size_t value_len = strlen((const char *)value);
      if (name_len == 4 && !memcmp(name, "host", 4)) {
        if (porf_srv_plain_host(value, value_len)) c->flags |= PORF_SRV_PLAIN;
        break;
      }
      at += name_len + value_len + 2;
    }
  }
  c->head_ready = 1;
  return 0;
}

static int porf_srv_on_body(llhttp_t *parser, const char *at, size_t len) {
  porf_srv_conn *c = porf_srv_of(parser);
  if (!c->discard) porf_srv_append(&c->body, at, len);
  return 0;
}

static int porf_srv_on_complete(llhttp_t *parser) {
  porf_srv_conn *c = porf_srv_of(parser);
  c->complete = 1;
  // one message at a time: the next is parsed once this one is answered
  return HPE_PAUSED;
}

static void porf_srv_alloc(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
  porf_srv_conn *c = handle->data;
  (void)suggested;
  // what was parsed goes, so the buffer holds only what is still to be
  if (c->in_at == c->in.len) c->in.len = c->in_at = 0;
  else if (c->in_at > 0 && c->in.cap - c->in.len < 16384) {
    memmove(c->in.data, c->in.data + c->in_at, c->in.len - c->in_at);
    c->in.len -= c->in_at;
    c->in_at = 0;
  }
  porf_srv_reserve(&c->in, 65536);
  *buf = uv_buf_init((char *)c->in.data + c->in.len, (unsigned int)(c->in.cap - c->in.len));
}

// what the client sent, parsed as far as it may be: up to the end of a message
static void porf_srv_parse(porf_srv_conn *c) {
  if (c->paused || c->error || c->in_at >= c->in.len) return;
  const char *from = (const char *)c->in.data + c->in_at;
  const llhttp_errno_t rc = llhttp_execute(&c->parser, from, c->in.len - c->in_at);
  if (rc == HPE_OK) {
    c->in_at = c->in.len;
  } else if (rc == HPE_PAUSED || rc == HPE_PAUSED_UPGRADE) {
    c->in_at += (size_t)(llhttp_get_error_pos(&c->parser) - from);
    c->paused = 1;
  } else {
    if (!c->error) c->error = 400;
    c->in_at = c->in.len;
  }
}

static void porf_srv_read(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf);

// the answered message's end: the next one may be parsed
static void porf_srv_resume(porf_srv_conn *c) {
  if (!c->paused || !c->complete || c->busy || c->gone) return;
  c->paused = 0;
  c->complete = 0;
  c->discard = 0;
  c->body.len = 0;
  llhttp_resume(&c->parser);
}

// the socket read while there is room: for body JS has not taken, for what waits behind a
// request being answered (pipelined requests)
static void porf_srv_reads(porf_srv_conn *c) {
  if (c->closing || c->gone || c->eof) return;
  const int room = c->paused ? c->in.len - c->in_at < PORF_SRV_BEHIND : c->body.len < PORF_SRV_HIGH;
  if (room && !c->reading) {
    uv_read_start((uv_stream_t *)&c->tcp, porf_srv_alloc, porf_srv_read);
    c->reading = 1;
  } else if (!room) porf_srv_stop_reading(c);
}

// everything that can go on, does: parsing, a new request to JS, the client's leaving told, waits
// settled, the socket read or not. JS runs here, so only the loop's callbacks pump (a C function
// JS calls never does: porf_srv_later), and a pump JS starts meanwhile goes round this one again
static void porf_srv_pump(porf_srv_conn *c) {
  if (c->pumping) {
    c->repump = 1;
    return;
  }
  c->pumping = 1;
  c->refs++;
  do {
    c->repump = 0;
    porf_srv_resume(c);
    // (a request being answered has its body parsed as it comes; the next request waits
    // behind it, the parser stopped at its end)
    porf_srv_parse(c);
    if (c->error && !c->busy && !c->closing) {
      char text[160];
      const int code = c->error;
      const int len = snprintf(text, sizeof(text), "HTTP/1.1 %d %s\r\nconnection: close\r\ncontent-length: 0\r\ndate: %s\r\n\r\n", code, porf_srv_reason(code), porf_srv_now());
      porf_srv_send_copy(c, text, (size_t)len);
      porf_srv_end(c);
      break;
    }
    if (c->head_ready && !c->busy && !c->closing) {
      c->head_ready = 0;
      c->busy = 1;
      c->told = 0;
      c->left = 0;
      c->chunked = 0;
      c->refs++;
      if (c->expect && c->minor >= 1 && !c->complete) porf_srv_send_copy(c, "HTTP/1.1 100 Continue\r\n\r\n", 25);
      ${incoming}(porf_box_num((f64)(uintptr_t)c));
    }
    if (c->busy && (c->gone || c->left) && !c->told) {
      c->told = 1;
      ${gone}(porf_box_num((f64)(uintptr_t)c));
    }
    if (c->body_wait != 0 && (c->body.len > 0 || c->complete || c->gone || c->error)) {
      const f64 token = c->body_wait;
      c->body_wait = 0;
      ${settle}(porf_box_num(token));
    }
    if (c->drain_wait != 0 && (c->gone || uv_stream_get_write_queue_size((uv_stream_t *)&c->tcp) <= PORF_SRV_LOW)) {
      const f64 token = c->drain_wait;
      c->drain_wait = 0;
      ${settle}(porf_box_num(token));
    }
  } while (c->repump && !c->closing);
  // the client has sent all it will, and all of it is answered
  if (c->eof && !c->busy) porf_srv_end(c);
  porf_srv_reads(c);
  c->pumping = 0;
  c->refs--;
  porf_srv_free(c);
}

// the connections to pump on the loop's next turn: what JS finished lets the next pipelined
// request be parsed, and it is handed to JS from the loop, not from inside the JS that finished
static uv_idle_t porf_srv_idle;
static int porf_srv_idle_ready = 0;
static porf_srv_conn **porf_srv_due = NULL;
static size_t porf_srv_due_len = 0, porf_srv_due_cap = 0;

static void porf_srv_run_due(uv_idle_t *handle) {
  const size_t n = porf_srv_due_len;
  porf_srv_conn **due = malloc(n * sizeof(porf_srv_conn *) + 1);
  if (!due) abort();
  memcpy(due, porf_srv_due, n * sizeof(porf_srv_conn *));
  porf_srv_due_len = 0;
  for (size_t i = 0; i < n; i++) {
    due[i]->queued = 0;
    due[i]->refs--;
    porf_srv_pump(due[i]);
  }
  free(due);
  if (porf_srv_due_len == 0) uv_idle_stop(handle);
}

static void porf_srv_later(porf_srv_conn *c) {
  if (c->queued) return;
  if (!porf_srv_idle_ready) {
    uv_idle_init(uv_default_loop(), &porf_srv_idle);
    porf_srv_idle_ready = 1;
  }
  if (porf_srv_due_len == porf_srv_due_cap) {
    porf_srv_due_cap = porf_srv_due_cap * 2 + 16;
    porf_srv_due = realloc(porf_srv_due, porf_srv_due_cap * sizeof(porf_srv_conn *));
    if (!porf_srv_due) abort();
  }
  c->queued = 1;
  c->refs++;
  porf_srv_due[porf_srv_due_len++] = c;
  uv_idle_start(&porf_srv_idle, porf_srv_run_due);
}

static void porf_srv_read(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf) {
  porf_srv_conn *c = stream->data;
  (void)buf;
  if (n > 0) {
    c->in.len += (size_t)n;
  } else if (n == UV_EOF) {
    // the client has sent all it will: what it sent is answered, then the connection ends. A
    // request cut short by it is a client gone; one being answered has its signal aborted (the
    // client has most likely closed, as Bun and Deno take an end), its response still written
    porf_srv_stop_reading(c);
    c->eof = 1;
    if (c->busy && !c->complete) c->gone = 1;
    else if (c->busy) c->left = 1;
  } else if (n < 0) {
    porf_srv_close(c);
  } else {
    return;
  }
  porf_srv_pump(c);
}

static void porf_srv_accept(uv_stream_t *server, int status) {
  if (status < 0) return;
  porf_srv_conn *c = calloc(1, sizeof(porf_srv_conn));
  if (!c) abort();
  uv_tcp_init(uv_default_loop(), &c->tcp);
  c->tcp.data = c;
  c->refs = 1;
  c->name_at = c->value_at = (size_t)-1;
  if (uv_accept(server, (uv_stream_t *)&c->tcp) < 0) {
    porf_srv_close(c);
    return;
  }
  uv_tcp_nodelay(&c->tcp, 1);
  llhttp_init(&c->parser, HTTP_REQUEST, &porf_srv_settings);
  c->parser.data = c;
  porf_srv_pump(c);
}

// a listener that could not listen, freed
static void porf_srv_unlisten(uv_handle_t *handle) {
  free(handle->data);
}

static void porf_srv_setup(void) {
  if (porf_srv_settings_ready) return;
  porf_srv_settings_ready = 1;
  llhttp_settings_init(&porf_srv_settings);
  porf_srv_settings.on_message_begin = porf_srv_on_begin;
  porf_srv_settings.on_url = porf_srv_on_url;
  porf_srv_settings.on_url_complete = porf_srv_on_part_end;
  porf_srv_settings.on_header_field = porf_srv_on_field;
  porf_srv_settings.on_header_field_complete = porf_srv_on_field_end;
  porf_srv_settings.on_header_value = porf_srv_on_value;
  porf_srv_settings.on_header_value_complete = porf_srv_on_value_end;
  porf_srv_settings.on_headers_complete = porf_srv_on_head_end;
  porf_srv_settings.on_body = porf_srv_on_body;
  porf_srv_settings.on_message_complete = porf_srv_on_complete;
}

// a JS string of one-byte characters (a header list, a reason) as bytes, into out: a byte string's
// as they are, a UTF-16 one's low bytes (Headers holds byte strings: every unit is below 256)
static void porf_srv_put_text(porf_srv_buf *out, jsval text, i32 type) {
  const u32 ptr = text.val < 0 ? (u32)(i32)text.val : (u32)text.val;
  const i32 len = *((i32 *)(MEM + ptr));
  porf_srv_reserve(out, (size_t)len);
  if (type == 67) {
    for (i32 i = 0; i < len; i++) out->data[out->len + i] = (u8)(*((u16 *)(MEM + ptr + 4 + i * 2)) & 0xff);
  } else memcpy(out->data + out->len, MEM + ptr + 4, (size_t)len);
  out->len += (size_t)len;
}

// a Uint8Array's bytes: where they are, how many
static const u8 *porf_srv_bytes(jsval array, size_t *len) {
  const u32 at = array.val < 0 ? (u32)(i32)array.val : (u32)array.val;
  *len = (size_t)*((i32 *)(MEM + at));
  return (const u8 *)(MEM + *((u32 *)(MEM + at + 4)) + 4);
}
`;

/** Listens on host:port; the port bound (port 0 picks one), or a negative libuv error. */
function srvListen(host, port) {
	const hostType = Porffor.type(host);
	let out = 0;
	Porffor.c`
{
porf_srv_setup();
porf_uv_loop_use();
#ifndef _WIN32
// a write to a client that has gone is an error to handle (EPIPE), not the end of the process
signal(SIGPIPE, SIG_IGN);
#endif
porf_srv *s = calloc(1, sizeof(porf_srv));
if (!s) abort();
char *host_owned;
char *host_text = __porffor_node_cstr(MEM, ${host}, (i32)PORF_NUM(${hostType}), &host_owned);
struct sockaddr_storage addr;
int rc = strchr(host_text, ':') ? uv_ip6_addr(host_text, (int)PORF_NUM(${port}), (struct sockaddr_in6 *)&addr) : uv_ip4_addr(host_text, (int)PORF_NUM(${port}), (struct sockaddr_in *)&addr);
if (host_owned) free(host_owned);
uv_tcp_init(uv_default_loop(), &s->tcp);
s->tcp.data = s;
if (rc == 0) rc = uv_tcp_bind(&s->tcp, (const struct sockaddr *)&addr, 0);
if (rc == 0) rc = uv_listen((uv_stream_t *)&s->tcp, 511, porf_srv_accept);
if (rc == 0) {
  struct sockaddr_storage bound;
  int size = sizeof(bound);
  uv_tcp_getsockname(&s->tcp, (struct sockaddr *)&bound, &size);
  ${out} = bound.ss_family == AF_INET6 ? ntohs(((struct sockaddr_in6 *)&bound)->sin6_port) : ntohs(((struct sockaddr_in *)&bound)->sin_port);
} else {
  uv_close((uv_handle_t *)&s->tcp, porf_srv_unlisten);
  ${out} = rc;
}
}
`;
	return out;
}

/** A libuv error's name and message (EADDRINUSE: address already in use). */
function srvError(code) {
	let len = 0;
	let buf = 0;
	Porffor.c`
{
char text[160];
snprintf(text, sizeof(text), "%s: %s", uv_err_name((int)PORF_NUM(${code})), uv_strerror((int)PORF_NUM(${code})));
${len} = strlen(text);
${buf} = (f64)(u64)strdup(text);
}
`;
	const out = Porffor.malloc(len + 6);

	Porffor.c`
u32 out_at = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
*((i32*)(MEM + out_at)) = (i32)PORF_NUM(${len});
memcpy(MEM + out_at + 4, (void*)(u64)PORF_NUM(${buf}), (size_t)PORF_NUM(${len}));
free((void*)(u64)PORF_NUM(${buf}));
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
}

/** The request's head: method \0 target \0 (name \0 value \0)*, one byte a character. */
function srvHead(ptr) {
	let len = 0;
	Porffor.c`${len} = (f64)((porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr}))->head.len;`;
	const out = Porffor.malloc(len + 6);

	Porffor.c`
u32 out_at = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
*((i32*)(MEM + out_at)) = (i32)c->head.len;
memcpy(MEM + out_at + 4, c->head.data, c->head.len);
`;
	return Porffor.as(out, Porffor.TYPES.bytestring);
}

/** The request's PLAIN and HAS_BODY flags. */
function srvFlags(ptr) {
	let out = 0;
	Porffor.c`${out} = ((porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr}))->flags;`;
	return out;
}

/** How many body bytes there are to take now. */
function srvAvailable(ptr) {
	let out = 0;
	Porffor.c`${out} = (f64)((porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr}))->body.len;`;
	return out;
}

/** 1: the body has ended (once what there is is taken); -1: it never will (cut short); else 0. */
function srvBodyState(ptr) {
	let out = 0;
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
${out} = c->complete ? 1 : (c->gone || c->error) ? -1 : 0;
}
`;
	return out;
}

/** The body bytes there are, taken into out (a Uint8Array of srvAvailable's length). */
function srvTake(ptr, out) {
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
size_t len;
u8 *into = (u8 *)porf_srv_bytes(${out}, &len);
if (len > c->body.len) len = c->body.len;
memcpy(into, c->body.data, len);
memmove(c->body.data, c->body.data + len, c->body.len - len);
c->body.len -= len;
porf_srv_reads(c);
}
`;
}

/** A wait for body bytes (or the body's end, or the client leaving): its token settles then. */
function srvWaitBody(token, ptr) {
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
c->body_wait = PORF_NUM(${token});
}
`;
}

/** A wait for the write queue to drain (or the client leaving): its token settles then. */
function srvWaitDrain(token, ptr) {
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
c->drain_wait = PORF_NUM(${token});
}
`;
}

/**
 * The response's head (status line, the app's headers as `lines`, the framing, the date) and,
 * with BODY, its body's bytes: one write. The bytes queued after it; -1 once the client is gone.
 */
function srvRespond(ptr, status, reason, lines, length, body, flags) {
	const reasonType = Porffor.type(reason);
	const linesType = Porffor.type(lines);
	let out = 0;
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
const int code = (int)PORF_NUM(${status});
const int bits = (int)PORF_NUM(${flags});
porf_srv_buf msg = { 0 };
size_t body_len = 0;
const u8 *body_data = (bits & PORF_SRV_BODY) ? porf_srv_bytes(${body}, &body_len) : NULL;
porf_srv_reserve(&msg, 256 + body_len);
porf_srv_append(&msg, c->minor >= 1 ? "HTTP/1.1 " : "HTTP/1.0 ", 9);
porf_srv_put_uint(&msg, (u64)code, 10);
porf_srv_append(&msg, " ", 1);
if (*((i32 *)(MEM + (u32)${reason}.val)) == 0) {
  const char *text = porf_srv_reason(code);
  porf_srv_append(&msg, text, strlen(text));
} else porf_srv_put_text(&msg, ${reason}, (i32)PORF_NUM(${reasonType}));
porf_srv_append(&msg, "\r\n", 2);
porf_srv_put_text(&msg, ${lines}, (i32)PORF_NUM(${linesType}));
if (bits & PORF_SRV_LENGTH) {
  porf_srv_append(&msg, "content-length: ", 16);
  porf_srv_put_uint(&msg, (u64)PORF_NUM(${length}), 10);
  porf_srv_append(&msg, "\r\n", 2);
}
if (bits & PORF_SRV_STREAM) {
  // HTTP/1.0 has no chunks: the body ends with the connection
  if (c->minor >= 1) {
    c->chunked = 1;
    porf_srv_append(&msg, "transfer-encoding: chunked\r\n", 28);
  } else c->keep = 0;
}
if (!c->keep) porf_srv_append(&msg, "connection: close\r\n", 19);
else if (c->minor == 0) porf_srv_append(&msg, "connection: keep-alive\r\n", 24);
if (!(bits & PORF_SRV_OWN_DATE)) {
  porf_srv_append(&msg, "date: ", 6);
  porf_srv_append(&msg, porf_srv_now(), 29);
  porf_srv_append(&msg, "\r\n", 2);
}
porf_srv_append(&msg, "\r\n", 2);
if (body_len > 0) porf_srv_append(&msg, body_data, body_len);
// a streamed body's head waits for its first chunks (one write)
if (bits & PORF_SRV_STREAM) {
  const int corked = porf_srv_cork(c, msg.data, msg.len);
  free(msg.data);
  ${out} = corked < 0 ? -1 : (f64)porf_srv_pending(c);
} else ${out} = porf_srv_send(c, msg.data, msg.len) < 0 ? -1 : (f64)porf_srv_pending(c);
}
`;
	return out;
}

/** A streamed body's chunk: the bytes queued after it; -1 once the client is gone. */
function srvChunk(ptr, bytes) {
	let out = 0;
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
size_t len;
const u8 *data = porf_srv_bytes(${bytes}, &len);
int corked = 0;
if (c->chunked) {
  char size_line[24];
  int size_len = 0;
  size_t left = len;
  char digits[16];
  int n = 0;
  do {
    digits[n++] = "0123456789abcdef"[left & 15];
    left >>= 4;
  } while (left > 0);
  while (n > 0) size_line[size_len++] = digits[--n];
  size_line[size_len++] = '\r';
  size_line[size_len++] = '\n';
  corked = porf_srv_cork(c, (const u8 *)size_line, (size_t)size_len);
}
if (corked == 0) corked = porf_srv_cork(c, data, len);
if (corked == 0 && c->chunked) corked = porf_srv_cork(c, (const u8 *)"\r\n", 2);
${out} = corked < 0 ? -1 : (f64)porf_srv_pending(c);
}
`;
	return out;
}

/**
 * The response is done (ok: whole; else cut short, and the connection closes without a chunked
 * body's end). The connection goes on to its next request, or closes.
 */
function srvFinish(ptr, ok) {
	Porffor.c`
{
porf_srv_conn *c = (porf_srv_conn *)(uintptr_t)PORF_NUM(${ptr});
if (PORF_NUM(${ok}) == 0) porf_srv_close(c);
else if (c->chunked) porf_srv_cork(c, (const u8 *)"0\r\n\r\n", 5);
c->busy = 0;
c->body_wait = c->drain_wait = 0;
if (!c->keep || c->gone) porf_srv_end(c);
else {
  // an unread body: the rest of it dropped, the next request parsed after it
  if (!c->complete) {
    c->discard = 1;
    c->body.len = 0;
  }
  porf_srv_resume(c);
  // a request behind it: parsed and handed over on the loop's next turn (even from a client
  // that has ended its side: it still reads the answers)
  if (c->in_at < c->in.len) porf_srv_later(c);
  else if (c->eof) porf_srv_end(c);
  else porf_srv_reads(c);
}
c->refs--;
porf_srv_free(c);
}
`;
}

/** Waits for the host's operation under token (settled by the C). */
function hostWait(token) {
	return rtAwait(token, () => undefined);
}

/** The request body, as a stream read from the connection as it is read. */
function requestBody(ptr, state) {
	return new ReadableStream(
		{
			async pull(controller) {
				while (true) {
					// the response is done: what was not read is dropped
					if (state.done) return controller.close();
					const available = srvAvailable(ptr);

					if (available > 0) {
						const out = new Uint8Array(available);

						srvTake(ptr, out);

						return controller.enqueue(out);
					}
					const ended = srvBodyState(ptr);

					if (ended === 1) return controller.close();

					if (ended === -1) throw new TypeError('the request body was cut short');
					const token = rtToken();

					srvWaitBody(token, ptr);
					await hostWait(token);
				}
			}
		},
		{ highWaterMark: 0 }
	);
}

/** The request C has parsed on the connection, as a Request. */
function makeRequest(ptr, state) {
	const head = srvHead(ptr);
	const flags = srvFlags(ptr);
	let end = head.indexOf('\0');
	const method = head.slice(0, end);
	let at = end + 1;

	end = head.indexOf('\0', at);
	const target = head.slice(at, end);

	at = end + 1;
	const list = [];
	let host = '';

	while (at < head.length) {
		end = head.indexOf('\0', at);
		const name = head.slice(at, end);

		at = end + 1;
		end = head.indexOf('\0', at);
		const value = head.slice(at, end);

		at = end + 1;
		list.push([name, value]);

		if (name === 'host' && host === '') host = value;
	}
	const headers = new Headers();

	headers._list = list;
	let url;

	if ((flags & PLAIN) !== 0) url = 'http://' + host + target;
	else {
		// an absolute-form target (a proxy's) is the URL; another is the Host's
		const base = 'http://' + (host === '' ? 'localhost' : host);

		url = new URL(target.startsWith('/') || target === '*' ? base + target : target, base).href;
	}
	const bodyless = (flags & HAS_BODY) === 0 || method === 'GET' || method === 'HEAD';

	if (bodyless) return incomingRequest(url, method, headers, null, null);

	// all of the body here already (a small one comes with its head): its bytes, read with no
	// stream (body.mjs's KnownBody); else streamed in as it comes
	if (srvBodyState(ptr) === 1) {
		const bytes = new Uint8Array(srvAvailable(ptr));

		if (bytes.length > 0) srvTake(ptr, bytes);

		return incomingRequest(url, method, headers, new KnownBody(bytes, null), null);
	}

	return incomingRequest(url, method, headers, requestBody(ptr, state), null);
}

/** The app's headers as the head's lines, those the server frames the response with left out. */
function headerLines(response, framed) {
	let lines = '';

	for (const pair of response.headers._list) {
		const name = pair[0];

		if (framed && FRAMING.includes(name)) continue;
		lines += name + ': ' + pair[1] + '\r\n';
	}

	return lines;
}

/** Whether the app gave the response a date header. */
function hasDate(response) {
	for (const pair of response.headers._list) if (pair[0] === 'date') return true;

	return false;
}

/** Writes a streamed body chunk by chunk; false when it failed or the client left. */
async function writeStream(ptr, state, stream) {
	const reader = stream.getReader();

	state.reader = reader;

	try {
		while (true) {
			const { value, done } = await reader.read();

			// (a client gone cancelled the stream: its reads end)
			if (state.gone) return false;

			if (done) return true;

			if (!(value instanceof Uint8Array))
				throw new TypeError('a response body stream must give Uint8Arrays');

			if (value.length === 0) continue;
			const queued = srvChunk(ptr, value);

			if (queued < 0) {
				await reader.cancel(state.request.signal.reason);

				return false;
			}

			// backpressure: the socket's queue drains before the stream is read on
			if (queued > HIGH) {
				const token = rtToken();

				srvWaitDrain(token, ptr);
				await hostWait(token);
			}
		}
	} catch (error) {
		if (!state.gone) console.error('response body failed: ' + (error?.message ?? error));

		return false;
	}
}

/**
 * Writes the app's Response out: at once when its body is empty or its bytes are known now (head
 * and body in one write), else streamed; the request is then done with.
 */
function write(ptr, state, response) {
	const status = response.status;
	const head = state.request.method === 'HEAD';
	const body = response._body;
	const date = hasDate(response) ? OWN_DATE : 0;

	if (body === null || NO_BODY.includes(status)) {
		// no body: a content-length of 0, unless the app gave its own (a HEAD's, a 304's)
		const own = listHas(response._headers._list, 'content-length');
		const flags = (own || NO_BODY.includes(status) ? 0 : LENGTH) | date;

		srvRespond(ptr, status, response.statusText, headerLines(response, !own), 0, null, flags);
	} else if (
		body instanceof KnownBody &&
		(body._stream === null || (!body._stream._disturbed && !body._stream.locked))
	) {
		// bytes known now, their stream never read (nor made): head and body in one write
		srvRespond(
			ptr,
			status,
			response.statusText,
			headerLines(response, true),
			body.source.length,
			body.source,
			LENGTH | (head ? 0 : BODY) | date
		);
	} else if (head) {
		body.stream.cancel().then(ignore, ignore);
		const own = listHas(response._headers._list, 'content-length');

		srvRespond(ptr, status, response.statusText, headerLines(response, !own), 0, null, date);
	} else {
		const queued = srvRespond(
			ptr,
			status,
			response.statusText,
			headerLines(response, true),
			0,
			null,
			STREAM | date
		);

		if (queued < 0) {
			body.stream.cancel().then(ignore, ignore);
			finish(ptr, state, false);
		} else
			writeStream(ptr, state, body.stream).then(
				(ok) => finish(ptr, state, ok),
				() => finish(ptr, state, false)
			);

		return;
	}
	finish(ptr, state, true);
}

/** The request is done with: the connection goes on without it. */
function finish(ptr, state, ok) {
	if (state.done) return;
	state.done = true;
	inFlight.delete(ptr);
	srvFinish(ptr, ok ? 1 : 0);
}

/** Starts answering the request C handed over. */
function start(ptr) {
	const state = { request: null, reader: null, gone: false, done: false };

	inFlight.set(ptr, state);

	try {
		state.request = makeRequest(ptr, state);
	} catch {
		// a target that is no URL: a 400, as a parse error is
		srvRespond(ptr, 400, '', '', 0, null, LENGTH);
		finish(ptr, state, true);

		return;
	}

	const response = respond(app, state.request);

	// a handler that answered at once is written now; another once its promise settles
	if (response instanceof Response) written(ptr, state, response);
	else response.then((settled) => written(ptr, state, settled), ignore);
}

/** Writes the response out, or cuts the connection when that fails. */
function written(ptr, state, response) {
	try {
		write(ptr, state, response);
	} catch (error) {
		console.error('response failed: ' + (error?.message ?? error));
		finish(ptr, state, false);
	}
}

/**
 * Serves app over HTTP/1.1: its fetch answers every request. It listens on app.port, else the
 * PORT environment variable, else 3000 (0: a free one), on app.hostname: by default every interface,
 * IPv6 and IPv4 both (::, as Node listens; 0.0.0.0 where there is no IPv6), so localhost reaches it
 * whichever address it resolves to. The program runs on while it listens.
 * @param {{ fetch(request: Request, env: object, ctx: object): Response | Promise<Response>,
 *   port?: number, hostname?: string }} served
 * @returns {{ port: number, hostname: string, url: URL }}
 */
export function serve(served) {
	checkApp(served);

	if (app !== null) throw new Error('porffor: a program serves one app');
	const portText = served.port ?? environment().PORT ?? 3000;
	const port = Number(portText);

	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		throw new RangeError(`serve: invalid port: ${portText}`);
	let hostname = served.hostname === undefined ? '::' : String(served.hostname);
	let bound = srvListen(hostname, port);

	if (bound < 0 && served.hostname === undefined) {
		hostname = '0.0.0.0';
		bound = srvListen(hostname, port);
	}

	if (bound < 0) throw new Error(`serve: cannot listen on ${hostname}:${port}: ${srvError(bound)}`);
	app = served;
	const shown = hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
	const url = new URL(`http://${shown.includes(':') ? `[${shown}]` : shown}:${bound}/`);

	console.error(`listening on ${url.href}`);

	return { port: bound, hostname, url };
}
