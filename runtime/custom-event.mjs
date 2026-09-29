// CustomEvent (DOM Standard): an Event carrying a detail.

import { Event } from './event.mjs';

/** An event with a value of the dispatcher's choosing. */
export class CustomEvent extends Event {
	/**
	 * @param {string} type
	 * @param {{ detail?: unknown, bubbles?: boolean, cancelable?: boolean, composed?: boolean }} [init]
	 */
	constructor(type, init) {
		super(type, init);
		this._detail = init?.detail === undefined ? null : init.detail;
	}

	get detail() {
		return this._detail;
	}
}
