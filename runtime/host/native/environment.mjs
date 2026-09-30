// Native (libuv) environment: porffor:environment, the process environment as an object (a
// fetch handler's env), read once through ./process.mjs. runtime/host/wasi/environment.mjs is
// the same over wasi:cli/environment.
import { env } from './process.mjs';

let cached;

/** The environment variables, read once. */
export function environment() {
	if (cached === undefined) cached = env();

	return cached;
}
