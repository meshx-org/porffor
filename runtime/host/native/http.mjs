// Native HTTP client: porffor:http's send, as HTTP/1.1 over libuv's TCP (uv_getaddrinfo,
// uv_tcp_connect, uv_read_start / uv_write on its default loop, which porf_start runs) and, for
// https, TLS by the vendored mbedTLS (runtime/c/mbedtls, linked as a cached archive:
// compiler/deps.js). runtime/host/wasi/http.mjs is the same over wasi:http.
//
// The C below is a byte stream and nothing more: it resolves, connects (each address in turn,
// IPv4 first), runs the TLS handshake (the peer verified against the system's roots, and its
// name against the host's: SNI and verification both), and moves bytes. mbedTLS never touches a
// socket: its I/O callbacks read the ciphertext libuv delivered into a buffer and write into
// another that goes out with uv_write, so a handshake or a read that needs more bytes returns
// MBEDTLS_ERR_SSL_WANT_READ and carries on when they arrive; the loop never blocks. Every wait
// (connected, written, bytes to read) is a promise under a token (./async.mjs) that the C settles.
//
// HTTP/1.1 itself is JS, below: the request head (connection: close, one request per
// connection), a body of known length or chunked, and the response head, then its body by
// content-length, chunked, or until the connection ends. Failures are TypeErrors whose payload
// names wasi:http's error-code, as a WASI build's are.
import { takeCString } from '../c.mjs';
import { rtAwait, rtCancel, rtOnCancel, rtSettle, rtToken } from './async.mjs';
import { ReadableStream } from '../../readable-stream.mjs';

// the C's error codes, as wasi:http's error-code names them
const ERRORS = [
	'',
	'DNS-error',
	'connection-refused',
	'connection-terminated',
	'TLS-certificate-error',
	'TLS-protocol-error',
	'TLS-alert-received',
	'destination-unavailable',
	'connection-timeout',
	'internal-error'
];
/** How many bytes one read of an unframed body hands on, at most. */
const CHUNK = 65_536;
/** The longest response head line read before the response is refused. */
const MAX_LINE = 65_536;
/** Statuses whose response has no body, whatever its headers say. */
const NO_BODY = [204, 304];

// libuv's callback for a wait that is over (connected, written, readable, or failed)
function settle(token) {
	rtSettle(token);
	__Porffor_promise_runJobs();
}

Porffor.c`
#include <uv.h>
#include <stddef.h>
// porffor_config.h trims mbedTLS to a TLS client: the library is built with it (sources.json),
// and these headers must see it too, or the structs differ
#define MBEDTLS_USER_CONFIG_FILE "porffor_config.h"
#include <mbedtls/ssl.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/x509_crt.h>
#include <psa/crypto.h>

// the error codes (ERRORS in the JS)
#define PORF_NET_DNS 1
#define PORF_NET_REFUSED 2
#define PORF_NET_TERMINATED 3
#define PORF_NET_TLS_CERT 4
#define PORF_NET_TLS_PROTOCOL 5
#define PORF_NET_TLS_ALERT 6
#define PORF_NET_UNREACHABLE 7
#define PORF_NET_TIMEOUT 8
#define PORF_NET_INTERNAL 9

// bytes read ahead of JS before the socket stops being read (the peer then waits)
#define PORF_NET_HIGH (256 * 1024)

typedef struct {
  u8 *data;
  size_t len, cap;
} porf_net_buf;

static void porf_net_reserve(porf_net_buf *buf, size_t more) {
  if (buf->cap - buf->len >= more) return;
  size_t cap = buf->cap * 2 + more;
  u8 *next = realloc(buf->data, cap);
  if (!next) abort();
  buf->data = next;
  buf->cap = cap;
}

static void porf_net_append(porf_net_buf *buf, const u8 *bytes, size_t len) {
  porf_net_reserve(buf, len);
  memcpy(buf->data + buf->len, bytes, len);
  buf->len += len;
}

static void porf_net_consume(porf_net_buf *buf, size_t len) {
  memmove(buf->data, buf->data + len, buf->len - len);
  buf->len -= len;
}

// one connection: libuv's handles and requests, mbedTLS's context, the bytes either way
typedef struct porf_net {
  uv_tcp_t *tcp;
  uv_getaddrinfo_t resolve;
  uv_connect_t connect;
  struct addrinfo *addrs;
  struct addrinfo **order;  // the addresses to try, IPv4 first
  int count, at;
  char *host;
  f64 op;       // the token of the connect or write in flight (0: none)
  f64 wait;     // the token of the wait for bytes in flight (0: none)
  int tls, open, reading;
  int eof;      // no more bytes will come (TLS: the plaintext's end)
  int in_eof;   // the socket's end (TLS: the ciphertext's)
  int error, detail;
  uint32_t verify;  // mbedTLS's verification flags, for a certificate error
  int closed;   // JS is done with it: freed once libuv is
  int refs;     // what still points here: the handle, the lookup, a settle under way
  porf_net_buf in;     // TLS: ciphertext read, not yet decrypted
  porf_net_buf out;    // TLS: records mbedTLS made, not yet written
  porf_net_buf plain;  // bytes for JS
  int ssl_ready;
  mbedtls_ssl_context ssl;
} porf_net;

// a write under way: its bytes are its own, and the last one of a JS write settles its op
typedef struct {
  uv_write_t req;
  porf_net *conn;
  u8 *data;
  int op;
} porf_net_write;

static void porf_net_maybe_free(porf_net *c) {
  if (!c->closed || c->refs > 0) return;
  if (c->ssl_ready) mbedtls_ssl_free(&c->ssl);
  if (c->addrs) uv_freeaddrinfo(c->addrs);
  free(c->order);
  free(c->in.data);
  free(c->out.data);
  free(c->plain.data);
  free(c->host);
  free(c);
}

// settles a wait: JS runs meanwhile (and may close c). 0 when c is gone after
static int porf_net_settle(porf_net *c, f64 *slot) {
  const f64 token = *slot;
  if (token == 0) return 1;
  *slot = 0;
  c->refs++;
  ${settle}(porf_box_num(token));
  c->refs--;
  if (c->closed && c->refs == 0) {
    porf_net_maybe_free(c);
    return 0;
  }
  return 1;
}

// the first failure sticks; whoever waits hears of it
static void porf_net_fail(porf_net *c, int error, int detail) {
  if (!c->error) {
    c->error = error;
    c->detail = detail;
  }
  if (c->tcp && c->reading) {
    uv_read_stop((uv_stream_t *)c->tcp);
    c->reading = 0;
  }
  if (porf_net_settle(c, &c->op)) porf_net_settle(c, &c->wait);
}

static void porf_net_tcp_closed(uv_handle_t *handle) {
  porf_net *c = handle->data;
  free(handle);
  c->refs--;
  porf_net_maybe_free(c);
}

static void porf_net_written(uv_write_t *req, int status) {
  porf_net_write *w = (porf_net_write *)req;
  porf_net *c = w->conn;
  const int op = w->op;
  free(w->data);
  free(w);
  if (c->closed) return;
  if (status < 0) {
    porf_net_fail(c, PORF_NET_TERMINATED, status);
    return;
  }
  if (op) porf_net_settle(c, &c->op);
}

// bytes out (taking them), in order after what is already going
static int porf_net_send(porf_net *c, u8 *data, size_t len, int op) {
  porf_net_write *w = malloc(sizeof(porf_net_write));
  if (!w) abort();
  w->conn = c;
  w->data = data;
  w->op = op;
  uv_buf_t buf = uv_buf_init((char *)data, (unsigned int)len);
  const int rc = uv_write(&w->req, (uv_stream_t *)c->tcp, &buf, 1, porf_net_written);
  if (rc < 0) {
    free(data);
    free(w);
  }
  return rc;
}

// the records mbedTLS has made, sent
static void porf_net_flush(porf_net *c) {
  if (c->out.len == 0 || c->closed || !c->tcp) return;
  u8 *data = c->out.data;
  const size_t len = c->out.len;
  c->out.data = NULL;
  c->out.len = c->out.cap = 0;
  const int rc = porf_net_send(c, data, len, 0);
  if (rc < 0) porf_net_fail(c, PORF_NET_TERMINATED, rc);
}

// mbedTLS's I/O: into and out of the buffers, never the socket
static int porf_tls_send(void *ctx, const unsigned char *bytes, size_t len) {
  porf_net_append(&((porf_net *)ctx)->out, bytes, len);
  return (int)len;
}

static int porf_tls_recv(void *ctx, unsigned char *bytes, size_t len) {
  porf_net *c = ctx;
  if (c->in.len == 0) return c->in_eof ? 0 : MBEDTLS_ERR_SSL_WANT_READ;
  if (len > c->in.len) len = c->in.len;
  memcpy(bytes, c->in.data, len);
  porf_net_consume(&c->in, len);
  return (int)len;
}

// what the process shares: the RNG, the roots, the client's configuration (1: ready, -1: failed)
static int porf_tls_state = 0;
static mbedtls_entropy_context porf_tls_entropy;
static mbedtls_ctr_drbg_context porf_tls_drbg;
static mbedtls_x509_crt porf_tls_roots;
static mbedtls_ssl_config porf_tls_conf;
static const char *porf_tls_alpn[] = { "http/1.1", NULL };

// the system's trusted roots: SSL_CERT_FILE / SSL_CERT_DIR as OpenSSL reads them, else the
// bundle where macOS and the Linux distributions keep it
static void porf_tls_load_roots(void) {
  const char *file = getenv("SSL_CERT_FILE");
  if (file && *file && mbedtls_x509_crt_parse_file(&porf_tls_roots, file) >= 0 && porf_tls_roots.version) return;
  const char *dir = getenv("SSL_CERT_DIR");
  if (dir && *dir && mbedtls_x509_crt_parse_path(&porf_tls_roots, dir) >= 0 && porf_tls_roots.version) return;
  static const char *files[] = {
    "/etc/ssl/cert.pem",                                  // macOS, Alpine, the BSDs
    "/etc/ssl/certs/ca-certificates.crt",                 // Debian, Ubuntu, Arch
    "/etc/pki/tls/certs/ca-bundle.crt",                   // Fedora, RHEL
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  // RHEL, CentOS
    "/etc/ssl/ca-bundle.pem",                             // openSUSE
    NULL
  };
  for (int i = 0; files[i]; i++) {
    if (mbedtls_x509_crt_parse_file(&porf_tls_roots, files[i]) >= 0 && porf_tls_roots.version) return;
  }
  mbedtls_x509_crt_parse_path(&porf_tls_roots, "/etc/ssl/certs");
}

static int porf_tls_init(void) {
  if (porf_tls_state) return porf_tls_state;
  porf_tls_state = -1;
  if (psa_crypto_init() != PSA_SUCCESS) return -1;
  mbedtls_entropy_init(&porf_tls_entropy);
  mbedtls_ctr_drbg_init(&porf_tls_drbg);
  mbedtls_x509_crt_init(&porf_tls_roots);
  mbedtls_ssl_config_init(&porf_tls_conf);
  if (mbedtls_ctr_drbg_seed(&porf_tls_drbg, mbedtls_entropy_func, &porf_tls_entropy, (const unsigned char *)"porffor", 7) != 0) return -1;
  porf_tls_load_roots();
  if (mbedtls_ssl_config_defaults(&porf_tls_conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT) != 0) return -1;
  mbedtls_ssl_conf_authmode(&porf_tls_conf, MBEDTLS_SSL_VERIFY_REQUIRED);
  mbedtls_ssl_conf_ca_chain(&porf_tls_conf, &porf_tls_roots, NULL);
  mbedtls_ssl_conf_rng(&porf_tls_conf, mbedtls_ctr_drbg_random, &porf_tls_drbg);
  mbedtls_ssl_conf_alpn_protocols(&porf_tls_conf, porf_tls_alpn);
  porf_tls_state = 1;
  return 1;
}

static int porf_tls_error(porf_net *c, int rc) {
  if (rc == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED) {
    c->verify = mbedtls_ssl_get_verify_result(&c->ssl);
    return PORF_NET_TLS_CERT;
  }
  if (rc == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE) return PORF_NET_TLS_ALERT;
  return PORF_NET_TLS_PROTOCOL;
}

// progress on what came in: the handshake, then plaintext for JS; whoever waits is told
static void porf_net_pump(porf_net *c) {
  if (c->closed || c->error) return;
  if (c->tls && !c->open) {
    const int rc = mbedtls_ssl_handshake(&c->ssl);
    porf_net_flush(c);
    if (rc == MBEDTLS_ERR_SSL_WANT_READ || rc == MBEDTLS_ERR_SSL_WANT_WRITE) return;
    if (rc == MBEDTLS_ERR_SSL_CONN_EOF) {
      porf_net_fail(c, PORF_NET_TERMINATED, UV_EOF);
      return;
    }
    if (rc != 0) {
      porf_net_fail(c, porf_tls_error(c, rc), rc);
      return;
    }
    c->open = 1;
    if (!porf_net_settle(c, &c->op) || c->closed) return;
  }
  if (!c->open) return;
  if (c->tls) {
    while (c->plain.len < PORF_NET_HIGH && !c->eof) {
      porf_net_reserve(&c->plain, 16384);
      const int rc = mbedtls_ssl_read(&c->ssl, c->plain.data + c->plain.len, c->plain.cap - c->plain.len);
      if (rc > 0) {
        c->plain.len += (size_t)rc;
        continue;
      }
      if (rc == MBEDTLS_ERR_SSL_WANT_READ || rc == MBEDTLS_ERR_SSL_WANT_WRITE) break;
      // TLS 1.3 sends tickets after the handshake: nothing to hand on
      if (rc == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue;
      // the end, whether the peer said so (close_notify) or only closed: HTTP's framing tells
      // a whole response from a cut one
      if (rc == 0 || rc == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || rc == MBEDTLS_ERR_SSL_CONN_EOF) {
        c->eof = 1;
        break;
      }
      porf_net_flush(c);
      porf_net_fail(c, porf_tls_error(c, rc), rc);
      return;
    }
    porf_net_flush(c);
  }
  if (c->plain.len >= PORF_NET_HIGH && c->reading) {
    uv_read_stop((uv_stream_t *)c->tcp);
    c->reading = 0;
  }
  if (c->wait != 0 && (c->plain.len > 0 || c->eof)) porf_net_settle(c, &c->wait);
}

static void porf_net_alloc(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
  porf_net *c = handle->data;
  porf_net_buf *into = c->tls ? &c->in : &c->plain;
  (void)suggested;
  porf_net_reserve(into, 65536);
  *buf = uv_buf_init((char *)into->data + into->len, (unsigned int)(into->cap - into->len));
}

static void porf_net_read(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf) {
  porf_net *c = stream->data;
  (void)buf;
  if (c->closed) return;
  if (n > 0) {
    (c->tls ? &c->in : &c->plain)->len += (size_t)n;
  } else if (n == UV_EOF) {
    c->in_eof = 1;
    if (!c->tls) c->eof = 1;
    uv_read_stop(stream);
    c->reading = 0;
  } else if (n < 0) {
    porf_net_fail(c, PORF_NET_TERMINATED, (int)n);
    return;
  } else {
    return;
  }
  porf_net_pump(c);
}

static int porf_net_connect_error(int status) {
  if (status == UV_ECONNREFUSED) return PORF_NET_REFUSED;
  if (status == UV_ETIMEDOUT) return PORF_NET_TIMEOUT;
  return PORF_NET_UNREACHABLE;
}

static void porf_net_try(porf_net *c);

static void porf_net_connected(uv_connect_t *req, int status) {
  porf_net *c = req->data;
  if (c->closed) return;
  if (status < 0) {
    // the next address, on a new handle (a failed one cannot connect again)
    c->detail = status;
    uv_close((uv_handle_t *)c->tcp, porf_net_tcp_closed);
    c->tcp = NULL;
    if (++c->at < c->count) porf_net_try(c);
    else porf_net_fail(c, porf_net_connect_error(status), status);
    return;
  }
  uv_tcp_nodelay(c->tcp, 1);
  uv_read_start((uv_stream_t *)c->tcp, porf_net_alloc, porf_net_read);
  c->reading = 1;
  if (!c->tls) {
    c->open = 1;
    porf_net_settle(c, &c->op);
    return;
  }
  mbedtls_ssl_init(&c->ssl);
  c->ssl_ready = 1;
  int rc = mbedtls_ssl_setup(&c->ssl, &porf_tls_conf);
  if (rc == 0) rc = mbedtls_ssl_set_hostname(&c->ssl, c->host);
  if (rc != 0) {
    porf_net_fail(c, PORF_NET_INTERNAL, rc);
    return;
  }
  mbedtls_ssl_set_bio(&c->ssl, c, porf_tls_send, porf_tls_recv, NULL);
  porf_net_pump(c);
}

static void porf_net_try(porf_net *c) {
  c->tcp = malloc(sizeof(uv_tcp_t));
  if (!c->tcp) abort();
  uv_tcp_init(uv_default_loop(), c->tcp);
  c->tcp->data = c;
  c->refs++;
  c->connect.data = c;
  const int rc = uv_tcp_connect(&c->connect, c->tcp, c->order[c->at]->ai_addr, porf_net_connected);
  if (rc < 0) {
    uv_close((uv_handle_t *)c->tcp, porf_net_tcp_closed);
    c->tcp = NULL;
    c->detail = rc;
    if (++c->at < c->count) porf_net_try(c);
    else porf_net_fail(c, porf_net_connect_error(rc), rc);
  }
}

static void porf_net_resolved(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
  porf_net *c = req->data;
  c->refs--;
  if (c->closed) {
    if (res) uv_freeaddrinfo(res);
    porf_net_maybe_free(c);
    return;
  }
  if (status < 0) {
    porf_net_fail(c, PORF_NET_DNS, status);
    return;
  }
  c->addrs = res;
  // IPv4 before IPv6: without happy eyeballs, an unroutable IPv6 address would otherwise
  // cost a connect timeout before IPv4 is tried
  for (struct addrinfo *a = res; a; a = a->ai_next) c->count++;
  c->order = malloc(sizeof(struct addrinfo *) * (size_t)(c->count + 1));
  if (!c->order) abort();
  int n = 0;
  for (struct addrinfo *a = res; a; a = a->ai_next) if (a->ai_family == AF_INET) c->order[n++] = a;
  for (struct addrinfo *a = res; a; a = a->ai_next) if (a->ai_family == AF_INET6) c->order[n++] = a;
  c->count = n;
  if (n == 0) {
    porf_net_fail(c, PORF_NET_DNS, UV_EAI_NONAME);
    return;
  }
  porf_net_try(c);
}
`;

// a connection to host:port started (TLS when tls): its C pointer, as a number. Its token
// settles once it is open or has failed; a failure at once is in error() now
function netOpen(token, host, port, tls) {
	const hostType = Porffor.type(host);
	let ptr = 0;
	Porffor.c`
{
porf_net *c = calloc(1, sizeof(porf_net));
if (!c) abort();
char *host_owned;
char *host_ptr = __porffor_node_cstr(MEM, ${host}, (i32)${hostType}.val, &host_owned);
c->host = strdup(host_ptr);
if (host_owned) free(host_owned);
c->tls = PORF_NUM(${tls}) != 0;
c->op = PORF_NUM(${token});
porf_uv_loop_use();
if (c->tls && porf_tls_init() < 0) {
  c->error = PORF_NET_INTERNAL;
  c->op = 0;
} else {
  char port_text[16];
  snprintf(port_text, sizeof(port_text), "%d", (int)PORF_NUM(${port}));
  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  c->resolve.data = c;
  const int rc = uv_getaddrinfo(uv_default_loop(), &c->resolve, porf_net_resolved, c->host, port_text, &hints);
  if (rc < 0) {
    c->error = PORF_NET_DNS;
    c->detail = rc;
    c->op = 0;
  } else {
    c->refs++;
  }
}
${ptr} = (f64)(uintptr_t)c;
}
`;
	return ptr;
}

// the connection's failure: an index into ERRORS, 0 while there is none
function netError(ptr) {
	let out = 0;
	Porffor.c`${out} = ((porf_net *)(uintptr_t)PORF_NUM(${ptr}))->error;`;
	return out;
}

// what went wrong, in words: libuv's, or mbedTLS's for a certificate
function netMessage(ptr) {
	let len = 0;
	let buf = 0;
	Porffor.c`
{
porf_net *c = (porf_net *)(uintptr_t)PORF_NUM(${ptr});
char text[512];
text[0] = 0;
if (c->error == PORF_NET_TLS_CERT) {
  mbedtls_x509_crt_verify_info(text, sizeof(text), "", c->verify);
  size_t n = strlen(text);
  // one line per problem: joined
  for (size_t i = 0; i < n; i++) if (text[i] == 10) text[i] = i + 1 == n ? 0 : ';';
} else if (c->error == PORF_NET_TLS_PROTOCOL || c->error == PORF_NET_TLS_ALERT || (c->error == PORF_NET_INTERNAL && c->detail != 0)) {
  snprintf(text, sizeof(text), "mbedTLS error -0x%04x", (unsigned)-c->detail);
} else if (c->error == PORF_NET_INTERNAL) {
  snprintf(text, sizeof(text), "TLS could not be set up");
} else if (c->detail != 0) {
  snprintf(text, sizeof(text), "%s", uv_strerror(c->detail));
}
${len} = strlen(text);
${buf} = (f64)(u64)strdup(text);
}
`;
	return takeCString(len, buf);
}

// bytes (a Uint8Array) written: its token settles once they are out; a failure at once is in
// error() now
function netWrite(token, ptr, bytes) {
	Porffor.c`
{
porf_net *c = (porf_net *)(uintptr_t)PORF_NUM(${ptr});
u32 at = ${bytes}.val < 0 ? (u32)(i32)${bytes}.val : (u32)${bytes}.val;
const size_t len = (size_t)*((i32 *)(MEM + at));
const u8 *data = (const u8 *)(MEM + *((u32 *)(MEM + at + 4)) + 4);
c->op = PORF_NUM(${token});
if (c->tls) {
  size_t done = 0;
  while (done < len && !c->error) {
    const int rc = mbedtls_ssl_write(&c->ssl, data + done, len - done);
    if (rc > 0) done += (size_t)rc;
    else if (rc != MBEDTLS_ERR_SSL_WANT_READ && rc != MBEDTLS_ERR_SSL_WANT_WRITE) {
      c->error = porf_tls_error(c, rc);
      c->detail = rc;
    }
  }
  if (!c->error) {
    u8 *records = c->out.data;
    const size_t records_len = c->out.len;
    c->out.data = NULL;
    c->out.len = c->out.cap = 0;
    const int rc = porf_net_send(c, records, records_len, 1);
    if (rc < 0) {
      c->error = PORF_NET_TERMINATED;
      c->detail = rc;
    }
  }
} else {
  u8 *copy = malloc(len + 1);
  if (!copy) abort();
  memcpy(copy, data, len);
  const int rc = porf_net_send(c, copy, len, 1);
  if (rc < 0) {
    c->error = PORF_NET_TERMINATED;
    c->detail = rc;
  }
}
if (c->error) c->op = 0;
}
`;
}

// how many bytes are there to take now
function netAvailable(ptr) {
	let out = 0;
	Porffor.c`${out} = (f64)((porf_net *)(uintptr_t)PORF_NUM(${ptr}))->plain.len;`;
	return out;
}

// whether the bytes have ended (once those there are taken)
function netEnded(ptr) {
	let out = 0;
	Porffor.c`${out} = ((porf_net *)(uintptr_t)PORF_NUM(${ptr}))->eof;`;
	return out !== 0;
}

// the bytes there are, taken into out (a Uint8Array of netAvailable's length); reading goes on
function netTake(ptr, out) {
	Porffor.c`
{
porf_net *c = (porf_net *)(uintptr_t)PORF_NUM(${ptr});
u32 at = ${out}.val < 0 ? (u32)(i32)${out}.val : (u32)${out}.val;
size_t len = (size_t)*((i32 *)(MEM + at));
u8 *into = (u8 *)(MEM + *((u32 *)(MEM + at + 4)) + 4);
if (len > c->plain.len) len = c->plain.len;
memcpy(into, c->plain.data, len);
porf_net_consume(&c->plain, len);
// what mbedTLS still holds, decrypted; the socket read again once there is room
if (c->tls) porf_net_pump(c);
if (!c->closed && !c->error && !c->reading && !c->in_eof && c->tcp && c->plain.len < PORF_NET_HIGH) {
  uv_read_start((uv_stream_t *)c->tcp, porf_net_alloc, porf_net_read);
  c->reading = 1;
}
}
`;
}

// a wait for bytes (or their end, or a failure): its token settles then
function netWait(token, ptr) {
	Porffor.c`((porf_net *)(uintptr_t)PORF_NUM(${ptr}))->wait = PORF_NUM(${token});`;
}

// the connection closed, and freed once libuv is done with it
function netClose(ptr) {
	Porffor.c`
{
porf_net *c = (porf_net *)(uintptr_t)PORF_NUM(${ptr});
c->closed = 1;
c->op = c->wait = 0;
if (c->tcp) {
  if (c->reading) uv_read_stop((uv_stream_t *)c->tcp);
  c->reading = 0;
  uv_close((uv_handle_t *)c->tcp, porf_net_tcp_closed);
  c->tcp = NULL;
}
if (c->refs > 0 && !c->addrs) uv_cancel((uv_req_t *)&c->resolve);
porf_net_maybe_free(c);
}
`;
}

/** A connection's failure as the TypeError fetch rejects with (wasi:http's code its payload). */
function failure(conn) {
	const tag = ERRORS[netError(conn.ptr)];
	const message = netMessage(conn.ptr);
	const error = new TypeError(
		'fetch failed: ' + tag + ' (' + conn.host + ')' + (message === '' ? '' : ': ' + message)
	);

	error.payload = { tag };

	return error;
}

/** A failure of HTTP itself: what came back is not a response this client can read. */
function protocolError(message) {
	const error = new TypeError('fetch failed: ' + message);

	error.payload = { tag: 'HTTP-protocol-error' };

	return error;
}

/** Closes a connection, once. */
function close(conn) {
	if (conn.closed) return;
	conn.closed = true;
	netClose(conn.ptr);
}

/**
 * Waits for the operation under token; an abort of signal cancels it (the connection closes)
 * and rejects with the signal's reason.
 */
async function hostWait(token, conn, signal) {
	const promise = rtAwait(token, () => undefined);

	rtOnCancel(token, () => close(conn));
	const cancel = () => {
		rtCancel(token, signal.reason);
	};

	signal.addEventListener('abort', cancel);

	try {
		await promise;
	} finally {
		signal.removeEventListener('abort', cancel);
	}

	if (netError(conn.ptr) !== 0) throw failure(conn);
}

/** A connection to host:port, open (and its TLS handshake done, for https). */
async function connect(host, port, tls, signal) {
	signal.throwIfAborted();
	const token = rtToken();
	const conn = { ptr: netOpen(token, host, port, tls ? 1 : 0), host, closed: false };

	try {
		if (netError(conn.ptr) !== 0) throw failure(conn);
		await hostWait(token, conn, signal);
	} catch (error) {
		close(conn);
		throw error;
	}

	return conn;
}

/** Bytes written to the connection. */
async function write(conn, bytes, signal) {
	signal.throwIfAborted();

	if (conn.closed) throw new TypeError('fetch failed: the connection is closed');
	const token = rtToken();

	netWrite(token, conn.ptr, bytes);

	if (netError(conn.ptr) !== 0) throw failure(conn);
	await hostWait(token, conn, signal);
}

/** The bytes that have come in, waiting for some if there are none; null at the end. */
async function read(conn, signal) {
	while (true) {
		signal.throwIfAborted();

		if (conn.closed) throw new TypeError('fetch failed: the connection is closed');
		const available = netAvailable(conn.ptr);

		if (available > 0) {
			const out = new Uint8Array(available);

			netTake(conn.ptr, out);

			return out;
		}

		if (netError(conn.ptr) !== 0) throw failure(conn);

		if (netEnded(conn.ptr)) return null;
		const token = rtToken();

		netWait(token, conn.ptr);
		await hostWait(token, conn, signal);
	}
}

/** Host and port of an authority (userinfo dropped, an IPv6 address unbracketed). */
function hostPort(authority, defaultPort) {
	const at = authority.lastIndexOf('@');
	const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
	let host = hostAndPort;
	let port = '';

	if (hostAndPort.startsWith('[')) {
		const end = hostAndPort.indexOf(']');

		host = hostAndPort.slice(1, end);
		port = hostAndPort.slice(end + 2);
	} else {
		const colon = hostAndPort.lastIndexOf(':');

		if (colon !== -1) {
			host = hostAndPort.slice(0, colon);
			port = hostAndPort.slice(colon + 1);
		}
	}

	return { host, hostAndPort, port: port === '' ? defaultPort : Number(port) };
}

/** Whether a header list has a name (lower case). */
function hasHeader(headers, name) {
	return headers.some((entry) => entry[0].toLowerCase() === name);
}

// the headers this client frames the message with itself, whatever the caller gave
const FRAMING = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'];

/** The request head: request line, headers, and how the body is framed. */
function requestHead(request, hostAndPort) {
	let head = request.method + ' ' + request.path + ' HTTP/1.1\r\nhost: ' + hostAndPort + '\r\n';

	for (const [name, value] of request.headers)
		if (!FRAMING.includes(name.toLowerCase())) head += name + ': ' + value + '\r\n';

	// what Node's fetch sends when the caller does not say
	if (!hasHeader(request.headers, 'accept')) head += 'accept: */*\r\n';

	if (!hasHeader(request.headers, 'user-agent')) head += 'user-agent: porffor\r\n';

	if (request.body instanceof Uint8Array) head += 'content-length: ' + request.body.length + '\r\n';
	else if (request.body !== null) head += 'transfer-encoding: chunked\r\n';
	else if (['POST', 'PUT', 'PATCH'].includes(request.method)) head += 'content-length: 0\r\n';

	// one request per connection: the response may end with it
	return new TextEncoder().encode(head + 'connection: close\r\n\r\n');
}

/** A streamed request body, chunk by chunk as it comes, chunked. */
async function writeStream(conn, stream, signal) {
	const encoder = new TextEncoder();
	const reader = stream.getReader();

	try {
		while (true) {
			const { value, done } = await reader.read();

			if (done) break;

			if (!(value instanceof Uint8Array))
				throw new TypeError('fetch: a request body stream must give Uint8Arrays');

			if (value.length === 0) continue;
			const size = encoder.encode(value.length.toString(16) + '\r\n');
			const chunk = new Uint8Array(size.length + value.length + 2);

			chunk.set(size, 0);
			chunk.set(value, size.length);
			chunk[chunk.length - 2] = 13;
			chunk[chunk.length - 1] = 10;
			await write(conn, chunk, signal);
		}
	} catch (error) {
		await reader.cancel(error);
		throw error;
	}
	await write(conn, encoder.encode('0\r\n\r\n'), signal);
}

/**
 * The response's bytes, read as they are wanted: whole lines for the head and chunk sizes,
 * then any bytes there are.
 */
function wire(conn, signal) {
	const state = { buffer: new Uint8Array(0), at: 0 };
	const decoder = new TextDecoder();

	/** More bytes behind those not yet used; false at the end. */
	const fill = async () => {
		const chunk = await read(conn, signal);

		if (chunk === null) return false;
		const rest = state.buffer.length - state.at;

		if (rest === 0) state.buffer = chunk;
		else {
			const next = new Uint8Array(rest + chunk.length);

			next.set(state.buffer.subarray(state.at), 0);
			next.set(chunk, rest);
			state.buffer = next;
		}
		state.at = 0;

		return true;
	};

	return {
		/** The next line (without its CRLF, or a bare LF), UTF-8 decoded. */
		async line() {
			let from = state.at;

			while (true) {
				const end = state.buffer.indexOf(10, from);

				if (end !== -1) {
					const stop = end > state.at && state.buffer[end - 1] === 13 ? end - 1 : end;
					const text = decoder.decode(state.buffer.subarray(state.at, stop));

					state.at = end + 1;

					return text;
				}

				if (state.buffer.length - state.at > MAX_LINE) throw protocolError('a line too long');
				from = state.buffer.length;

				const used = state.at;

				if (!(await fill())) throw incomplete();
				from -= used;
			}
		},
		/** Up to max bytes, waiting for some if none are here; null at the end. */
		async take(max) {
			if (state.at === state.buffer.length && !(await fill())) return null;
			const n = Math.min(max, state.buffer.length - state.at);
			const out = state.buffer.subarray(state.at, state.at + n);

			state.at += n;

			return out;
		}
	};
}

/** A response that ended before its framing said it would. */
function incomplete() {
	const error = new TypeError('fetch failed: the response ended early');

	error.payload = { tag: 'HTTP-response-incomplete' };

	return error;
}

/** The response head: status, reason, headers (names lower case). */
async function readHead(bytes) {
	const statusLine = await bytes.line();
	const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);

	if (match === null) throw protocolError('not an HTTP/1.1 response: ' + statusLine.slice(0, 64));
	const headers = [];

	while (true) {
		const line = await bytes.line();

		if (line === '') break;

		// a folded line continues the header before it
		if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
			headers[headers.length - 1][1] += ' ' + line.trim();
			continue;
		}
		const colon = line.indexOf(':');

		if (colon <= 0) throw protocolError('a malformed header line');
		headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
	}

	return { status: Number(match[1]), statusText: match[2] ?? '', headers };
}

/** A header's value (the last one given), or undefined. */
function header(headers, name) {
	let value;

	for (const entry of headers) if (entry[0] === name) value = entry[1];

	return value;
}

/** How the body's next bytes come: a function giving them, null at its end. */
function bodyReader(bytes, head, method) {
	if (method === 'HEAD' || NO_BODY.includes(head.status)) return async () => null;
	const coding = header(head.headers, 'transfer-encoding');

	if (coding !== undefined && coding.toLowerCase().trim().endsWith('chunked')) {
		let remaining = 0;
		let crlf = false;
		let done = false;

		return async () => {
			while (true) {
				if (remaining > 0) {
					const data = await bytes.take(remaining);

					if (data === null) throw incomplete();
					remaining -= data.length;
					crlf = remaining === 0;

					return data;
				}

				if (done) return null;

				if (crlf) {
					if ((await bytes.line()) !== '') throw protocolError('a chunk longer than its size');
					crlf = false;
				}
				const sizeText = (await bytes.line()).split(';')[0].trim();

				if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw protocolError('a malformed chunk size');
				const size = parseInt(sizeText, 16);

				if (size === 0) {
					// the trailers, if any, and the end
					while ((await bytes.line()) !== '');
					done = true;

					return null;
				}
				remaining = size;
			}
		};
	}
	const length = header(head.headers, 'content-length');

	if (length !== undefined) {
		if (!/^\d+$/.test(length.trim())) throw protocolError('a malformed content-length');
		let remaining = Number(length.trim());

		return async () => {
			if (remaining === 0) return null;
			const data = await bytes.take(remaining);

			if (data === null) throw incomplete();
			remaining -= data.length;

			return data;
		};
	}

	// no framing: the body is what comes until the connection ends
	return async () => bytes.take(CHUNK);
}

/**
 * Sends a request and resolves its response once the head is in; the body is read from the
 * connection as the returned stream is read. `signal` cancels the request and the body read in
 * flight: they reject with its reason, and the connection closes.
 * @param {{ method: string, scheme: string, authority: string, path: string,
 *   headers: [string, string][], body: Uint8Array | ReadableStream | null }} request
 * @param {AbortSignal} signal
 * @returns {Promise<{ status: number, statusText: string, headers: [string, string][],
 *   body: ReadableStream }>}
 */
export async function send(request, signal) {
	if (request.scheme !== 'http' && request.scheme !== 'https')
		throw new TypeError('fetch: unsupported URL scheme: ' + request.scheme);
	const tls = request.scheme === 'https';
	const where = hostPort(request.authority, tls ? 443 : 80);
	const conn = await connect(where.host, where.port, tls, signal);
	let head;
	let bytes;

	try {
		const start = requestHead(request, where.hostAndPort);

		// a body of known length goes out with the head, in one write
		if (request.body instanceof Uint8Array) {
			const whole = new Uint8Array(start.length + request.body.length);

			whole.set(start, 0);
			whole.set(request.body, start.length);
			await write(conn, whole, signal);
		} else {
			await write(conn, start, signal);

			if (request.body !== null) await writeStream(conn, request.body, signal);
		}
		bytes = wire(conn, signal);
		// interim responses (100 Continue, 103 Early Hints) come before the one that counts
		do head = await readHead(bytes);
		while (head.status >= 100 && head.status < 200 && head.status !== 101);
	} catch (error) {
		close(conn);
		throw error;
	}
	const next = bodyReader(bytes, head, request.method);
	const body = new ReadableStream(
		{
			async pull(controller) {
				let data;

				try {
					data = await next();
				} catch (error) {
					close(conn);
					throw error;
				}

				if (data === null) {
					close(conn);
					controller.close();
				} else controller.enqueue(data);
			},
			cancel() {
				close(conn);
			}
		},
		{ highWaterMark: 0 }
	);

	return { status: head.status, statusText: head.statusText, headers: head.headers, body };
}
