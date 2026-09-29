// MessageEvent (HTML Standard): an Event carrying a message, as EventSource delivers them.

import { Event } from './event.mjs';

/** A message: its data, where it came from, and (for server-sent events) its id. */
export class MessageEvent extends Event {
	/**
	 * @param {string} type
	 * @param {{ data?: unknown, origin?: string, lastEventId?: string, source?: unknown, ports?: unknown[] }} [init]
	 */
	constructor(type, init) {
		super(type, init);
		this._data = init?.data === undefined ? null : init.data;
		this._origin = init?.origin === undefined ? '' : String(init.origin);
		this._lastEventId = init?.lastEventId === undefined ? '' : String(init.lastEventId);
		this._source = init?.source === undefined ? null : init.source;
		this._ports = init?.ports === undefined ? [] : Array.from(init.ports);
	}

	get data() {
		return this._data;
	}

	get origin() {
		return this._origin;
	}

	get lastEventId() {
		return this._lastEventId;
	}

	get source() {
		return this._source;
	}

	get ports() {
		return this._ports;
	}
}
