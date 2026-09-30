// File (https://w3c.github.io/FileAPI/#file-section): a component has no files, so a File is
// a Blob (blob.mjs) with a name and a last-modified time.

import { Blob, blobOptions, convertParts, joinParts } from './blob.mjs';
import { toUSVString } from './url-encoding.mjs';
import { defineInterface } from './webidl.mjs';

// the build injects Blob from here too (scripts/bundle.mjs), so it is evaluated first
export { Blob };

// (see blob.mjs's TAG)
const TAG = 'File';

/** A Blob with a name and a last-modified time. */
export class File extends Blob {
	/**
	 * @param {Iterable<ArrayBuffer | ArrayBufferView | Blob | string>} fileBits
	 * @param {string} fileName
	 * @param {{ type?: string, endings?: 'transparent' | 'native', lastModified?: number }} [options]
	 */
	constructor(fileBits, fileName, options = undefined) {
		if (arguments.length < 2)
			throw new TypeError(
				`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`
			);
		super();
		// the arguments converted in order: the bits, the name, the options
		const parts = convertParts(fileBits, 'File');

		this._name = toUSVString(fileName);
		const { endings, lastModified, type } = blobOptions(options, 'File', true);

		this._bytes = joinParts(parts, endings);
		this._type = type;
		// (a long long: a non-finite time is 0)
		this._lastModified =
			lastModified === undefined
				? Date.now()
				: Number.isFinite(lastModified)
					? Math.trunc(lastModified)
					: 0;
	}

	/** The file's name. */
	get name() {
		return this._name;
	}

	/** When the file was last modified, in ms since the epoch. */
	get lastModified() {
		return this._lastModified;
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

defineInterface(File, 'File');
