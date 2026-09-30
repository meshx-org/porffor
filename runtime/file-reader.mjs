// FileReader, FileReaderSync and ProgressEvent (https://w3c.github.io/FileAPI/#APIASynch): a
// Blob's bytes read as an ArrayBuffer, text, a data: URL or a binary string. A FileReader is an
// EventTarget: a read fires loadstart, progress (for a non-empty blob), then load and loadend,
// each in a task of its own (a timer), so code awaiting one event runs before the next; abort()
// ends a read at once, firing abort and loadend (a browser runs microtasks between listeners,
// which a dispatch here does not). A Blob's bytes are in memory, so the whole
// blob is one chunk and a read never fails.
//
// Text is decoded as the spec's "read as text" has it: a BOM wins, then the encoding argument,
// then the blob type's charset, then UTF-8; an encoding other than UTF-8 and UTF-16 works when
// the program names one of its labels (runtime/globals.json's legacy encodings).
//
// Its own globals (runtime/globals.json): loaded only when a program names one of them. The
// events wait on timers (./timers.mjs): a WASI world without a clock throws on a read.

import { DOMException } from './dom-exception.mjs';
import { Event } from './event.mjs';
import { EventTarget } from './event-target.mjs';
import { parseMimeType } from './mime-type.mjs';
import { encodingName, TextDecoder } from './text-decoder.mjs';
import { setTimeout } from './timers.mjs';
import { defineInterface } from './webidl.mjs';
import { Blob } from './blob.mjs';

const EMPTY = 0;
const LOADING = 1;
const DONE = 2;

/** An event of a read's progress: how many bytes of how many have been read. */
export class ProgressEvent extends Event {
	/**
	 * @param {string} type
	 * @param {{ lengthComputable?: boolean, loaded?: number, total?: number, bubbles?: boolean,
	 *   cancelable?: boolean, composed?: boolean }} [init]
	 */
	constructor(type, init = undefined) {
		super(type, init);
		this._lengthComputable = Boolean(init?.lengthComputable);
		this._loaded = init?.loaded === undefined ? 0 : Number(init.loaded);
		this._total = init?.total === undefined ? 0 : Number(init.total);
	}

	get lengthComputable() {
		return this._lengthComputable;
	}

	get loaded() {
		return this._loaded;
	}

	get total() {
		return this._total;
	}
}

/** An event handler attribute's value: an object (a function, or one with handleEvent), else null. */
const handlerValue = (value) =>
	(typeof value === 'object' && value !== null) || typeof value === 'function' ? value : null;

/** The blob argument, checked as WebIDL's conversion does. */
function blobArgument(blob, method) {
	if (!(blob instanceof Blob))
		throw new TypeError(`FileReader.${method}: parameter 1 is not of type 'Blob'`);

	return blob;
}

/** Bytes as a string of one code unit per byte (readAsBinaryString's result). */
function binaryString(bytes) {
	let out = '';

	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);

	return out;
}

/** The encoding a BOM at the start of bytes names, or null. */
function bomEncoding(bytes) {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';

	if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

	if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';

	return null;
}

/**
 * Bytes as text, the spec's "read as text": the BOM's encoding, else the label's, else the
 * type's charset, else UTF-8.
 */
function decodeText(bytes, label, type) {
	let encoding = label === undefined ? null : encodingName(`${label}`);

	if (encoding === null) {
		const charset = parseMimeType(type)?.parameters.get('charset');

		if (charset !== undefined) encoding = encodingName(charset);
	}
	encoding = bomEncoding(bytes) ?? encoding ?? 'utf-8';

	// (a decoder drops a BOM of its own encoding, which is the BOM's when there is one)
	return new TextDecoder(encoding).decode(bytes);
}

/** A read's result, as the method that started it packages the bytes. */
function packageData(bytes, kind, label, type) {
	if (kind === 'arrayBuffer') return bytes.slice().buffer;

	if (kind === 'binaryString') return binaryString(bytes);

	if (kind === 'dataURL')
		return `data:${type === '' ? 'application/octet-stream' : type};base64,${bytes.toBase64()}`;

	return decodeText(bytes, label, type);
}

/** Reads Blobs, telling of its progress through events. */
export class FileReader extends EventTarget {
	constructor() {
		super();
		this._state = EMPTY;
		this._result = null;
		this._error = null;
		// which read is current: a task of an earlier (aborted) one does nothing
		this._read = 0;
		/** @type {Record<string, Function | object>} the event handler attributes' values */
		this._handlers = {};
	}

	/** EMPTY, LOADING or DONE. */
	get readyState() {
		return this._state;
	}

	/** What the last read made (null until it is done). */
	get result() {
		return this._result;
	}

	/** Why the last read failed, or null. */
	get error() {
		return this._error;
	}

	_eventHandler(type) {
		const handler = this._handlers[type];

		return typeof handler === 'function' ? handler : null;
	}

	// the event handler attributes: a callable object or null (anything else is null)

	get onloadstart() {
		return this._handlers.loadstart ?? null;
	}

	set onloadstart(handler) {
		this._handlers.loadstart = handlerValue(handler);
	}

	get onprogress() {
		return this._handlers.progress ?? null;
	}

	set onprogress(handler) {
		this._handlers.progress = handlerValue(handler);
	}

	get onload() {
		return this._handlers.load ?? null;
	}

	set onload(handler) {
		this._handlers.load = handlerValue(handler);
	}

	get onabort() {
		return this._handlers.abort ?? null;
	}

	set onabort(handler) {
		this._handlers.abort = handlerValue(handler);
	}

	get onerror() {
		return this._handlers.error ?? null;
	}

	set onerror(handler) {
		this._handlers.error = handlerValue(handler);
	}

	get onloadend() {
		return this._handlers.loadend ?? null;
	}

	set onloadend(handler) {
		this._handlers.loadend = handlerValue(handler);
	}

	/** Fires a ProgressEvent of the read's bytes. */
	_fire(type, loaded, total) {
		this.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total }));
	}

	/** Starts a read of `blob`, its result packaged as `kind` says. */
	_start(blob, kind, label) {
		if (this._state === LOADING)
			throw new DOMException('The reader is already reading a blob', 'InvalidStateError');
		this._state = LOADING;
		this._result = null;
		this._error = null;
		const read = ++this._read;
		const bytes = blob._bytes;
		const total = bytes.length;
		const type = blob.type;
		// each step a task of its own, dropped when the read is no longer the current one
		const later = (step) =>
			setTimeout(() => {
				if (this._read === read && this._state === LOADING) step();
			}, 0);

		later(() => {
			this._fire('loadstart', 0, total);
			later(() => {
				if (total > 0) this._fire('progress', total, total);
				later(() => {
					this._state = DONE;
					this._result = packageData(bytes, kind, label, type);
					this._fire('load', total, total);

					// loadend in a task of its own: a browser runs the microtasks between the two
					// (after each listener), so code awaiting load sees it before loadend
					if (this._state === DONE)
						setTimeout(() => {
							if (this._read === read) this._fire('loadend', total, total);
						}, 0);
				});
			});
		});
	}

	/** Reads a blob into an ArrayBuffer. */
	readAsArrayBuffer(blob) {
		this._start(blobArgument(blob, 'readAsArrayBuffer'), 'arrayBuffer');
	}

	/** Reads a blob into a string of one code unit per byte. */
	readAsBinaryString(blob) {
		this._start(blobArgument(blob, 'readAsBinaryString'), 'binaryString');
	}

	/** Reads a blob into text, in `encoding` unless a BOM says otherwise. */
	readAsText(blob, encoding = undefined) {
		this._start(blobArgument(blob, 'readAsText'), 'text', encoding);
	}

	/** Reads a blob into a data: URL (base64). */
	readAsDataURL(blob) {
		this._start(blobArgument(blob, 'readAsDataURL'), 'dataURL');
	}

	/** Ends a read in progress: its result is dropped, abort and loadend fire. */
	abort() {
		if (this._state === EMPTY || this._state === DONE) {
			this._result = null;

			return;
		}
		this._state = DONE;
		this._result = null;
		this._read++;
		this._fire('abort', 0, 0);

		if (this._state !== LOADING) this._fire('loadend', 0, 0);
	}
}

for (const holder of [FileReader, FileReader.prototype]) {
	holder.EMPTY = EMPTY;
	holder.LOADING = LOADING;
	holder.DONE = DONE;
}

/** Reads Blobs at once, as a worker's FileReaderSync does. */
export class FileReaderSync {
	/** A blob's bytes in an ArrayBuffer. */
	readAsArrayBuffer(blob) {
		return packageData(blobArgument(blob, 'readAsArrayBuffer')._bytes, 'arrayBuffer');
	}

	/** A blob's bytes as a string of one code unit per byte. */
	readAsBinaryString(blob) {
		return packageData(blobArgument(blob, 'readAsBinaryString')._bytes, 'binaryString');
	}

	/** A blob's bytes as text, in `encoding` unless a BOM says otherwise. */
	readAsText(blob, encoding = undefined) {
		const checked = blobArgument(blob, 'readAsText');

		return packageData(checked._bytes, 'text', encoding, checked.type);
	}

	/** A blob's bytes as a data: URL (base64). */
	readAsDataURL(blob) {
		const checked = blobArgument(blob, 'readAsDataURL');

		return packageData(checked._bytes, 'dataURL', undefined, checked.type);
	}
}

defineInterface(ProgressEvent, 'ProgressEvent');
defineInterface(FileReader, 'FileReader');
defineInterface(FileReaderSync, 'FileReaderSync');
