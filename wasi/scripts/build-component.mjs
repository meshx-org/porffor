#!/usr/bin/env node
/**
 * The command line to src/build.mjs: builds a guest bundle into a WebAssembly component with
 * Porffor instead of ComponentizeJS (the same build as the Vite plugin, src/vite.mjs).
 *
 *   wasi-porffor-build --guest <bundle.js> --wit <dir> --world <name> --out <file.wasm>
 *                     [--mode release|dev|debug] [--target p2|p3] [--eh | --no-eh]
 *                     [--work <dir>] [--opt <clang -O level>]
 *                     [--stack <bytes>] [--cflags "<extra clang flags>"]
 *
 *   --guest   the guest as one ESM bundle (yel-solid-build --bundle writes one); its
 *             named exports are the world's exports, its imports of the world's
 *             interfaces are bound to the component's imports
 *   --target  p2 (default): a WASI 0.2 component, as the shell runs them today through
 *             jco. p3: WASI 0.3, needed for async functions and async/await in guest code;
 *             wasmtime runs these, jco does not yet. Porffor runs coroutines as step
 *             functions over heap frames (stackless), so async exports are lifted with a
 *             callback and the component needs no thread; a coroutine that still needs a
 *             stack of its own (Porffor's PORF_STACKFUL) makes them stackful, on threads
 *   --mode    release (default): smallest code: clang -Oz with LTO and the multivalue ABI
 *             (a jsval in two wasm values), wasm-opt -Oz over the whole
 *             core module, and the DWARF, name and producers sections stripped (a trap's
 *             backtrace shows function indices). debug: clang -O1 -g, no wasm-opt, nothing
 *             stripped, so traps show function names and `wasm-tools addr2line` maps
 *             offsets back to Porffor's C and the glue. dev: clang -O1 without -g, no
 *             wasm-opt, nothing stripped: traps still show function names (the linker's
 *             name section), and a large program compiles much faster than debug
 *   --eh      wasm exception handling: a throw inside try works. Default for p3; p2
 *             defaults to --no-eh, because jco cannot translate the exceptions proposal
 *             (a throw inside try then traps with a message)
 *   --units   N (default 1): the program as N C files instead of one, compiled in parallel
 *             (--jobs at a time, default 3) and cached, so a rebuild recompiles only the
 *             files that changed. For large programs, where one file is minutes of clang
 */

import { parseArgs } from 'node:util';
import { buildComponent } from '../src/build.mjs';

const { values: args } = parseArgs({
	options: {
		guest: { type: 'string' },
		wit: { type: 'string' },
		world: { type: 'string' },
		out: { type: 'string' },
		target: { type: 'string', default: 'p2' },
		eh: { type: 'boolean' },
		'no-eh': { type: 'boolean' },
		work: { type: 'string' },
		mode: { type: 'string', default: 'release' },
		opt: { type: 'string' },
		stack: { type: 'string', default: String(8 * 1024 * 1024) },
		cflags: { type: 'string', default: '' },
		units: { type: 'string', default: '1' },
		jobs: { type: 'string', default: '3' }
	}
});

try {
	await buildComponent({
		guest: args.guest,
		wit: args.wit,
		world: args.world,
		out: args.out,
		target: args.target,
		mode: args.mode,
		eh: args['no-eh'] === true ? false : args.eh === true ? true : undefined,
		work: args.work,
		opt: args.opt,
		stack: Number(args.stack),
		cflags: args.cflags.split(/\s+/).filter(Boolean),
		units: Number(args.units),
		jobs: Number(args.jobs)
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
