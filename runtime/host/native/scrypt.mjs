// Native (libuv) scrypt: porffor:scrypt. The hash runs on libuv's threadpool (uv_queue_work), as
// Node's crypto.scrypt does, so the loop goes on meanwhile: the worker hashes copies of the
// password and salt into its own buffer, and the result is copied into out back on the loop's
// thread, when its promise settles (porffor:async). The worker never touches Porffor's heap.
import { rtAwait, rtSettle, rtToken } from './async.mjs';

export { hashSync } from '../scrypt.mjs';

// libuv's callback for a hash that is done
function settle(token) {
	rtSettle(token);
	__Porffor_promise_runJobs();
}

Porffor.c`
#include <uv.h>

typedef struct porf_scrypt_work {
  uv_work_t req;
  f64 token;
  uint8_t *pw, *salt, *out;
  size_t pw_len, salt_len, out_len;
  uint64_t N;
  uint32_t r, p;
  int rc;
} porf_scrypt_work;

static uint8_t *porf_scrypt_copy(const uint8_t *bytes, size_t len) {
  uint8_t *copy = malloc(len + 1);
  if (!copy) abort();
  memcpy(copy, bytes, len);
  return copy;
}

// on a threadpool thread
static void porf_scrypt_run(uv_work_t *req) {
  porf_scrypt_work *work = (porf_scrypt_work *)req;
  work->rc = crypto_scrypt(work->pw, work->pw_len, work->salt, work->salt_len, work->N, work->r,
    work->p, work->out, work->out_len);
}

// back on the loop's thread
static void porf_scrypt_done(uv_work_t *req, int status) {
  (void)status;
  ${settle}(porf_box_num(((porf_scrypt_work *)req)->token));
}
`;

// the hash queued on the threadpool: its work (a pointer, as a number)
function start(token, password, salt, N, r, p, out) {
	let work = 0;
	Porffor.c`
{
porf_scrypt_work *job = calloc(1, sizeof(porf_scrypt_work));
if (!job) abort();
size_t len;
uint8_t *bytes = __porffor_u8_data(MEM, ${password}, &len);
job->pw = porf_scrypt_copy(bytes, len);
job->pw_len = len;
bytes = __porffor_u8_data(MEM, ${salt}, &len);
job->salt = porf_scrypt_copy(bytes, len);
job->salt_len = len;
__porffor_u8_data(MEM, ${out}, &len);
job->out = malloc(len + 1);
if (!job->out) abort();
job->out_len = len;
job->N = (uint64_t)PORF_NUM(${N});
job->r = (uint32_t)PORF_NUM(${r});
job->p = (uint32_t)PORF_NUM(${p});
job->token = PORF_NUM(${token});
uv_queue_work(uv_default_loop(), &job->req, porf_scrypt_run, porf_scrypt_done);
porf_uv_loop_use();
${work} = (f64)(uintptr_t)job;
}
`;
	return work;
}

// a done hash's result copied into out, and its work freed: crypto_scrypt's 0 or -1
function finish(work, out) {
	let rc = 0;
	Porffor.c`
{
porf_scrypt_work *job = (porf_scrypt_work *)(uintptr_t)PORF_NUM(${work});
size_t len;
uint8_t *out_bytes = __porffor_u8_data(MEM, ${out}, &len);
if (job->rc == 0) memcpy(out_bytes, job->out, len < job->out_len ? len : job->out_len);
${rc} = job->rc;
free(job->pw);
free(job->salt);
free(job->out);
free(job);
}
`;
	return rc;
}

/**
 * scrypt of password with salt into out (all Uint8Arrays), on libuv's threadpool: a promise of
 * 0, or crypto_scrypt's -1.
 */
export function hash(password, salt, N, r, p, out) {
	const token = rtToken();
	const work = start(token, password, salt, N, r, p, out);
	return rtAwait(token, () => finish(work, out), out);
}
