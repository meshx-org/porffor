// DOMException for a Porffor-compiled guest (Porffor has none): the reasons AbortSignal
// and the timers use. Injected into every guest by the build, like ./abort.mjs.

/** The exception Web APIs throw: an Error with a DOM name (AbortError, TimeoutError, …). */
export class DOMException extends Error {
	/**
	 * @param {string} [message]
	 * @param {string} [name] defaults to 'Error'
	 */
	constructor(message, name) {
		super(message === undefined ? '' : String(message));
		this.name = name === undefined ? 'Error' : String(name);
	}
}
