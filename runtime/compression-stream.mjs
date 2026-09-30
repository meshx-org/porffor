// CompressionStream (https://compression.spec.whatwg.org/#compressionstream) for a
// Porffor-compiled program: bytes in, compressed bytes out, in the 'deflate' (zlib),
// 'deflate-raw' or 'gzip' format, over the pure-JS deflater in ./zlib-deflate.mjs. Its own
// global (runtime/globals.json): a program that never names it does not carry the deflater.
// 'brotli' is not supported (the constructor throws a TypeError for it).

import { TransformStream } from './transform-stream.mjs';
import { chunkBytes, compressionFormat } from './zlib-checksum.mjs';
import { Deflater } from './zlib-deflate.mjs';

/** Compresses a stream of BufferSources into a stream of Uint8Arrays. */
export class CompressionStream {
	/** @param {'deflate' | 'deflate-raw' | 'gzip'} format */
	constructor(format) {
		const deflater = new Deflater(compressionFormat(format, 'CompressionStream'));

		this._stream = new TransformStream({
			transform(chunk, controller) {
				const out = deflater.push(chunkBytes(chunk, 'CompressionStream'));

				if (out.length > 0) controller.enqueue(out);
			},
			flush(controller) {
				controller.enqueue(deflater.finish());
			}
		});
	}

	/** The side compressed bytes come out of. */
	get readable() {
		return this._stream.readable;
	}

	/** The side bytes go into. */
	get writable() {
		return this._stream.writable;
	}
}
