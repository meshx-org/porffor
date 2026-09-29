// data: URLs as fetch answers them, with no network (https://fetch.spec.whatwg.org/#data-urls):
// the body percent-decoded, base64-decoded when the type ends in `;base64`, and a MIME type
// that fails to parse replaced by text/plain;charset=US-ASCII. fetch() (./fetch.mjs) takes
// this path for any data: URL; the WPT runner's offline fetch does too.

import { parseMimeType, serializeMimeType } from './mime-type.mjs';
import { Response } from './response.mjs';

const ASCII_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = /^[0-9A-Fa-f]{2}$/;

/** A string's bytes with %XX sequences decoded (https://url.spec.whatwg.org/#percent-decode). */
function percentDecode(text) {
	const bytes = new TextEncoder().encode(text);
	const out = [];

	for (let index = 0; index < bytes.length; index++) {
		const pair = String.fromCharCode(bytes[index + 1] ?? 0, bytes[index + 2] ?? 0);

		if (bytes[index] === 0x25 && HEX.test(pair)) {
			out.push(parseInt(pair, 16));
			index += 2;
		} else out.push(bytes[index]);
	}

	return new Uint8Array(out);
}

/** Forgiving base64 (https://infra.spec.whatwg.org/#forgiving-base64-decode): bytes, or null. */
function forgivingBase64(text) {
	let data = text.replace(/[\t\n\f\r ]/g, '');

	if (data.length % 4 === 0) data = data.replace(/={1,2}$/, '');

	if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) return null;
	const out = [];
	let buffer = 0;
	let bits = 0;

	for (const char of data) {
		buffer = (buffer << 6) | BASE64.indexOf(char);
		bits += 6;

		if (bits >= 8) {
			bits -= 8;
			out.push((buffer >> bits) & 0xff);
		}
	}

	return new Uint8Array(out);
}

/**
 * A data: URL's MIME type (serialized) and body, or null when it is not a valid one.
 * @param {string} href the URL, already parsed
 * @returns {{ mimeType: string, body: Uint8Array } | null}
 */
export function processDataUrl(href) {
	const input = href.replace(/#.*$/s, '').slice('data:'.length);
	const comma = input.indexOf(',');

	if (comma < 0) return null;
	let mimeType = input.slice(0, comma).replace(ASCII_WHITESPACE, '');
	let body = percentDecode(input.slice(comma + 1));

	if (/; *base64$/i.test(mimeType)) {
		body = forgivingBase64(Array.from(body, (byte) => String.fromCharCode(byte)).join(''));

		if (body === null) return null;
		mimeType = mimeType.replace(/; *base64$/i, '');
	}

	if (mimeType.startsWith(';')) mimeType = `text/plain${mimeType}`;
	const parsed = parseMimeType(mimeType);

	return {
		mimeType: parsed === null ? 'text/plain;charset=US-ASCII' : serializeMimeType(parsed),
		body
	};
}

/**
 * fetch's answer to a data: URL: a 200 Response with the decoded body, typed by its MIME type.
 * @param {string} href
 * @returns {Response}
 */
export function dataUrlResponse(href) {
	const data = processDataUrl(href);

	if (data === null) throw new TypeError(`fetch: not a valid data: URL: ${href}`);
	const response = new Response(data.body, {
		statusText: 'OK',
		headers: { 'content-type': data.mimeType }
	});

	response._url = href;
	response._type = 'basic';
	response._headers._guard = 'immutable';

	return response;
}
