// Event (DOM Standard), what EventTarget.dispatchEvent delivers. As in Node there is no
// tree: an event is only ever at its target, so capturing and bubbling never happen, and
// stopPropagation only matters to the dispatch in progress. isTrusted is always false
// (the guest makes every event), and timeStamp is 0 (no clock is assumed).

const NONE = 0;
const AT_TARGET = 2;

/** An event: its type, the flags it was made with, and its state during a dispatch. */
export class Event {
	/**
	 * @param {string} type
	 * @param {{ bubbles?: boolean, cancelable?: boolean, composed?: boolean }} [init]
	 */
	constructor(type, init = undefined) {
		if (type === undefined) throw new TypeError('Event: the type is required');
		this._type = String(type);
		this._bubbles = Boolean(init?.bubbles);
		this._cancelable = Boolean(init?.cancelable);
		this._composed = Boolean(init?.composed);
		this._target = null;
		this._currentTarget = null;
		this._phase = NONE;
		this._canceled = false;
		this._stopped = false;
		this._stoppedImmediately = false;
		this._inPassive = false;
		this._dispatching = false;
		// an own property, as the DOM makes it
		this.isTrusted = false;
		this.timeStamp = 0;
	}

	get type() {
		return this._type;
	}

	get target() {
		return this._target;
	}

	/** The legacy name of target. */
	get srcElement() {
		return this._target;
	}

	get currentTarget() {
		return this._currentTarget;
	}

	get eventPhase() {
		return this._phase;
	}

	get bubbles() {
		return this._bubbles;
	}

	get cancelable() {
		return this._cancelable;
	}

	get composed() {
		return this._composed;
	}

	get defaultPrevented() {
		return this._canceled;
	}

	/** Legacy: whether the default action still happens; setting false prevents it. */
	get returnValue() {
		return !this._canceled;
	}

	set returnValue(value) {
		if (!value) this.preventDefault();
	}

	/** Legacy: stopPropagation as a flag. */
	get cancelBubble() {
		return this._stopped;
	}

	set cancelBubble(value) {
		if (value) this._stopped = true;
	}

	/** The targets the event passes through: its current target while it is dispatched. */
	composedPath() {
		return this._dispatching && this._phase === AT_TARGET ? [this._currentTarget] : [];
	}

	/** Legacy: re-initializes an event not being dispatched (a constructor's init, as arguments). */
	initEvent(type, bubbles = false, cancelable = false) {
		if (this._dispatching) return;
		this._type = `${type}`;
		this._bubbles = Boolean(bubbles);
		this._cancelable = Boolean(cancelable);
		this._target = null;
		this._canceled = false;
		this._stopped = false;
		this._stoppedImmediately = false;
	}

	stopPropagation() {
		this._stopped = true;
	}

	/** Stops the listeners after this one too. */
	stopImmediatePropagation() {
		this._stopped = true;
		this._stoppedImmediately = true;
	}

	/** Cancels a cancelable event, unless a passive listener is running. */
	preventDefault() {
		if (this._cancelable && !this._inPassive) this._canceled = true;
	}
}

Event.NONE = NONE;
Event.CAPTURING_PHASE = 1;
Event.AT_TARGET = AT_TARGET;
Event.BUBBLING_PHASE = 3;
