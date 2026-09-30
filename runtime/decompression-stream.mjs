// DecompressionStream (https://compression.spec.whatwg.org/#decompressionstream) for a
// Porffor-compiled program: compressed bytes in, bytes out, in the 'deflate' (zlib),
// 'deflate-raw' or 'gzip' format, over the pure-JS inflater in ./zlib-inflate.mjs. Corrupt
// input, a bad checksum, bytes after the end, or an end that never comes error the stream
// with a TypeError. Its own global (runtime/globals.json): a program that never names it does
// not carry the inflater. 'brotli' is not supported (the constructor throws a TypeError).

import { TransformStream } from './transform-stream.mjs';
import { chunkBytes, compressionFormat } from './zlib-checksum.mjs';
import { Inflater } from './zlib-inflate.mjs';

/** Decompresses a stream of BufferSources into a stream of Uint8Arrays. */
export class DecompressionStream {
	/** @param {'deflate' | 'deflate-raw' | 'gzip'} format */
	constructor(format) {
		const inflater = new Inflater(compressionFormat(format, 'DecompressionStream'));

		this._stream = new TransformStream({
			transform(chunk, controller) {
				const out = inflater.push(chunkBytes(chunk, 'DecompressionStream'));

				if (out.length > 0) controller.enqueue(out);

				if (inflater.trailing)
					throw new TypeError('DecompressionStream: input after the end of the stream');
			},
			flush() {
				if (!inflater.ended)
					throw new TypeError('DecompressionStream: the input ended before the stream did');
			}
		});
	}

	/** The side decompressed bytes come out of. */
	get readable() {
		return this._stream.readable;
	}

	/** The side compressed bytes go into. */
	get writable() {
		return this._stream.writable;
	}
}
