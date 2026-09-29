// File (https://w3c.github.io/FileAPI/#file-section): a component has no files, so a File is
// a Blob (blob.mjs) with a name and a last-modified time.

import { Blob } from './blob.mjs';

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
		super(fileBits, options);
		this._name = String(fileName);
		this._lastModified =
			options?.lastModified === undefined
				? Date.now()
				: Math.trunc(Number(options.lastModified)) || 0;
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
