// Porffor's own UTF-8 TextDecoder and TextEncoder (compiler/builtins/textcodec.ts), for the
// runtime's use: a module that decodes or encodes UTF-8 gets them from here rather than naming
// the globals, which a bundle binds to runtime/text-decoder.mjs and runtime/text-encoder.mjs
// (the whole interface, and the other encodings' registry).
//
// The builtins are read through globalThis, which holds them until the program's globals are
// installed: as this module runs, which is before that (the providers that install them import
// it). Functions, not the classes themselves: a bundle's injected globals make its modules a
// cycle, so another module's top-level code (url-encoding.mjs's encoder) can run before this
// one's, and a function declaration exists from the start; it reads globalThis then.

const Decoder = globalThis.TextDecoder;
const Encoder = globalThis.TextEncoder;

/**
 * A new Porffor TextDecoder: UTF-8 only, a SIMD fast path.
 * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options]
 */
export function utf8Decoder(options = undefined) {
	const Builtin = Decoder ?? globalThis.TextDecoder;

	return new Builtin(undefined, options);
}

/** A new Porffor TextEncoder. */
export function utf8Encoder() {
	const Builtin = Encoder ?? globalThis.TextEncoder;

	return new Builtin();
}
