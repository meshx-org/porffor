// MIME types as the MIME Sniffing standard parses and serializes them
// (https://mimesniff.spec.whatwg.org/#parsing-a-mime-type): `type/subtype` lowercased, then
// `;name=value` parameters, the first of each name kept, a value quoted when it has to be.
// For data: URLs (./data-url.mjs), where a MIME type that fails to parse falls back to
// text/plain;charset=US-ASCII.

const HTTP_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
const TRAILING_HTTP_WHITESPACE = /[\t\n\r ]+$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUOTED_STRING_TOKEN = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

/**
 * A quoted string from `input` at `start` (its opening quote), unescaped, and the position
 * after it (https://fetch.spec.whatwg.org/#collect-an-http-quoted-string).
 */
function quotedString(input, start) {
	let value = '';
	let position = start + 1;

	while (position < input.length) {
		const char = input[position];

		if (char === '"') return { value, position: position + 1 };

		if (char === '\\') {
			position++;

			if (position >= input.length) return { value: `${value}\\`, position };
		}
		value += input[position];
		position++;
	}

	return { value, position };
}

/** One parameter's value from `position` (after its `=`), and where the next starts. */
function parameterValue(input, position) {
	if (input[position] === '"') {
		const quoted = quotedString(input, position);
		const end = input.indexOf(';', quoted.position);

		return { value: quoted.value, next: end < 0 ? input.length : end };
	}
	const end = input.indexOf(';', position);
	const next = end < 0 ? input.length : end;

	return { value: input.slice(position, next).replace(TRAILING_HTTP_WHITESPACE, ''), next };
}

/**
 * Parses a MIME type: { type, subtype, parameters (a Map, names lowercased) }, or null when it
 * is not one.
 * @param {string} text
 */
export function parseMimeType(text) {
	const input = String(text).replace(HTTP_WHITESPACE, '');
	const slash = input.indexOf('/');

	if (slash < 0) return null;
	const type = input.slice(0, slash);
	const semicolon = input.indexOf(';', slash + 1);
	const subtype = input
		.slice(slash + 1, semicolon < 0 ? input.length : semicolon)
		.replace(TRAILING_HTTP_WHITESPACE, '');

	if (!TOKEN.test(type) || !TOKEN.test(subtype)) return null;
	const parameters = new Map();
	let position = semicolon < 0 ? input.length : semicolon;

	while (position < input.length) {
		position++;

		while (/[\t\n\r ]/.test(input[position] ?? '')) position++;
		let end = position;

		while (end < input.length && input[end] !== ';' && input[end] !== '=') end++;
		const name = input.slice(position, end).toLowerCase();

		position = end;

		if (input[position] === ';' || position >= input.length) continue;
		const { value, next } = parameterValue(input, position + 1);

		position = next;

		if (
			value !== '' &&
			TOKEN.test(name) &&
			QUOTED_STRING_TOKEN.test(value) &&
			!parameters.has(name)
		)
			parameters.set(name, value);
	}

	return { type: type.toLowerCase(), subtype: subtype.toLowerCase(), parameters };
}

/** A parsed MIME type as text: values quoted when they are not tokens. */
export function serializeMimeType({ type, subtype, parameters }) {
	let out = `${type}/${subtype}`;

	for (const [name, value] of parameters)
		out += `;${name}=${TOKEN.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`}`;

	return out;
}
