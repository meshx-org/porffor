// AsyncLocalStorage (node:async_hooks), as Cloudflare Workers put it on the global object.
// Libraries that cannot import node:async_hooks look for it there (better-auth does).
//
// Porffor has no async context to carry a store across awaits, so this keeps one current
// store: run() sets it and puts the previous one back when the callback returns or, for an
// async callback, when its promise settles. That is exact for one call at a time. Two export
// calls interleaving in one instance see each other's store while both are pending.

/** A store that follows a call and what it awaits, one call at a time. */
export class AsyncLocalStorage {
	constructor() {
		this._store = undefined;
		this._enabled = false;
	}

	/** The store of the run() in progress, or undefined outside one. */
	getStore() {
		return this._enabled ? this._store : undefined;
	}

	/**
	 * Calls `callback` with `store` as the current store, until it returns or its promise
	 * settles; then the previous store is current again.
	 * @template T
	 * @param {unknown} store
	 * @param {(...args: unknown[]) => T} callback
	 * @param {...unknown} args
	 * @returns {T}
	 */
	run(store, callback, ...args) {
		const previousStore = this._store;
		const previousEnabled = this._enabled;
		const restore = () => {
			this._store = previousStore;
			this._enabled = previousEnabled;
		};

		this._store = store;
		this._enabled = true;

		let result;

		try {
			result = callback(...args);
		} catch (error) {
			restore();
			throw error;
		}

		if (result !== null && typeof result === 'object' && typeof result.then === 'function')
			return result.then(
				(value) => {
					restore();

					return value;
				},
				(error) => {
					restore();
					throw error;
				}
			);

		restore();

		return result;
	}

	/**
	 * Calls `callback` outside any store.
	 * @template T
	 * @param {(...args: unknown[]) => T} callback
	 * @param {...unknown} args
	 * @returns {T}
	 */
	exit(callback, ...args) {
		return this.run(undefined, callback, ...args);
	}

	/**
	 * Makes `store` current from here on, until another run() or enterWith().
	 * @param {unknown} store
	 */
	enterWith(store) {
		this._store = store;
		this._enabled = true;
	}

	/** Clears the store: getStore() is undefined until the next run() or enterWith(). */
	disable() {
		this._store = undefined;
		this._enabled = false;
	}
}
