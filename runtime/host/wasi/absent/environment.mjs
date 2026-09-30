// porffor:environment in a world that does not import wasi:cli/environment@0.3.0: no variables.

const empty = {};

/** No environment: an empty object. */
export function environment() {
	return empty;
}
