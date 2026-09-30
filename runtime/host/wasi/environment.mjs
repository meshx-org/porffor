// The process environment as an object (wasi:cli/environment), for a fetch handler's env.
// Library modules reach it as 'wasi-porffor:environment'; the build points that here in a
// world that imports wasi:cli/environment@0.3.0, and at ./no-environment.mjs otherwise.

import { getEnvironment } from 'wasi:cli/environment@0.3.0';

let cached;

/** The environment variables, read once. */
export function environment() {
	if (cached === undefined) {
		cached = {};

		for (const [name, value] of getEnvironment()) cached[name] = value;
	}

	return cached;
}
