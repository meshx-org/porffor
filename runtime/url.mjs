// URL for a Porffor-compiled guest (https://url.spec.whatwg.org/#url-class), over the
// standard's basic URL parser (./url-parser.mjs): parsing against a base, every component
// getter and setter, origin, searchParams (kept in step with search), toJSON,
// URL.canParse and URL.parse. Hosts go through ./url-host.mjs, whose domain-to-ASCII is
// a subset of UTS #46 (see there).
//
// Injected into every guest (tree-shaken away unless used), with URLSearchParams.

import { parseForm, percentEncodeString, toUSVString, USERINFO } from './url-encoding.mjs';
import {
	cannotHaveCredentialsOrPort,
	hasOpaquePath,
	parseURL,
	serializeOrigin,
	serializeURL
} from './url-parser.mjs';
import { URLSearchParams } from './url-search-params.mjs';
import { defineInterface } from './webidl.mjs';

export { URLSearchParams };

/**
 * The blob URL store (https://w3c.github.io/FileAPI/#BlobURLStore), plugged in by ./blob-url.mjs
 * (loaded only for a program that names createObjectURL or revokeObjectURL): create makes a URL
 * for a Blob, revoke forgets one, resolve finds a URL's Blob (Request and fetch). Kept on this
 * function, not in a module binding (see ./webidl.mjs's interfaceRegistry).
 * @returns {{ create: ((blob: unknown) => string) | null, revoke: ((url: string) => void) | null,
 *   resolve: ((url: string) => import('./blob.mjs').Blob | null) | null }}
 */
export function blobUrlStore() {
	if (blobUrlStore.state === undefined)
		blobUrlStore.state = { create: null, revoke: null, resolve: null };

	return blobUrlStore.state;
}

/** A URL record from a string and an optional base string; null on failure. */
function parseWithBase(url, base) {
	let baseRecord = null;

	if (base !== undefined) {
		baseRecord = parseURL(toUSVString(base));

		if (baseRecord === null) return null;
	}

	return parseURL(toUSVString(url), baseRecord);
}

/** A parsed URL, its components readable and writable. */
export class URL {
	/**
	 * @param {string} url absolute, or relative to base
	 * @param {string} [base]
	 */
	constructor(url, base = undefined) {
		const record = parseWithBase(url, base);

		if (record === null) throw new TypeError(`Invalid URL: ${String(url)}`);
		this._url = record;
		this._searchParams = new URLSearchParams();
		this._searchParams._list = record.query === null ? [] : parseForm(record.query);
		this._searchParams._url = record;
	}

	/** Whether the string parses (against the base). */
	static canParse(url, base = undefined) {
		return parseWithBase(url, base) !== null;
	}

	/** The URL, or null when the string does not parse. */
	static parse(url, base = undefined) {
		return parseWithBase(url, base) === null ? null : new URL(url, base);
	}

	/** A new blob: URL for a Blob (./blob-url.mjs). */
	static createObjectURL(obj) {
		const { create } = blobUrlStore();

		if (create === null)
			throw new TypeError('URL.createObjectURL: blob URLs are not available here');

		return create(obj);
	}

	/** Forgets a blob: URL made by createObjectURL. */
	static revokeObjectURL(url) {
		const { revoke } = blobUrlStore();

		if (revoke !== null) revoke(`${url}`);
	}

	/** Replaces this URL's record, keeping searchParams bound to it. */
	_replace(record) {
		this._url = record;
		this._searchParams._url = record;
		this._searchParams._list = record.query === null ? [] : parseForm(record.query);
	}

	get href() {
		return serializeURL(this._url);
	}

	set href(value) {
		const record = parseURL(toUSVString(value));

		if (record === null) throw new TypeError(`Invalid URL: ${String(value)}`);
		this._replace(record);
	}

	get origin() {
		return serializeOrigin(this._url);
	}

	get protocol() {
		return this._url.scheme + ':';
	}

	set protocol(value) {
		parseURL(toUSVString(value) + ':', null, this._url, 'schemeStart');
	}

	get username() {
		return this._url.username;
	}

	set username(value) {
		if (cannotHaveCredentialsOrPort(this._url)) return;
		this._url.username = percentEncodeString(toUSVString(value), USERINFO);
	}

	get password() {
		return this._url.password;
	}

	set password(value) {
		if (cannotHaveCredentialsOrPort(this._url)) return;
		this._url.password = percentEncodeString(toUSVString(value), USERINFO);
	}

	get host() {
		const { host, port } = this._url;

		if (host === null) return '';

		return port === null ? host : host + ':' + port;
	}

	set host(value) {
		if (hasOpaquePath(this._url)) return;
		parseURL(toUSVString(value), null, this._url, 'host');
	}

	get hostname() {
		return this._url.host ?? '';
	}

	set hostname(value) {
		if (hasOpaquePath(this._url)) return;
		parseURL(toUSVString(value), null, this._url, 'hostname');
	}

	get port() {
		return this._url.port === null ? '' : String(this._url.port);
	}

	set port(value) {
		if (cannotHaveCredentialsOrPort(this._url)) return;
		const text = toUSVString(value);

		if (text === '') this._url.port = null;
		else parseURL(text, null, this._url, 'port');
	}

	get pathname() {
		const { path } = this._url;

		if (hasOpaquePath(this._url)) return path;

		return path.length === 0 ? '' : '/' + path.join('/');
	}

	set pathname(value) {
		if (hasOpaquePath(this._url)) return;
		this._url.path = [];
		parseURL(toUSVString(value), null, this._url, 'pathStart');
	}

	get search() {
		const { query } = this._url;

		return query === null || query === '' ? '' : '?' + query;
	}

	set search(value) {
		const text = toUSVString(value);

		if (text === '') {
			this._url.query = null;
			this._searchParams._list = [];

			return;
		}
		const input = text.startsWith('?') ? text.slice(1) : text;

		this._url.query = '';
		parseURL(input, null, this._url, 'query');
		this._searchParams._list = parseForm(input);
	}

	/** The query's pairs, kept in step with search. */
	get searchParams() {
		return this._searchParams;
	}

	get hash() {
		const { fragment } = this._url;

		return fragment === null || fragment === '' ? '' : '#' + fragment;
	}

	set hash(value) {
		const text = toUSVString(value);

		if (text === '') {
			this._url.fragment = null;

			return;
		}
		this._url.fragment = '';
		parseURL(text.startsWith('#') ? text.slice(1) : text, null, this._url, 'fragment');
	}

	toString() {
		return this.href;
	}

	toJSON() {
		return this.href;
	}
}

defineInterface(URL, 'URL');
