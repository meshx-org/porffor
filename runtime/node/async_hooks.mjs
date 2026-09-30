// node:async_hooks: AsyncLocalStorage and AsyncResource over the engine's async context. Every
// promise reaction Porffor makes (a .then, an await's continuation) carries the context current
// when it was made, and has it current again while it runs (compiler/builtins/promise.ts,
// __Porffor_promise_runOneInContext); timers, setImmediate and host operations resume through
// such reactions. The context is a frame: a Map of each AsyncLocalStorage to its store, never
// changed once current (a new frame replaces it), as Node's AsyncContextFrame is.
//
// createHook's hooks are never called (their async resource lifecycle is not tracked): Node
// marks that API experimental and steers to AsyncLocalStorage.

const currentFrame = () => __Porffor_asyncContext_get();
const setFrame = (frame) => __Porffor_asyncContext_set(frame);

// fn(...args) with frame current, then the frame before current again
const runInFrame = (frame, fn, thisArg, args) => {
	const previous = currentFrame();
	setFrame(frame);
	try {
		return fn.apply(thisArg, args);
	} finally {
		setFrame(previous);
	}
};

const withStore = (frame, storage, store) => {
	const next = new Map(frame ?? []);
	next.set(storage, store);
	return next;
};

const withoutStore = (frame, storage) => {
	if (frame === undefined || !frame.has(storage)) return frame;
	const next = new Map(frame);
	next.delete(storage);
	return next.size === 0 ? undefined : next;
};

export class AsyncLocalStorage {
	constructor() {
		this._enabled = true;
	}

	/** The store of the run() (or enterWith) this code is inside of, undefined outside one. */
	getStore() {
		if (!this._enabled) return undefined;
		return currentFrame()?.get(this);
	}

	/** callback(...args) with store as this storage's store, it and what it goes on to do. */
	run(store, callback, ...args) {
		this._enabled = true;
		return runInFrame(withStore(currentFrame(), this, store), callback, undefined, args);
	}

	/** callback(...args) outside any store of this storage. */
	exit(callback, ...args) {
		return runInFrame(withoutStore(currentFrame(), this), callback, undefined, args);
	}

	/** store as this storage's store for the rest of this code, and what it goes on to do. */
	enterWith(store) {
		this._enabled = true;
		setFrame(withStore(currentFrame(), this, store));
	}

	/** getStore() is undefined until the next run() or enterWith(). */
	disable() {
		this._enabled = false;
		setFrame(withoutStore(currentFrame(), this));
	}

	/** fn, bound to the async context now: called later, it runs in it. */
	static bind(fn) {
		const frame = currentFrame();
		return function (...args) {
			return runInFrame(frame, fn, this, args);
		};
	}

	/** A function that runs its callback in the async context now. */
	static snapshot() {
		const frame = currentFrame();
		return (fn, ...args) => runInFrame(frame, fn, undefined, args);
	}
}

let nextAsyncId = 2;

export class AsyncResource {
	constructor(type, options) {
		this.type = type;
		this._frame = currentFrame();
		this._asyncId = nextAsyncId++;
		this._triggerAsyncId =
			typeof options === 'object' && options !== null && typeof options.triggerAsyncId === 'number'
				? options.triggerAsyncId
				: 1;
	}

	/** fn(...args), this thisArg, in the async context the resource was made in. */
	runInAsyncScope(fn, thisArg, ...args) {
		return runInFrame(this._frame, fn, thisArg, args);
	}

	bind(fn, thisArg) {
		const resource = this;
		return function (...args) {
			return resource.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
		};
	}

	static bind(fn, type, thisArg) {
		return new AsyncResource(type ?? 'bound-anonymous-fn').bind(fn, thisArg);
	}

	asyncId() {
		return this._asyncId;
	}

	triggerAsyncId() {
		return this._triggerAsyncId;
	}

	emitDestroy() {
		return this;
	}
}

// the ids Node's async_hooks number resources by: the top level's is 1, what triggered it 0
export const executionAsyncId = () => 1;
export const triggerAsyncId = () => 0;
export const executionAsyncResource = () => ({});

// a hook whose callbacks are never called (see above)
export const createHook = () => ({
	enable() {
		return this;
	},
	disable() {
		return this;
	}
});

export const asyncWrapProviders = Object.freeze({});

export default {
	AsyncLocalStorage,
	AsyncResource,
	executionAsyncId,
	triggerAsyncId,
	executionAsyncResource,
	createHook,
	asyncWrapProviders
};
