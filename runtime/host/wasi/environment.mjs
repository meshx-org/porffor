// WASI environment: porffor:environment, the process environment as an object, from the world's
// wasi:cli/environment@0.3.0 import (./absent/environment.mjs in a world without it).
// runtime/host/native/environment.mjs is the same over libuv.
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
