// Stands in for ./environment.mjs in a world that does not import wasi:cli/environment.

const empty = {};

/** No environment: an empty object. */
export function environment() {
	return empty;
}
