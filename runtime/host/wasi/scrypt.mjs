// WASI scrypt: porffor:scrypt. A component has no threads to hash on, so the async hash runs
// here and now, as the sync one does, and blocks the instance for it (~0.1 s at N=16384 r=16);
// runtime/host/native/scrypt.mjs is the same on libuv's threadpool.
import { hashSync } from '../scrypt.mjs';

export { hashSync };

/** scrypt of password with salt into out (all Uint8Arrays): a promise of 0, or crypto_scrypt's -1. */
export function hash(password, salt, N, r, p, out) {
	return Promise.resolve(hashSync(password, salt, N, r, p, out));
}
