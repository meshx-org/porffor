// reportError, as browsers, Bun and Deno have it: an error reported as uncaught (to the console),
// without throwing, so a callback's failure does not stop whoever called it.

/** Reports `error` as an uncaught exception would be. */
export function reportError(error) {
	console.error('Uncaught', error);
}
