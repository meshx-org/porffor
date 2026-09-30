// FormData bodies for Request and Response (./body.mjs): a FormData as a body is encoded as
// multipart/form-data (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#multipart/form-data-encoding-algorithm),
// and formData() parses a multipart/form-data or application/x-www-form-urlencoded body back
// into one (https://fetch.spec.whatwg.org/#body-mixin).
//
// Its own provider (runtime/globals.json): loaded, plugging itself into ./body.mjs, only for a
// program that names FormData or calls formData(), so one that reads bodies as text or JSON
// carries neither FormData, File nor the multipart code.

import { formDataBodies } from './body.mjs';
import { byteStream } from './chunk-stream.mjs';
import { File } from './file.mjs';
import { FormData } from './form-data.mjs';
import { parseMimeType } from './mime-type.mjs';
import { parseForm } from './url-encoding.mjs';

const encoder = /* @__PURE__ */ new TextEncoder();
// UTF-8 decode without BOM: a body's leading U+FEFF is data
const decoder = /* @__PURE__ */ new TextDecoder('utf-8', { ignoreBOM: true });

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

/** Line breaks as CRLF: a lone CR or a lone LF becomes CR LF. */
const crlf = (text) => text.replace(/\r\n|\r|\n/g, '\r\n');

/** A name or filename in a Content-Disposition: LF, CR and " percent-encoded. */
const escapeName = (text) =>
	text.replaceAll('\n', '%0A').replaceAll('\r', '%0D').replaceAll('"', '%22');

/** The bytes of parts joined. */
function concat(parts) {
	let total = 0;

	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;

	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
}

/** A FormData's entries as a multipart/form-data body, and its boundary. */
function encodeMultipart(formData) {
	let boundary = '----formdata-porffor-';

	for (let i = 0; i < 24; i++) boundary += Math.floor(Math.random() * 16).toString(16);

	// (no entries, no body: not even the closing delimiter, as browsers send it)
	if (formData._list.length === 0) return { bytes: new Uint8Array(0), boundary };
	const parts = [];

	for (const [name, value] of formData._list) {
		let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(crlf(name))}"`;

		if (typeof value === 'string') {
			parts.push(encoder.encode(`${head}\r\n\r\n${crlf(value)}\r\n`));
			continue;
		}
		head += `; filename="${escapeName(value.name)}"\r\nContent-Type: ${value.type === '' ? 'application/octet-stream' : value.type}\r\n\r\n`;
		parts.push(encoder.encode(head), value._bytes, encoder.encode('\r\n'));
	}
	parts.push(encoder.encode(`--${boundary}--\r\n`));

	return { bytes: concat(parts), boundary };
}

/** Whether `bytes` holds `pattern` at `at`. */
function startsAt(bytes, pattern, at) {
	if (at + pattern.length > bytes.length) return false;

	for (let i = 0; i < pattern.length; i++) if (bytes[at + i] !== pattern[i]) return false;

	return true;
}

/** Where `pattern` next is in `bytes` from `from`, or -1. */
function indexOf(bytes, pattern, from) {
	for (let at = from; at + pattern.length <= bytes.length; at++)
		if (startsAt(bytes, pattern, at)) return at;

	return -1;
}

/** A quoted name in a Content-Disposition (`name="…"`), %0A %0D %22 decoded; null if missing. */
function dispositionParameter(header, key) {
	const match = new RegExp(`;\\s*${key}="([^"]*)"`, 'i').exec(header);

	return match === null
		? null
		: match[1].replaceAll('%0A', '\n').replaceAll('%0D', '\r').replaceAll('%22', '"');
}

/** A multipart/form-data body as a FormData; a TypeError when it is not well formed. */
function parseMultipart(bytes, boundary) {
	const fail = () => {
		throw new TypeError('Body.formData: the multipart/form-data body is not well formed');
	};
	const delimiter = encoder.encode(`--${boundary}`);
	const out = new FormData();

	// (an empty FormData's body, as it is sent: nothing at all)
	if (bytes.length === 0) return out;

	if (!startsAt(bytes, delimiter, 0)) fail();
	let at = delimiter.length;

	while (true) {
		// the closing delimiter, or the CRLF that starts a part
		if (bytes[at] === DASH && bytes[at + 1] === DASH) return out;

		if (bytes[at] !== CR || bytes[at + 1] !== LF) fail();
		at += 2;
		let name = null;
		let filename = null;
		let contentType = null;

		// the part's headers, up to an empty line
		while (!(bytes[at] === CR && bytes[at + 1] === LF)) {
			const end = indexOf(bytes, [CR, LF], at);

			if (end < 0) fail();
			const line = decoder.decode(bytes.subarray(at, end));
			const colon = line.indexOf(':');

			if (colon < 0) fail();
			const header = line.slice(0, colon).trim().toLowerCase();
			const value = line.slice(colon + 1).trim();

			if (header === 'content-disposition') {
				if (!/^form-data\s*(;|$)/i.test(value)) fail();
				name = dispositionParameter(value, 'name');
				filename = dispositionParameter(value, 'filename');
			} else if (header === 'content-type') contentType = value;
			at = end + 2;
		}
		at += 2;

		if (name === null) fail();
		const end = indexOf(bytes, concat([[CR, LF], delimiter]), at);

		if (end < 0) fail();
		const body = bytes.slice(at, end);

		if (filename === null) out.append(name, decoder.decode(body));
		else
			out.append(
				name,
				new File([body], filename, { type: contentType === null ? 'text/plain' : contentType })
			);
		at = end + 2 + delimiter.length;
	}
}

/** A body's bytes as a FormData, by its content-type. */
function parseFormDataBody(bytes, type) {
	const mime = type === null ? null : parseMimeType(type);
	const essence = mime === null ? '' : `${mime.type}/${mime.subtype}`;

	if (essence === 'multipart/form-data') {
		const boundary = mime.parameters.get('boundary');

		if (boundary === undefined)
			throw new TypeError('Body.formData: multipart/form-data without a boundary');

		return parseMultipart(bytes, boundary);
	}

	if (essence === 'application/x-www-form-urlencoded') {
		const out = new FormData();

		for (const [name, value] of parseForm(decoder.decode(bytes))) out.append(name, value);

		return out;
	}

	throw new TypeError(`Body.formData: cannot read a body of type '${type ?? ''}' as FormData`);
}

const bodies = formDataBodies();

bodies.extract = (init) => {
	if (!(init instanceof FormData)) return null;
	const { bytes, boundary } = encodeMultipart(init);

	return { stream: byteStream(bytes), type: `multipart/form-data; boundary=${boundary}` };
};
bodies.parse = parseFormDataBody;
