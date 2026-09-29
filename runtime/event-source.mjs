// EventSource (server-sent events) for a Porffor-compiled guest, over fetch() and its
// streaming body: the HTML standard's event stream parsing (data / event / id / retry
// fields, comments, CR / LF / CRLF lines, a leading BOM), open / message / error events
// and named events, and reconnection with Last-Event-ID after the retry delay.
// Reconnecting waits on setTimeout, so it needs a world that imports
// wasi:clocks/monotonic-clock too; without one, reconnecting fails (./no-timers.mjs).
//
// Library modules import the globals they use (injection does not reach into injected
// files): timers come from 'wasi-porffor:timers', which the build points at ./timers.mjs
// or ./no-timers.mjs.
//
// The build injects this module (esbuild `inject`) into guests whose world imports
// wasi:http/client@0.3.0.

import { setTimeout } from 'wasi-porffor:timers';
import { AbortController } from './abort.mjs';
import { Event } from './event.mjs';
import { EventTarget } from './event-target.mjs';
import { fetch } from './fetch.mjs';
import { MessageEvent } from './message-event.mjs';
import { URL } from './url.mjs';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
/** The reconnection delay until the server sets one (retry:), in milliseconds. */
const DEFAULT_RETRY_MS = 3_000;

/** A stream of events from a server, over one long-lived GET, reconnecting when it drops. */
export class EventSource extends EventTarget {
	/**
	 * @param {string} url
	 * @param {{ withCredentials?: boolean }} [init]
	 */
	constructor(url, init) {
		super();
		this.url = String(url);
		this.withCredentials = init?.withCredentials === true;
		this.readyState = CONNECTING;
		this.onopen = null;
		this.onmessage = null;
		this.onerror = null;
		this._lastEventId = '';
		this._retry = DEFAULT_RETRY_MS;
		this._controller = undefined;
		this._connect();
	}

	/** Closes the connection for good: no more events, no reconnection. */
	close() {
		this.readyState = CLOSED;
		this._controller?.abort();
	}

	_eventHandler(type) {
		return type === 'open'
			? this.onopen
			: type === 'message'
				? this.onmessage
				: type === 'error'
					? this.onerror
					: null;
	}

	async _connect() {
		const controller = new AbortController();

		this._controller = controller;
		const headers = { accept: 'text/event-stream', 'cache-control': 'no-store' };

		if (this._lastEventId !== '') headers['last-event-id'] = this._lastEventId;
		let reader;

		try {
			const response = await fetch(this.url, { headers, signal: controller.signal });

			if (this.readyState === CLOSED) return;
			const type = response.headers.get('content-type') ?? '';

			if (response.status !== 200 || !type.toLowerCase().startsWith('text/event-stream')) {
				// not an event stream: fail for good
				await response.body.cancel();
				this.readyState = CLOSED;
				this.dispatchEvent(new Event('error'));

				return;
			}
			this.readyState = OPEN;
			this.dispatchEvent(new Event('open'));
			reader = response.body.getReader();
			await this._read(reader);
		} catch {
			// a network error or an abort: reconnect, unless closed
		}

		if (this.readyState !== CLOSED) this._reconnect();
	}

	/** Parses the stream as it arrives, until it ends. */
	async _read(reader) {
		const decoder = new TextDecoder();
		let buffer = '';
		let first = true;
		let data = '';
		let type = '';
		let lastId = this._lastEventId;

		while (true) {
			const { value, done } = await reader.read();

			if (done) return;
			buffer += decoder.decode(value, { stream: true });

			if (first && buffer.length > 0) {
				if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
				first = false;
			}

			// whole lines only; a CR at the very end may be the first half of a CRLF
			while (true) {
				const match = /\r\n|\r|\n/.exec(buffer);

				if (match === null || (match[0] === '\r' && match.index === buffer.length - 1)) break;
				const line = buffer.slice(0, match.index);

				buffer = buffer.slice(match.index + match[0].length);

				if (this.readyState === CLOSED) return;

				if (line === '') {
					// a blank line ends an event
					this._lastEventId = lastId;

					if (data !== '') {
						this.dispatchEvent(
							new MessageEvent(type === '' ? 'message' : type, {
								data: data.endsWith('\n') ? data.slice(0, -1) : data,
								lastEventId: this._lastEventId,
								origin: new URL(this.url).origin
							})
						);
					}
					data = '';
					type = '';
					continue;
				}

				if (line.startsWith(':')) continue; // a comment
				const colon = line.indexOf(':');
				const field = colon === -1 ? line : line.slice(0, colon);
				let fieldValue = colon === -1 ? '' : line.slice(colon + 1);

				if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);

				if (field === 'data') data += fieldValue + '\n';
				else if (field === 'event') type = fieldValue;
				else if (field === 'id') {
					if (!fieldValue.includes('\0')) lastId = fieldValue;
				} else if (field === 'retry' && /^\d+$/.test(fieldValue)) this._retry = Number(fieldValue);
			}
		}
	}

	_reconnect() {
		this.readyState = CONNECTING;
		this.dispatchEvent(new Event('error'));

		if (this.readyState === CLOSED) return; // an error listener closed it
		setTimeout(() => {
			if (this.readyState === CONNECTING) this._connect();
		}, this._retry);
	}
}

EventSource.CONNECTING = CONNECTING;
EventSource.OPEN = OPEN;
EventSource.CLOSED = CLOSED;
