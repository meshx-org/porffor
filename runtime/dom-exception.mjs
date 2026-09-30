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

	/** The legacy code of the name (WebIDL's table: NotSupportedError is 9), or 0 for a name without one. */
	get code() {
		const index = LEGACY_CODES.indexOf(this.name);

		return index < 0 ? 0 : index + 1;
	}
}

// The names with a legacy code, at index code - 1 (null: a code only historical names had; https://webidl.spec.whatwg.org/#dfn-error-names-table)
const LEGACY_CODES = [
	'IndexSizeError',
	null,
	'HierarchyRequestError',
	'WrongDocumentError',
	'InvalidCharacterError',
	null,
	'NoModificationAllowedError',
	'NotFoundError',
	'NotSupportedError',
	null,
	'InvalidStateError',
	'SyntaxError',
	'InvalidModificationError',
	'NamespaceError',
	'InvalidAccessError',
	null,
	'TypeMismatchError',
	'SecurityError',
	'NetworkError',
	'AbortError',
	'URLMismatchError',
	'QuotaExceededError',
	'TimeoutError',
	'InvalidNodeTypeError',
	'DataCloneError'
];
