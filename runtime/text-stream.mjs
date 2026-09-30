// textStream() of Blob, Request and Response: the bytes through a TextDecoderStream (UTF-8,
// whatever the type's charset says). Its own provider (runtime/globals.json): loaded, plugging
// itself into ./chunk-stream.mjs, only for a program that names textStream.

import { textStreams } from './chunk-stream.mjs';
import { TextDecoderStream } from './text-decoder-stream.mjs';

textStreams().decode = (stream) => stream.pipeThrough(new TextDecoderStream());
