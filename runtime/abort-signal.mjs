// AbortSignal for a Porffor-compiled guest: an EventTarget, as in Node and browsers. An
// abort reaches the host through whoever listens (fetch and the timers cancel their
// pending operations).

import { setTimeout } from 'wasi-porffor:timers';
import { DOMException } from './dom-exception.mjs';
import { Event } from './event.mjs';
import { EventTarget } from './event-target.mjs';

/**
 * Aborts `signal` with `reason` (an AbortError when undefined): sets it, then fires
 * 'abort' at its listeners and onabort. A second abort does nothing.
 */
export function abortSignal(signal, reason) {
	if (signal.aborted) return;
	signal.aborted = true;
	signal.reason =
		reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason;
	signal.dispatchEvent(new Event('abort'));
}

/** A signal an AbortController aborts; operations given it stop when it does. */
export class AbortSignal extends EventTarget {
	constructor() {
		super();
		this.aborted = false;
		this.reason = undefined;
		this.onabort = null;
	}

	/** Throws the reason when aborted. */
	throwIfAborted() {
		if (this.aborted) throw this.reason;
	}

	_eventHandler(type) {
		return type === 'abort' ? this.onabort : null;
	}

	/** An already aborted signal. */
	static abort(reason) {
		const signal = new AbortSignal();

		abortSignal(signal, reason);

		return signal;
	}

	/**
	 * A signal that aborts with a TimeoutError after `ms` milliseconds. Needs the timers
	 * ('wasi-porffor:timers': ./timers.mjs in worlds that import
	 * wasi:clocks/monotonic-clock; elsewhere calling this throws).
	 */
	static timeout(ms) {
		const signal = new AbortSignal();

		setTimeout(() => {
			abortSignal(signal, new DOMException('The operation timed out', 'TimeoutError'));
		}, ms);

		return signal;
	}

	/** A signal that aborts when the first of `signals` does, with its reason. */
	static any(signals) {
		const signal = new AbortSignal();

		for (const source of signals)
			if (source.aborted) {
				abortSignal(signal, source.reason);

				return signal;
			}
		const follow = (event) => abortSignal(signal, event.target.reason);

		for (const source of signals) source.addEventListener('abort', follow);

		return signal;
	}
}
