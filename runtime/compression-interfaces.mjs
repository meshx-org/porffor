// CompressionStream and DecompressionStream declared as WebIDL interfaces (./webidl.mjs), for
// ./webidl-shape.mjs to shape. Its own provider (runtime/globals.json), loaded only for a
// program that names one and looks at shapes: declaring an interface costs some 16 KB of
// registry, which a program that only compresses does not carry.

import { CompressionStream } from './compression-stream.mjs';
import { DecompressionStream } from './decompression-stream.mjs';
import { defineInterface } from './webidl.mjs';

defineInterface(CompressionStream, 'CompressionStream');
defineInterface(DecompressionStream, 'DecompressionStream');
