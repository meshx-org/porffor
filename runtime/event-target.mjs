// EventTarget (DOM Standard), as Node has it: no tree, so an event is dispatched to its
// target alone. Listeners run in the order they were added, capture ones included; a
// listener is added once per type, callback and capture; once, passive and signal
// options work; a listener that throws is reported and does not stop the others.
//
// A subclass with event handler properties (onabort, onmessage) answers _eventHandler:
// the handler runs after the listeners.

import { DOMException } from './dom-exception.mjs';
import { Event } from './event.mjs';
import { defineInterface } from './webidl.mjs';

const NONE = 0;
const AT_TARGET = 2;

/** The capture flag of addEventListener's or removeEventListener's options. */
function captureOption(options) {
	return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

/** Reports what a listener threw (as a browser does, to the console), and carries on. */
function report(error) {
	console.error(`Uncaught ${error?.stack ?? error}`);
}

/** Calls one listener: a function with the target as this, or an object's handleEvent. */
function invoke(target, event, callback) {
	try {
		if (typeof callback === 'function') callback.call(target, event);
		else if (typeof callback.handleEvent === 'function') callback.handleEvent(event);
		else throw new TypeError('The listener has no handleEvent method');
	} catch (error) {
		report(error);
	}
}

/** Something events are dispatched to. */
export class EventTarget {
	constructor() {
		/** @type {Map<string, { callback: unknown, capture: boolean, once: boolean, passive: boolean, removed: boolean }[]>} */
		this._listeners = new Map();
	}

	/**
	 * Adds a listener for `type`, unless it is already there (same callback and capture).
	 * @param {string} type
	 * @param {Function | { handleEvent(event: Event): void } | null} callback
	 * @param {boolean | { capture?: boolean, once?: boolean, passive?: boolean, signal?: AbortSignal }} [options]
	 */
	addEventListener(type, callback, options = undefined) {
		const capture = captureOption(options);
		const flags = typeof options === 'object' && options !== null ? options : {};
		// the options dictionary's members, read in order before anything else
		const once = Boolean(flags.once);
		const passive = Boolean(flags.passive);
		const signal = flags.signal;

		if (signal === null) throw new TypeError('addEventListener: signal cannot be null');

		if (callback === null || callback === undefined) return;

		if (signal?.aborted) return;
		const key = String(type);
		let list = this._listeners.get(key);

		if (list === undefined) {
			list = [];
			this._listeners.set(key, list);
		}

		for (const entry of list) if (entry.callback === callback && entry.capture === capture) return;
		list.push({
			callback,
			capture,
			once,
			passive,
			removed: false
		});

		if (signal !== undefined)
			signal.addEventListener('abort', () => this.removeEventListener(key, callback, capture));
	}

	/** Removes the listener added with this type, callback and capture. */
	removeEventListener(type, callback, options = undefined) {
		const list = this._listeners.get(String(type));

		if (list === undefined) return;
		const capture = captureOption(options);
		const at = list.findIndex((entry) => entry.callback === callback && entry.capture === capture);

		if (at === -1) return;
		// a dispatch in progress holds a copy of the list: it must skip this one
		list[at].removed = true;
		list.splice(at, 1);
	}

	/**
	 * Dispatches `event` to this target's listeners (and its handler property, if it has
	 * one); false when a listener canceled it.
	 * @param {Event} event
	 */
	dispatchEvent(event) {
		if (!(event instanceof Event))
			throw new TypeError('dispatchEvent: the argument must be an Event');

		if (event._dispatching)
			throw new DOMException('The event is already being dispatched', 'InvalidStateError');
		event._dispatching = true;
		event._target = this;
		event._currentTarget = this;
		event._phase = AT_TARGET;
		const list = this._listeners.get(event.type);

		if (list !== undefined)
			for (const entry of list.slice()) {
				if (event._stoppedImmediately) break;

				if (entry.removed) continue;

				if (entry.once) this.removeEventListener(event.type, entry.callback, entry.capture);
				event._inPassive = entry.passive;
				invoke(this, event, entry.callback);
				event._inPassive = false;
			}
		const handler = this._eventHandler(event.type);

		if (typeof handler === 'function' && !event._stoppedImmediately) invoke(this, event, handler);
		event._phase = NONE;
		event._currentTarget = null;
		event._stopped = false;
		event._stoppedImmediately = false;
		event._dispatching = false;

		return !event._canceled;
	}

	/** The handler property for `type` (onabort, onmessage), if this kind of target has one. */
	_eventHandler() {
		return null;
	}
}

defineInterface(EventTarget, 'EventTarget');
