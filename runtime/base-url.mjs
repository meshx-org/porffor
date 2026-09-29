// The base URL a relative URL is resolved against, as a worker's is its location: a component
// has none, so a relative URL is an error there, unless the program sets globalThis.location
// (the WPT runner does, as Deno's --location does).

/** The base for parsing a URL: globalThis.location's href, or undefined. */
export function baseUrl() {
	const location = globalThis.location;

	return location === undefined || location === null
		? undefined
		: String(location.href ?? location);
}
