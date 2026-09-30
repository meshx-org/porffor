// node:url: the WHATWG URL and URLSearchParams (runtime/url.mjs), file: URLs to and from paths
// (POSIX paths: Windows' drive letters and UNC hosts are not handled), domainToASCII and
// domainToUnicode, urlToHttpOptions, and the legacy API (parse, format, resolve) in a basic
// form: parse splits a URL into Node's Url fields, without Node's every quirk.
import { URL, URLSearchParams } from '../url.mjs';
import { platform } from 'porffor:process';
import { resolve as resolvePath } from './path.mjs';

export { URL, URLSearchParams };

const codeError = (Kind, code, message) => {
	const e = new Kind(message);
	e.code = code;
	return e;
};

/**
 * The path a file: URL names, percent-decoded.
 * @param {URL | string} url
 * @returns {string}
 */
export function fileURLToPath(url) {
	if (typeof url === 'string') url = new URL(url);
	else if (
		!(url instanceof URL) &&
		!(url !== null && typeof url === 'object' && typeof url.href === 'string')
	)
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "path" argument must be of type string or an instance of URL. Received ${url === null ? 'null' : typeof url}`
		);
	if (url.protocol !== 'file:')
		throw codeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
	if (url.hostname !== '' && url.hostname !== 'localhost')
		throw codeError(
			TypeError,
			'ERR_INVALID_FILE_URL_HOST',
			`File URL host must be "localhost" or empty on ${platform()}`
		);
	const pathname = url.pathname;
	for (let i = 0; i + 2 < pathname.length; i++) {
		if (
			pathname[i] === '%' &&
			pathname[i + 1] === '2' &&
			(pathname[i + 2] === 'f' || pathname[i + 2] === 'F')
		)
			throw codeError(
				TypeError,
				'ERR_INVALID_FILE_URL_PATH',
				'File URL path must not include encoded / characters'
			);
	}
	return decodeURIComponent(pathname);
}

// what pathToFileURL encodes beyond what the pathname setter does: '%' first, so what it adds
// is not encoded again
const PATH_ESCAPES = [
	['%', '%25'],
	['\\', '%5C'],
	['\n', '%0A'],
	['\r', '%0D'],
	['\t', '%09'],
	['#', '%23'],
	['?', '%3F']
];

/**
 * A file: URL for a path (resolved against the working directory), a trailing slash kept.
 * @param {string} path
 * @returns {URL}
 */
export function pathToFileURL(path) {
	if (typeof path !== 'string')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "path" argument must be of type string. Received ${path === null ? 'null' : typeof path}`
		);
	let resolved = resolvePath(path);
	if (path.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
	for (const [from, to] of PATH_ESCAPES) resolved = resolved.replaceAll(from, to);
	const url = new URL('file:///');
	url.pathname = resolved;
	return url;
}

/**
 * A domain in ASCII (IDNA: Punycode for what is not), '' when it is not a valid domain.
 * @param {string} domain
 */
export function domainToASCII(domain) {
	// a Punycode label must be ASCII already
	for (const label of String(domain).split('.'))
		if (/^xn--/i.test(label) && /[^ -~]/.test(label)) return '';
	try {
		return new URL(`ws://${domain}`).hostname;
	} catch {
		return '';
	}
}

// ---- Punycode (RFC 3492) decoding, for domainToUnicode ----

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

const adapt = (delta, points, first) => {
	delta = first ? Math.floor(delta / DAMP) : delta >> 1;
	delta += Math.floor(delta / points);
	let k = 0;
	while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
		delta = Math.floor(delta / (BASE - T_MIN));
		k += BASE;
	}
	return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
};

const digitValue = (c) => {
	if (c >= 48 && c <= 57) return c - 22;
	if (c >= 65 && c <= 90) return c - 65;
	if (c >= 97 && c <= 122) return c - 97;
	return BASE;
};

// a Punycode label (without its xn--) as Unicode; null when it is not Punycode
const decodePunycode = (input) => {
	const output = [];
	const basic = input.lastIndexOf('-');
	for (let j = 0; j < basic; j++) output.push(input.charCodeAt(j));
	let n = INITIAL_N;
	let bias = INITIAL_BIAS;
	let i = 0;
	for (let at = basic > 0 ? basic + 1 : 0; at < input.length;) {
		const oldi = i;
		for (let w = 1, k = BASE; ; k += BASE) {
			if (at >= input.length) return null;
			const digit = digitValue(input.charCodeAt(at++));
			if (digit >= BASE) return null;
			i += digit * w;
			const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
			if (digit < t) break;
			w *= BASE - t;
		}
		bias = adapt(i - oldi, output.length + 1, oldi === 0);
		n += Math.floor(i / (output.length + 1));
		i %= output.length + 1;
		output.splice(i++, 0, n);
	}
	return String.fromCodePoint(...output);
};

/**
 * A domain with its Punycode labels (xn--) as Unicode, '' when it is not a valid domain.
 * @param {string} domain
 */
export function domainToUnicode(domain) {
	const ascii = domainToASCII(domain);
	if (ascii === '') return '';
	return ascii
		.split('.')
		.map((label) => (label.startsWith('xn--') ? (decodePunycode(label.slice(4)) ?? label) : label))
		.join('.');
}

/** A URL as the options http.request takes. */
export function urlToHttpOptions(url) {
	const options = {
		protocol: url.protocol,
		hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
		hash: url.hash,
		search: url.search,
		pathname: url.pathname,
		path: `${url.pathname || ''}${url.search || ''}`,
		href: url.href
	};
	if (url.port !== '') options.port = Number(url.port);
	if (url.username || url.password)
		options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
	return options;
}

// ---- the legacy API ----

/** Node's legacy URL object: what url.parse returns. */
export function Url() {
	this.protocol = null;
	this.slashes = null;
	this.auth = null;
	this.host = null;
	this.port = null;
	this.hostname = null;
	this.hash = null;
	this.search = null;
	this.query = null;
	this.pathname = null;
	this.path = null;
	this.href = null;
}

// schemes whose URLs have a host after their slashes (Node's slashedProtocol)
const SLASHED = new Set(['http', 'https', 'ftp', 'gopher', 'file', 'ws', 'wss']);

/**
 * A URL string split into Node's legacy fields (protocol, auth, host, pathname, query, ...);
 * query parsed into an object when parseQueryString.
 * @param {string} urlString
 * @param {boolean} [parseQueryString]
 * @param {boolean} [slashesDenoteHost]
 */
export function parse(urlString, parseQueryString = false, slashesDenoteHost = false) {
	if (urlString instanceof Url) return urlString;
	if (typeof urlString !== 'string')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "url" argument must be of type string. Received ${urlString === null ? 'null' : typeof urlString}`
		);
	const out = new Url();
	let rest = urlString.trim();

	const hashAt = rest.indexOf('#');
	if (hashAt !== -1) {
		out.hash = rest.slice(hashAt);
		rest = rest.slice(0, hashAt);
	}
	const queryAt = rest.indexOf('?');
	if (queryAt !== -1) {
		out.search = rest.slice(queryAt);
		out.query = rest.slice(queryAt + 1);
		rest = rest.slice(0, queryAt);
	} else if (parseQueryString) {
		out.search = '';
		out.query = Object.create(null);
	}

	const protocol = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(rest);
	if (protocol !== null) {
		out.protocol = protocol[1].toLowerCase();
		rest = rest.slice(protocol[1].length);
	}
	const scheme = out.protocol?.slice(0, -1);
	if (
		rest.startsWith('//') &&
		(slashesDenoteHost || protocol === null || scheme !== 'javascript')
	) {
		if (protocol === null ? slashesDenoteHost : true) {
			out.slashes = true;
			rest = rest.slice(2);
			let end = rest.search(/[/\\]/);
			if (end === -1) end = rest.length;
			let host = rest.slice(0, end);
			rest = rest.slice(end);
			const at = host.lastIndexOf('@');
			if (at !== -1) {
				out.auth = decodeURIComponent(host.slice(0, at));
				host = host.slice(at + 1);
			}
			const port = /:([0-9]*)$/.exec(host);
			if (port !== null) {
				if (port[1] !== '') out.port = port[1];
				host = host.slice(0, -port[0].length);
			}
			out.hostname = host.toLowerCase();
			out.host = out.hostname + (out.port !== null ? `:${out.port}` : '');
		}
	}

	if (rest !== '' || out.host !== null)
		out.pathname = rest === '' && SLASHED.has(scheme) ? '/' : rest;
	if (out.pathname === '') out.pathname = null;
	if (parseQueryString && typeof out.query === 'string') out.query = queryObject(out.query);
	out.path = (out.pathname ?? '') + (out.search ?? '') || null;
	out.href = format(out);
	return out;
}

// a query string as querystring.parse has it: a null-prototype object, a repeated key's values
// in an array
const queryObject = (query) => {
	const out = Object.create(null);
	for (const [key, value] of new URLSearchParams(query)) {
		const seen = out[key];
		if (seen === undefined) out[key] = value;
		else if (Array.isArray(seen)) seen.push(value);
		else out[key] = [seen, value];
	}
	return out;
};

/**
 * A URL string from a URL or a legacy URL object (or a string, parsed first). For a URL,
 * options { auth, fragment, search, unicode } leave parts out (or show the host in Unicode).
 */
export function format(urlObject, options) {
	if (typeof urlObject === 'string') urlObject = parse(urlObject);
	if (urlObject instanceof URL) {
		const opts = { auth: true, fragment: true, search: true, unicode: false, ...options };
		let out = `${urlObject.protocol}`;
		if (urlObject.host !== '' || urlObject.protocol === 'file:') {
			out += '//';
			if (opts.auth && (urlObject.username || urlObject.password))
				out += urlObject.username + (urlObject.password ? `:${urlObject.password}` : '') + '@';
			out += opts.unicode ? domainToUnicode(urlObject.hostname) : urlObject.hostname;
			if (urlObject.port) out += `:${urlObject.port}`;
		}
		out += urlObject.pathname;
		if (opts.search) out += urlObject.search;
		if (opts.fragment) out += urlObject.hash;
		return out;
	}
	if (urlObject === null || typeof urlObject !== 'object')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "urlObject" argument must be one of type object or string. Received ${urlObject === null ? 'null' : typeof urlObject}`
		);

	let protocol = urlObject.protocol ?? '';
	if (protocol !== '' && !protocol.endsWith(':')) protocol += ':';
	let auth = urlObject.auth ?? '';
	if (auth !== '') auth = encodeURIComponent(auth).replaceAll('%3A', ':') + '@';
	let host = '';
	if (urlObject.host) host = auth + urlObject.host;
	else if (urlObject.hostname) {
		host =
			auth +
			(urlObject.hostname.includes(':') && !urlObject.hostname.startsWith('[')
				? `[${urlObject.hostname}]`
				: urlObject.hostname);
		if (urlObject.port) host += `:${urlObject.port}`;
	}
	let pathname = urlObject.pathname ?? '';
	let hash = urlObject.hash ?? '';
	let search = urlObject.search ?? '';
	if (search === '' && urlObject.query !== null && typeof urlObject.query === 'object') {
		const query = new URLSearchParams(urlObject.query).toString();
		if (query !== '') search = `?${query}`;
	}
	if (search !== '' && !search.startsWith('?')) search = `?${search}`;
	if (hash !== '' && !hash.startsWith('#')) hash = `#${hash}`;

	const scheme = protocol.slice(0, -1);
	if (urlObject.slashes || ((protocol === '' || SLASHED.has(scheme)) && host !== '')) {
		if (host !== '' || SLASHED.has(scheme)) host = `//${host}`;
		if (pathname !== '' && !pathname.startsWith('/')) pathname = `/${pathname}`;
	}
	pathname = pathname.replace(/[?#]/g, encodeURIComponent);
	search = search.replaceAll('#', '%23');
	return protocol + host + pathname + search + hash;
}

/** A URL (to) resolved against another (from), as a browser would an anchor's href. */
export function resolve(from, to) {
	const resolved = new URL(to, new URL(from, 'resolve://'));
	if (resolved.protocol === 'resolve:') {
		const { pathname, search, hash } = resolved;
		return pathname + search + hash;
	}
	return resolved.toString();
}

export default {
	URL,
	URLSearchParams,
	fileURLToPath,
	pathToFileURL,
	domainToASCII,
	domainToUnicode,
	urlToHttpOptions,
	Url,
	parse,
	format,
	resolve
};
