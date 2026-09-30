// URL.createObjectURL (https://w3c.github.io/FileAPI/#creating-revoking): a Blob given a blob:
// URL of this program's origin (blob:<origin>/<uuid>), which Request and fetch resolve to it
// (./url.mjs's blobUrlStore) until URL.revokeObjectURL forgets it.
//
// Its own provider (runtime/globals.json): loaded, plugging itself into URL, only for a program
// that names createObjectURL or revokeObjectURL.

import { Blob } from './blob.mjs';
import { baseUrl } from './base-url.mjs';
import { blobUrlStore, URL } from './url.mjs';

/** A random UUID (version 4), as a blob URL's path. */
function uuid() {
	const hex = '0123456789abcdef';
	let out = '';

	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
		else if (i === 14) out += '4';
		else out += hex[i === 19 ? 8 + Math.floor(Math.random() * 4) : Math.floor(Math.random() * 16)];
	}

	return out;
}

/** The live blob URLs (without fragments), to their Blobs. */
const entries = new Map();
const store = blobUrlStore();

store.create = (obj) => {
	if (!(obj instanceof Blob))
		throw new TypeError("URL.createObjectURL: parameter 1 is not of type 'Blob'");
	const base = baseUrl();
	const origin = base === undefined ? 'null' : new URL(base).origin;
	const url = `blob:${origin}/${uuid()}`;

	entries.set(url, obj);

	return url;
};

store.revoke = (url) => {
	entries.delete(url.split('#')[0]);
};

store.resolve = (url) => entries.get(url.split('#')[0]) ?? null;
