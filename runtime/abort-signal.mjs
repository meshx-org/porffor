// AbortSignal for a Porffor-compiled guest: an EventTarget, as in Node and browsers. An
// abort reaches the host through whoever listens (fetch and the timers cancel their
// pending operations).

import { setTimeout } from './timers.mjs';
import { DOMException } from './dom-exception.mjs';
import { Event } from './event.mjs';
import { EventTarget } from './event-target.mjs';
import { defineInterface } from './webidl.mjs';

/**
 * Aborts `signal` with `reason` (an AbortError when undefined), and the signals that depend on
 * it (AbortSignal.any's): each is set first, then 'abort' fires at this one and at each of them
 * in turn (listeners, then onabort). A second abort does nothing.
 */
export function abortSignal(signal, reason) {
	if (signal.aborted) return;
	const why =
		reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason;
	const aborted = [signal];

	signal.aborted = true;
	signal.reason = why;

	for (const dependent of signal._dependents)
		if (!dependent.aborted) {
			dependent.aborted = true;
			dependent.reason = why;
			aborted.push(dependent);
		}

	for (const target of aborted) {
		const event = new Event('abort');

		// the platform's own event, not a program's
		event.isTrusted = true;
		target.dispatchEvent(event);
	}
}

/** A signal an AbortController aborts; operations given it stop when it does. */
export class AbortSignal extends EventTarget {
	constructor() {
		super();
		this.aborted = false;
		this.reason = undefined;
		this.onabort = null;
		// AbortSignal.any's links: the signals one made by it follows (never another made by it),
		// and those made by it that follow this one
		this._dependent = false;
		this._sources = [];
		this._dependents = [];
	}

	/** Throws the reason when aborted. */
	throwIfAborted() {
		if (this.aborted) throw this.reason;
	}

	_eventHandler(type) {
		return type === 'abort' ? this.onabort : null;
	}

	/** An already aborted signal. */
	static abort(reason = undefined) {
		const signal = new AbortSignal();

		abortSignal(signal, reason);

		return signal;
	}

	/**
	 * A signal that aborts with a TimeoutError after `ms` milliseconds. Needs a clock to wait
	 * on (porffor:clock: a WASI world without wasi:clocks/monotonic-clock throws here).
	 */
	static timeout(ms) {
		const signal = new AbortSignal();

		setTimeout(() => {
			abortSignal(signal, new DOMException('The operation timed out', 'TimeoutError'));
		}, ms);

		return signal;
	}

	/**
	 * A signal that aborts when the first of `signals` does, with its reason: it follows their
	 * sources (a signal made by any() is followed through the signals it follows).
	 */
	static any(signals) {
		const signal = new AbortSignal();

		for (const source of signals)
			if (source.aborted) {
				signal.aborted = true;
				signal.reason = source.reason;

				return signal;
			}
		signal._dependent = true;

		for (const source of signals)
			for (const followed of source._dependent ? source._sources : [source])
				if (!signal._sources.includes(followed)) {
					signal._sources.push(followed);
					followed._dependents.push(signal);
				}

		return signal;
	}
}

defineInterface(AbortSignal, 'AbortSignal');
