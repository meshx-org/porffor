// The streams' classes declared as WebIDL interfaces (./webidl.mjs), for ./webidl-shape.mjs to
// give them WebIDL's shape: enumerable members, names, @@toStringTag, `this` and argument-count
// checks. Its own provider (runtime/globals.json), loaded only for a program that names a
// stream and looks at shapes (webidl-shape's load pattern): declaring an interface costs a
// program some 16 KB of registry, which one that only uses streams does not carry.

import { ReadableStream } from './readable-stream.mjs';
import { ReadableStreamDefaultReader } from './readable-stream-reader.mjs';
import {
	ReadableByteStreamController,
	ReadableStreamBYOBReader,
	ReadableStreamBYOBRequest
} from './readable-byte-stream.mjs';
import { ReadableStreamDefaultController } from './stream-internals.mjs';
import { ByteLengthQueuingStrategy, CountQueuingStrategy } from './queuing-strategy.mjs';
import { TransformStream, TransformStreamDefaultController } from './transform-stream.mjs';
import { defineInterface } from './webidl.mjs';
import { WritableStreamDefaultController } from './writable-internals.mjs';
import { WritableStream } from './writable-stream.mjs';
import { WritableStreamDefaultWriter } from './writable-stream-writer.mjs';

defineInterface(ReadableStream, 'ReadableStream', { promises: ['cancel', 'pipeTo'] });
defineInterface(ReadableStreamDefaultReader, 'ReadableStreamDefaultReader', {
	promises: ['read', 'cancel']
});
defineInterface(ReadableStreamDefaultController, 'ReadableStreamDefaultController');
defineInterface(ReadableByteStreamController, 'ReadableByteStreamController');
defineInterface(ReadableStreamBYOBRequest, 'ReadableStreamBYOBRequest');
defineInterface(ReadableStreamBYOBReader, 'ReadableStreamBYOBReader', {
	promises: ['read', 'cancel']
});
defineInterface(WritableStream, 'WritableStream', { promises: ['abort', 'close'] });
defineInterface(WritableStreamDefaultWriter, 'WritableStreamDefaultWriter', {
	promises: ['abort', 'close', 'write']
});
defineInterface(WritableStreamDefaultController, 'WritableStreamDefaultController');
defineInterface(TransformStream, 'TransformStream');
defineInterface(TransformStreamDefaultController, 'TransformStreamDefaultController');
defineInterface(CountQueuingStrategy, 'CountQueuingStrategy');
defineInterface(ByteLengthQueuingStrategy, 'ByteLengthQueuingStrategy');
