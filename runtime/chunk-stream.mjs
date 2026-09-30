// A body's or a Blob's bytes as a stream (./body.mjs, ./blob.mjs): its own module, so a program
// with Blobs and no Request or Response carries none of the body code.

import { ReadableStream } from './readable-stream.mjs';

/**
 * A readable byte stream of one chunk (none when empty), as a body's and a Blob's are. Every
 * member the stream reads is the object's own: a program's Object.prototype.type or .size
 * cannot change it (fetch's "safely extract").
 */
export function byteStream(bytes) {
	return new ReadableStream(
		{
			type: 'bytes',
			autoAllocateChunkSize: undefined,
			start(controller) {
				if (bytes.length > 0) controller.enqueue(bytes);
				controller.close();
			},
			pull: undefined,
			cancel: undefined
		},
		{ highWaterMark: 0, size: undefined }
	);
}

/**
 * textStream()'s decoder, plugged in by ./text-stream.mjs (loaded only for a program that names
 * textStream: it brings TextDecoderStream). Kept on this function, not in a module binding (see
 * ./webidl.mjs's interfaceRegistry).
 * @returns {{ decode: ((stream: ReadableStream) => ReadableStream) | null }}
 */
export function textStreams() {
	if (textStreams.state === undefined) textStreams.state = { decode: null };

	return textStreams.state;
}

/**
 * A byte stream as a stream of the strings its UTF-8 decodes to (Blob's and a body's textStream()),
 * the byte stream used from here on.
 * @param {ReadableStream} stream
 */
export function textStream(stream) {
	const { decode } = textStreams();

	if (decode === null) throw new TypeError('textStream: not available here');
	const out = decode(stream);

	stream._disturbed = true;

	return out;
}
