// The URL standard's basic URL parser and URL serializer
// (https://url.spec.whatwg.org/#concept-basic-url-parser), as its state machine: one
// function per state, named as the standard names them, with the state override the URL
// setters use. A URL record is { scheme, username, password, host, port, path, query,
// fragment }; host is serialized (or null), path is a list of segments or, for an opaque
// path, a string.

import {
	C0_CONTROL,
	FRAGMENT,
	PATH,
	QUERY,
	SPECIAL_QUERY,
	USERINFO,
	codePoints,
	fromCodePoints,
	isAsciiAlpha,
	isAsciiAlphanumeric,
	isAsciiDigit,
	percentEncode,
	toAsciiLower
} from './url-encoding.mjs';
import { parseHost } from './url-host.mjs';

/** Special schemes and their default ports. */
const SPECIAL = /* @__PURE__ */ new Map([
	['ftp', 21],
	['file', null],
	['http', 80],
	['https', 443],
	['ws', 80],
	['wss', 443]
]);

export const isSpecial = (scheme) => SPECIAL.has(scheme);
export const defaultPort = (scheme) => SPECIAL.get(scheme) ?? null;

const EOF = -1;
const FAIL = 1;
const DONE = 2;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const QUESTION = 0x3f;
const HASH = 0x23;
const COLON = 0x3a;
const AT = 0x40;

/** A fresh URL record. */
export function newURL() {
	return {
		scheme: '',
		username: '',
		password: '',
		host: null,
		port: null,
		path: [],
		query: null,
		fragment: null
	};
}

export const hasOpaquePath = (url) => typeof url.path === 'string';
export const includesCredentials = (url) => url.username !== '' || url.password !== '';
export const cannotHaveCredentialsOrPort = (url) =>
	url.host === null || url.host === '' || url.scheme === 'file';

/** A copy of a URL record (paths are copied, not shared). */
export function cloneURL(url) {
	return { ...url, path: hasOpaquePath(url) ? url.path : url.path.slice() };
}

const isWindowsDriveLetter = (text) => /^[A-Za-z][:|]$/.test(text);
const isNormalizedWindowsDriveLetter = (text) => /^[A-Za-z]:$/.test(text);
const isSingleDot = (segment) => segment === '.' || segment.toLowerCase() === '%2e';
const isDoubleDot = (segment) => ['..', '.%2e', '%2e.', '%2e%2e'].includes(segment.toLowerCase());

/** Whether code points from `at` start with a Windows drive letter (then /, \, ?, # or the end). */
function startsWithWindowsDriveLetter(points, at) {
	if (points.length - at < 2) return false;

	if (!isAsciiAlpha(points[at]) || (points[at + 1] !== COLON && points[at + 1] !== 0x7c))
		return false;

	if (points.length - at === 2) return true;
	const third = points[at + 2];

	return third === SLASH || third === BACKSLASH || third === QUESTION || third === HASH;
}

function shortenPath(url) {
	const { path } = url;

	if (url.scheme === 'file' && path.length === 1 && isNormalizedWindowsDriveLetter(path[0])) return;
	path.pop();
}

const special = (ctx) => isSpecial(ctx.url.scheme);
const slashOrSpecialBackslash = (ctx, cp) => cp === SLASH || (special(ctx) && cp === BACKSLASH);
const bufferText = (ctx) => fromCodePoints(ctx.buffer);

/** The URL takes the base's authority and path; for the relative states. */
function takeBase(ctx, withPath) {
	const { url, base } = ctx;

	url.username = base.username;
	url.password = base.password;
	url.host = base.host;
	url.port = base.port;

	if (withPath) {
		url.path = base.path.slice();
		url.query = base.query;
	}
}

// ---- the states: (ctx, cp) -> undefined (go on), FAIL or DONE ----

const STATES = {
	schemeStart(ctx, cp) {
		if (isAsciiAlpha(cp)) {
			ctx.buffer.push(toAsciiLower(cp));
			ctx.state = 'scheme';
		} else if (!ctx.override) {
			ctx.state = 'noScheme';
			ctx.pointer--;
		} else return FAIL;
	},

	scheme(ctx, cp) {
		if (isAsciiAlphanumeric(cp) || cp === 0x2b || cp === 0x2d || cp === 0x2e) {
			ctx.buffer.push(toAsciiLower(cp));

			return;
		}

		if (cp !== COLON) {
			if (ctx.override) return FAIL;
			ctx.buffer = [];
			ctx.state = 'noScheme';
			ctx.pointer = -1;

			return;
		}
		const { url } = ctx;
		const scheme = bufferText(ctx);

		if (ctx.override) {
			if (isSpecial(url.scheme) !== isSpecial(scheme)) return DONE;

			if ((includesCredentials(url) || url.port !== null) && scheme === 'file') return DONE;

			if (url.scheme === 'file' && url.host === '') return DONE;
		}
		url.scheme = scheme;

		if (ctx.override) {
			if (url.port === defaultPort(scheme)) url.port = null;

			return DONE;
		}
		ctx.buffer = [];

		if (scheme === 'file') ctx.state = 'file';
		else if (isSpecial(scheme) && ctx.base !== null && ctx.base.scheme === scheme)
			ctx.state = 'specialRelativeOrAuthority';
		else if (isSpecial(scheme)) ctx.state = 'specialAuthoritySlashes';
		else if (ctx.points[ctx.pointer + 1] === SLASH) {
			ctx.state = 'pathOrAuthority';
			ctx.pointer++;
		} else {
			url.path = '';
			ctx.state = 'opaquePath';
		}
	},

	noScheme(ctx, cp) {
		const { base, url } = ctx;

		if (base === null || (hasOpaquePath(base) && cp !== HASH)) return FAIL;

		if (hasOpaquePath(base) && cp === HASH) {
			url.scheme = base.scheme;
			url.path = base.path;
			url.query = base.query;
			url.fragment = '';
			ctx.state = 'fragment';
		} else {
			ctx.state = base.scheme === 'file' ? 'file' : 'relative';
			ctx.pointer--;
		}
	},

	specialRelativeOrAuthority(ctx, cp) {
		if (cp === SLASH && ctx.points[ctx.pointer + 1] === SLASH) {
			ctx.state = 'specialAuthorityIgnoreSlashes';
			ctx.pointer++;
		} else {
			ctx.state = 'relative';
			ctx.pointer--;
		}
	},

	pathOrAuthority(ctx, cp) {
		if (cp === SLASH) ctx.state = 'authority';
		else {
			ctx.state = 'path';
			ctx.pointer--;
		}
	},

	relative(ctx, cp) {
		const { url } = ctx;

		url.scheme = ctx.base.scheme;

		if (slashOrSpecialBackslash(ctx, cp)) {
			ctx.state = 'relativeSlash';

			return;
		}
		takeBase(ctx, true);

		if (cp === QUESTION) {
			url.query = '';
			ctx.state = 'query';
		} else if (cp === HASH) {
			url.fragment = '';
			ctx.state = 'fragment';
		} else if (cp !== EOF) {
			url.query = null;
			shortenPath(url);
			ctx.state = 'path';
			ctx.pointer--;
		}
	},

	relativeSlash(ctx, cp) {
		if (special(ctx) && (cp === SLASH || cp === BACKSLASH))
			ctx.state = 'specialAuthorityIgnoreSlashes';
		else if (cp === SLASH) ctx.state = 'authority';
		else {
			takeBase(ctx, false);
			ctx.state = 'path';
			ctx.pointer--;
		}
	},

	specialAuthoritySlashes(ctx, cp) {
		ctx.state = 'specialAuthorityIgnoreSlashes';

		if (cp === SLASH && ctx.points[ctx.pointer + 1] === SLASH) ctx.pointer++;
		else ctx.pointer--;
	},

	specialAuthorityIgnoreSlashes(ctx, cp) {
		if (cp !== SLASH && cp !== BACKSLASH) {
			ctx.state = 'authority';
			ctx.pointer--;
		}
	},

	authority(ctx, cp) {
		const { url } = ctx;

		if (cp === AT) {
			if (ctx.atSignSeen) ctx.buffer.unshift(0x25, 0x34, 0x30); // %40
			ctx.atSignSeen = true;

			for (const point of ctx.buffer) {
				if (point === COLON && !ctx.passwordTokenSeen) {
					ctx.passwordTokenSeen = true;
					continue;
				}
				const encoded = percentEncode(point, USERINFO);

				if (ctx.passwordTokenSeen) url.password += encoded;
				else url.username += encoded;
			}
			ctx.buffer = [];
		} else if (cp === EOF || cp === QUESTION || cp === HASH || slashOrSpecialBackslash(ctx, cp)) {
			if (ctx.atSignSeen && ctx.buffer.length === 0) return FAIL;
			ctx.pointer -= ctx.buffer.length + 1;
			ctx.buffer = [];
			ctx.state = 'host';
		} else ctx.buffer.push(cp);
	},

	host(ctx, cp) {
		const { url } = ctx;

		if (ctx.override && url.scheme === 'file') {
			ctx.pointer--;
			ctx.state = 'fileHost';

			return;
		}

		if (cp === COLON && !ctx.insideBrackets) {
			if (ctx.buffer.length === 0) return FAIL;

			if (ctx.override === 'hostname') return DONE;
			const host = parseHost(bufferText(ctx), !special(ctx));

			if (host === null) return FAIL;
			url.host = host;
			ctx.buffer = [];
			ctx.state = 'port';
		} else if (cp === EOF || cp === QUESTION || cp === HASH || slashOrSpecialBackslash(ctx, cp)) {
			ctx.pointer--;

			if (special(ctx) && ctx.buffer.length === 0) return FAIL;

			if (
				ctx.override &&
				ctx.buffer.length === 0 &&
				(includesCredentials(url) || url.port !== null)
			)
				return DONE;
			const host = parseHost(bufferText(ctx), !special(ctx));

			if (host === null) return FAIL;
			url.host = host;
			ctx.buffer = [];
			ctx.state = 'pathStart';

			if (ctx.override) return DONE;
		} else {
			if (cp === 0x5b) ctx.insideBrackets = true;

			if (cp === 0x5d) ctx.insideBrackets = false;
			ctx.buffer.push(cp);
		}
	},

	// the standard's "hostname state": the host state, under the hostname setter's override
	hostname(ctx, cp) {
		return STATES.host(ctx, cp);
	},

	port(ctx, cp) {
		const { url } = ctx;

		if (isAsciiDigit(cp)) {
			ctx.buffer.push(cp);

			return;
		}

		if (
			cp === EOF ||
			cp === QUESTION ||
			cp === HASH ||
			slashOrSpecialBackslash(ctx, cp) ||
			ctx.override
		) {
			if (ctx.buffer.length > 0) {
				const port = parseInt(bufferText(ctx), 10);

				if (port > 65535) return FAIL;
				url.port = port === defaultPort(url.scheme) ? null : port;
				ctx.buffer = [];
			}

			if (ctx.override) return DONE;
			ctx.state = 'pathStart';
			ctx.pointer--;

			return;
		}

		return FAIL;
	},

	file(ctx, cp) {
		const { url, base } = ctx;

		url.scheme = 'file';
		url.host = '';

		if (cp === SLASH || cp === BACKSLASH) {
			ctx.state = 'fileSlash';

			return;
		}

		if (base === null || base.scheme !== 'file') {
			ctx.state = 'path';
			ctx.pointer--;

			return;
		}
		url.host = base.host;
		url.path = base.path.slice();
		url.query = base.query;

		if (cp === QUESTION) {
			url.query = '';
			ctx.state = 'query';
		} else if (cp === HASH) {
			url.fragment = '';
			ctx.state = 'fragment';
		} else if (cp !== EOF) {
			url.query = null;

			if (startsWithWindowsDriveLetter(ctx.points, ctx.pointer)) url.path = [];
			else shortenPath(url);
			ctx.state = 'path';
			ctx.pointer--;
		}
	},

	fileSlash(ctx, cp) {
		const { url, base } = ctx;

		if (cp === SLASH || cp === BACKSLASH) {
			ctx.state = 'fileHost';

			return;
		}

		if (base !== null && base.scheme === 'file') {
			url.host = base.host;

			if (
				!startsWithWindowsDriveLetter(ctx.points, ctx.pointer) &&
				base.path.length > 0 &&
				isNormalizedWindowsDriveLetter(base.path[0])
			)
				url.path.push(base.path[0]);
		}
		ctx.state = 'path';
		ctx.pointer--;
	},

	fileHost(ctx, cp) {
		const { url } = ctx;

		if (!(cp === EOF || cp === SLASH || cp === BACKSLASH || cp === QUESTION || cp === HASH)) {
			ctx.buffer.push(cp);

			return;
		}
		ctx.pointer--;
		const text = bufferText(ctx);

		if (!ctx.override && isWindowsDriveLetter(text)) {
			// the drive letter goes on as the first path segment
			ctx.segment = text;
			ctx.buffer = [];
			ctx.state = 'path';

			return;
		}

		if (text === '') {
			url.host = '';

			if (ctx.override) return DONE;
			ctx.state = 'pathStart';

			return;
		}
		let host = parseHost(text, !special(ctx));

		if (host === null) return FAIL;

		if (host === 'localhost') host = '';
		url.host = host;

		if (ctx.override) return DONE;
		ctx.buffer = [];
		ctx.state = 'pathStart';
	},

	pathStart(ctx, cp) {
		const { url } = ctx;

		if (special(ctx)) {
			ctx.state = 'path';

			if (cp !== SLASH && cp !== BACKSLASH) ctx.pointer--;
		} else if (!ctx.override && cp === QUESTION) {
			url.query = '';
			ctx.state = 'query';
		} else if (!ctx.override && cp === HASH) {
			url.fragment = '';
			ctx.state = 'fragment';
		} else if (cp !== EOF) {
			ctx.state = 'path';

			if (cp !== SLASH) ctx.pointer--;
		} else if (ctx.override && url.host === null) url.path.push('');
	},

	path(ctx, cp) {
		const { url } = ctx;
		const ends =
			cp === EOF ||
			slashOrSpecialBackslash(ctx, cp) ||
			(!ctx.override && (cp === QUESTION || cp === HASH));

		if (!ends) {
			ctx.segment += percentEncode(cp, PATH);

			return;
		}
		const slashNext = slashOrSpecialBackslash(ctx, cp);

		if (isDoubleDot(ctx.segment)) {
			shortenPath(url);

			if (!slashNext) url.path.push('');
		} else if (isSingleDot(ctx.segment) && !slashNext) url.path.push('');
		else if (!isSingleDot(ctx.segment)) {
			if (url.scheme === 'file' && url.path.length === 0 && isWindowsDriveLetter(ctx.segment))
				ctx.segment = ctx.segment[0] + ':';
			url.path.push(ctx.segment);
		}
		ctx.segment = '';

		if (cp === QUESTION) {
			url.query = '';
			ctx.state = 'query';
		} else if (cp === HASH) {
			url.fragment = '';
			ctx.state = 'fragment';
		}
	},

	opaquePath(ctx, cp) {
		const { url } = ctx;

		if (cp === QUESTION) {
			url.query = '';
			ctx.state = 'query';
		} else if (cp === HASH) {
			url.fragment = '';
			ctx.state = 'fragment';
		} else if (cp !== EOF) url.path += percentEncode(cp, C0_CONTROL);
	},

	query(ctx, cp) {
		const { url } = ctx;

		if ((!ctx.override && cp === HASH) || cp === EOF) {
			const inSet = special(ctx) ? SPECIAL_QUERY : QUERY;

			for (const point of ctx.buffer) url.query += percentEncode(point, inSet);
			ctx.buffer = [];

			if (cp === HASH) {
				url.fragment = '';
				ctx.state = 'fragment';
			}
		} else ctx.buffer.push(cp);
	},

	fragment(ctx, cp) {
		if (cp !== EOF) ctx.url.fragment += percentEncode(cp, FRAGMENT);
	}
};

/** The input without leading or trailing C0 controls and spaces (U+0000 to U+0020). */
function trimC0ControlOrSpace(text) {
	let start = 0;
	let end = text.length;

	while (start < end && text.charCodeAt(start) <= 0x20) start++;

	while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;

	return text.slice(start, end);
}

/**
 * The basic URL parser: a URL record, or null on failure.
 * @param {string} input
 * @param {object | null} [base] a URL record to resolve against
 * @param {object} [url] the record to change, with `override`
 * @param {string} [override] the state to start in (a setter's), which also stops early
 */
export function parseURL(input, base = null, url = null, override = null) {
	let text = input;

	if (url === null) text = trimC0ControlOrSpace(text);
	text = text.replace(/[\t\n\r]/g, '');
	const ctx = {
		points: codePoints(text),
		pointer: 0,
		buffer: [],
		segment: '',
		state: override ?? 'schemeStart',
		url: url ?? newURL(),
		base,
		override,
		atSignSeen: false,
		insideBrackets: false,
		passwordTokenSeen: false
	};

	for (; ctx.pointer <= ctx.points.length; ctx.pointer++) {
		const cp = ctx.pointer < ctx.points.length ? ctx.points[ctx.pointer] : EOF;
		const result = STATES[ctx.state](ctx, cp);

		if (result === FAIL) return null;

		if (result === DONE) return ctx.url;
	}

	return ctx.url;
}

/** The URL serializer: the href. */
export function serializeURL(url, excludeFragment = false) {
	let out = url.scheme + ':';

	if (url.host !== null) {
		out += '//';

		if (includesCredentials(url)) {
			out += url.username;

			if (url.password !== '') out += ':' + url.password;
			out += '@';
		}
		out += url.host;

		if (url.port !== null) out += ':' + url.port;
	}

	if (hasOpaquePath(url)) out += url.path;
	else {
		if (url.host === null && url.path.length > 1 && url.path[0] === '') out += '/.';

		for (const segment of url.path) out += '/' + segment;
	}

	if (url.query !== null) out += '?' + url.query;

	if (!excludeFragment && url.fragment !== null) out += '#' + url.fragment;

	return out;
}

/** The URL's origin, serialized ('null' for an opaque origin). */
export function serializeOrigin(url) {
	if (url.scheme === 'blob') {
		const inner = parseURL(hasOpaquePath(url) ? url.path : url.path.join('/'));

		return inner !== null && (inner.scheme === 'http' || inner.scheme === 'https')
			? serializeOrigin(inner)
			: 'null';
	}

	if (!isSpecial(url.scheme) || url.scheme === 'file') return 'null';

	return url.scheme + '://' + url.host + (url.port === null ? '' : ':' + url.port);
}
