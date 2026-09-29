/**
 * Builds JavaScript into a WebAssembly component with Porffor instead of ComponentizeJS:
 * the code is compiled ahead of time to C, and the WIT boundary is wit-bindgen's C bindings
 * plus generated glue (scripts/gen-glue.mjs).
 *
 * Steps: glue from the WIT, one bundle (glue + guest), Porffor to C, clang (Porffor's output
 * as is, configured by -D switches), wasm-opt over the whole core module, strip,
 * `wasm-tools component new`.
 *
 * The CLI (scripts/build-component.mjs, `wasi-porffor-build`) and the Vite plugin
 * (src/vite.mjs) both call buildComponent.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { toolchain } from '../scripts/toolchain.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '../scripts');
const run = promisify(execFile);

/**
 * @typedef {object} BuildOptions
 * @property {string} guest the guest as one ESM bundle: its named exports are the world's
 *   exports, its imports of the world's interfaces are bound to the component's imports
 * @property {string} wit the WIT directory
 * @property {string} world the world in it to build
 * @property {string} out where the component is written
 * @property {'p2' | 'p3'} [target] p2 (default): a WASI 0.2 component, which jco runs. p3:
 *   WASI 0.3, for async exports and async/await; wasmtime runs these, jco does not yet
 * @property {'release' | 'dev' | 'debug'} [mode] release (default): smallest code (clang
 *   -Oz with LTO and the multivalue ABI, wasm-opt -Oz, debug and name sections stripped).
 *   debug: clang -O1 -g, nothing stripped, so traps show names and `wasm-tools addr2line`
 *   maps offsets back to the C. dev: clang -O1 without -g, faster to compile than debug
 * @property {boolean} [eh] wasm exception handling (a throw inside try works). Default on
 *   for p3; off for p2, because jco cannot translate the exceptions proposal
 * @property {string} [work] the directory for intermediate files (default: .wasi-porffor/
 *   <world> beside out)
 * @property {string} [opt] the clang -O level, instead of the mode's
 * @property {number} [stack] the stack size in bytes (default 8 MiB)
 * @property {string[]} [cflags] extra clang flags
 * @property {string[]} [ldflags] extra link flags (clang's, `-Wl,…` for wasm-ld)
 * @property {string[]} [porfforFlags] extra Porffor flags (`--ic`, `--dtoa=…`)
 * @property {string[]} [wasmOptFlags] the release build's wasm-opt flags, instead of `-Oz`
 * @property {number} [units] the program as this many C files, compiled in parallel and
 *   cached, so a rebuild recompiles only what changed (default 1)
 * @property {number} [jobs] how many C files compile at a time (default 3)
 * @property {(message: string) => void} [log] progress lines (default console.log)
 */

/**
 * @typedef {object} BuildResult
 * @property {string} out the component written
 * @property {number} bytes its size
 * @property {'callback' | 'stackful'} lift how async exports are lifted
 * @property {boolean} eh whether it has exception handling
 * @property {string} work the directory with the intermediate files (entry.c, core.wasm)
 */

/**
 * The C the guest's code needs beside Porffor's, as bundle.mjs decided (natives.json): Colin
 * Percival's scrypt when it imports @noble/hashes' (runtime/c/scrypt; runtime/scrypt.mjs calls it).
 * @param {string} work
 * @returns {{ nativeSources: string[], nativeFlags: string[] }}
 */
function nativeCode(work) {
	const natives = JSON.parse(readFileSync(join(work, 'natives.json'), 'utf8'));

	if (!natives.scrypt) return { nativeSources: [], nativeFlags: [] };

	const scryptDir = join(dirname(scripts), '..', 'runtime', 'c', 'scrypt');

	return {
		nativeSources: ['crypto_scrypt-ref.c', 'sha256.c', 'insecure_memzero.c'].map((name) =>
			join(scryptDir, name)
		),
		nativeFlags: [`-I${scryptDir}`]
	};
}

/**
 * Builds a guest bundle into a WebAssembly component.
 * @param {BuildOptions} options
 * @returns {Promise<BuildResult>}
 */
export async function buildComponent(options) {
	const args = {
		target: 'p2',
		mode: 'release',
		stack: 8 * 1024 * 1024,
		cflags: [],
		ldflags: [],
		porfforFlags: [],
		wasmOptFlags: ['-Oz'],
		units: 1,
		jobs: 3,
		...options
	};
	const log = args.log ?? ((message) => process.stdout.write(`${message}\n`));

	for (const required of ['guest', 'wit', 'world', 'out'])
		if (args[required] === undefined) throw new Error(`wasi-porffor: ${required} is required`);

	if (!['release', 'dev', 'debug'].includes(args.mode))
		throw new Error('wasi-porffor: mode is release, dev or debug');

	if (args.target !== 'p2' && args.target !== 'p3')
		throw new Error('wasi-porffor: target is p2 or p3');

	const release = args.mode === 'release';
	const eh = args.eh ?? args.target === 'p3';
	const out = resolve(args.out);
	const work = resolve(args.work ?? join(dirname(out), '.wasi-porffor', args.world));
	mkdirSync(work, { recursive: true });
	const tools = toolchain();

	/** Runs a step; a failure throws, with the step's output. */
	async function step(name, command, argv, env = {}) {
		try {
			await run(command, argv, { env: { ...process.env, ...env }, maxBuffer: 1 << 28 });
		} catch (error) {
			throw new Error(
				`wasi-porffor: ${name} failed\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`,
				{ cause: error }
			);
		}
	}

	const node = process.execPath;
	const world = args.world.replaceAll('-', '_');
	// Porffor as a Node script (runtime/index.js), or the selfhosted compiler binary
	// (PORFFOR_CLI=…/selfhosted/porf), which also compiles regex literals ahead of time
	const porffor = (argv) =>
		/\.[cm]?js$/.test(tools.porffor) ? [node, [tools.porffor, ...argv]] : [tools.porffor, argv];

	await step('glue', node, [join(scripts, 'gen-glue.mjs'), resolve(args.wit), args.world, work], {
		WIT_BINDGEN: tools.witBindgen,
		WASM_TOOLS: tools.wasmTools
	});
	await step('bundle', node, [join(scripts, 'bundle.mjs'), work, resolve(args.guest)]);
	const { nativeSources, nativeFlags } = nativeCode(work);
	const units = args.units;
	/**
	 * How async exports are lifted, from the head of the C Porffor wrote (its PORF_STACKFUL):
	 * stackful, on threads, while some coroutine needs a stack of its own, else with a
	 * callback, and the component needs no thread. The glue and the bindings read it as
	 * RT_STACKFUL, added to the compile flags.
	 * @param {string} cSource porf.h, or entry.c for a program in one file
	 */
	function chooseLift(cSource) {
		const head = Buffer.alloc(4096);
		const fd = openSync(cSource, 'r');
		const read = readSync(fd, head, 0, head.length, 0);

		closeSync(fd);
		const found = /#define PORF_STACKFUL ([01])/.exec(head.toString('utf8', 0, read));

		if (!found) throw new Error(`wasi-porffor: no PORF_STACKFUL in ${cSource}`);
		lift = found[1] === '1' ? 'stackful' : 'callback';
		compileFlags.push(`-DRT_STACKFUL=${found[1]}`);
	}

	let lift = '';
	const compileFlags = [
		`--target=wasm32-wasi${args.target}`,
		args.opt ?? (release ? '-Oz' : '-O1'),
		...(args.mode === 'debug' ? ['-g'] : []),
		// 128-bit SIMD: clang may vectorise loops (string and byte scans, copies); every current
		// browser and wasmtime run it
		'-msimd128',
		'-D_WASI_EMULATED_MMAN',
		'-D_WASI_EMULATED_SIGNAL',
		'-D_WASI_EMULATED_PROCESS_CLOCKS',
		// Porffor's embedding switches: no main (glue.c calls porf_start from the first
		// export), collections only at export entry (the conservative scan cannot see wasm
		// locals), and no setjmp/longjmp without exception handling
		'-DPORF_NO_MAIN',
		'-DPORF_GC_DEFER',
		...(eh ? [] : ['-DPORF_NO_EH']),
		'-Wno-everything',
		...(eh ? ['-mllvm', '-wasm-enable-sjlj', '-mllvm', '-wasm-use-legacy-eh=false'] : []),
		// release: Porffor's jsval ({ f64, i32 }) passed and returned as two wasm values (the
		// default wasm32 ABI puts every struct argument in a stack copy and returns through a
		// pointer), and the whole program optimized as one at link time. -46% on apps/cloud.
		// wasi-libc keeps the default ABI, which is safe while no libc call takes a struct by value
		...(release
			? ['-mmultivalue', '-Xclang', '-target-abi', '-Xclang', 'experimental-mv', '-flto']
			: []),
		...args.cflags
	];

	const features = JSON.parse(readFileSync(join(work, 'features.json'), 'utf8'));
	// a world that imports wasi:clocks/timezone: Porffor's local time asks the host (glue.c)
	if (features.timezone) compileFlags.push('-DPORF_HOST_TIMEZONE');
	// an async world's stdio is a stream a sync export cannot wait on: the console writes
	// into memory, and the async exports' loops write it out (core.c)
	if (features.async) compileFlags.push('-DPORF_CONSOLE_FILES');
	const linkFlags = [
		// a reactor (no main to run): a link-time setting, which clang refuses with -c
		'-mexec-model=reactor',
		`-Wl,-z,stack-size=${args.stack}`,
		'-Wl,--skip-wit-component',
		join(work, 'bindings', `${world}_component_type.o`),
		'-lwasi-emulated-mman',
		'-lwasi-emulated-signal',
		'-lwasi-emulated-process-clocks',
		...(eh ? ['-lsetjmp'] : []),
		// LTO generates code at link time, where the compile's codegen options are gone: the ABI
		// again (else returns silently fall back to a pointer), and setjmp's lowering. The `=`
		// form: wasm-component-ld misreads -Wl,-mllvm,<option>
		...(release ? ['-Wl,-mllvm=-target-abi=experimental-mv'] : []),
		...(release && eh
			? ['-Wl,-mllvm=-wasm-enable-sjlj', '-Wl,-mllvm=-wasm-use-legacy-eh=false']
			: []),
		...args.ldflags,
		'-o',
		join(work, 'core.wasm')
	];

	/**
	 * The files an object was built from, as clang's dependency file lists them (the source and
	 * every header it included); empty when there is none yet.
	 */
	function dependencies(depFile) {
		if (!existsSync(depFile)) return [];

		return readFileSync(depFile, 'utf8')
			.replace(/\\\n/g, ' ')
			.replace(/^[^:]*:/, '')
			.split(/\s+/)
			.filter(Boolean);
	}

	/** A hash of the flags and the contents of every file an object depends on. */
	function dependencyHash(flags, files) {
		const hash = createHash('sha256').update(flags.join(' '));

		for (const file of files) hash.update(file).update(existsSync(file) ? readFileSync(file) : '');

		return hash.digest('hex');
	}

	/**
	 * Compiles C files to objects, `jobs` at a time; an object is reused when its flags and
	 * everything it was built from (the source and the headers it included) are unchanged.
	 */
	async function compileAll(sources, flags, jobs) {
		const objDir = join(work, 'obj');
		mkdirSync(objDir, { recursive: true });
		const queue = sources.slice();
		const objects = [];
		let compiled = 0;
		const worker = async () => {
			while (queue.length > 0) {
				const source = queue.shift();
				const object = join(objDir, basename(source).replace(/\.c$/, '.o'));
				const stamp = `${object}.hash`;
				const depFile = `${object}.d`;
				const previous = dependencies(depFile);

				objects.push(object);

				if (
					existsSync(object) &&
					existsSync(stamp) &&
					previous.length > 0 &&
					readFileSync(stamp, 'utf8') === dependencyHash(flags, previous)
				)
					continue;

				try {
					await run(tools.clang, [...flags, '-MD', '-MF', depFile, '-c', source, '-o', object], {
						maxBuffer: 1 << 28
					});
				} catch (error) {
					throw new Error(
						`wasi-porffor: clang failed on ${basename(source)}\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`,
						{ cause: error }
					);
				}
				writeFileSync(stamp, dependencyHash(flags, dependencies(depFile)));
				compiled++;
			}
		};

		await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
		log(`wasi-porffor: compiled ${compiled} of ${sources.length} C files`);
		return objects;
	}

	if (units > 1) {
		// the program in units: porf.h, the runtime, builtins, main and N parts of the program
		const cdir = join(work, 'c');

		rmSync(cdir, { recursive: true, force: true });
		await step(
			'porffor',
			...porffor([
				'c',
				join(work, 'entry.js'),
				'-o',
				`${cdir}/`,
				'--module',
				'--invoke-table',
				`--units=${units}`,
				...args.porfforFlags
			])
		);
		chooseLift(join(cdir, 'porf.h'));
		const sources = [
			...readdirSync(cdir)
				.filter((name) => name.endsWith('.c'))
				.map((name) => join(cdir, name)),
			join(work, 'glue.c'),
			join(work, 'bindings', `${world}.c`),
			...nativeSources
		];
		const objects = await compileAll(
			sources,
			[...compileFlags, '-DRT_SPLIT', `-I${cdir}`, ...nativeFlags],
			args.jobs
		);

		await step('link', tools.clang, [...compileFlags, ...objects, ...linkFlags]);
	} else {
		await step(
			'porffor',
			...porffor([
				'c',
				join(work, 'entry.js'),
				'-o',
				join(work, 'entry.c'),
				'--module',
				'--invoke-table',
				...args.porfforFlags
			])
		);
		chooseLift(join(work, 'entry.c'));
		await step('clang', tools.clang, [
			...compileFlags,
			...nativeFlags,
			join(work, 'glue.c'),
			join(work, 'bindings', `${world}.c`),
			...nativeSources,
			...linkFlags
		]);
	}

	let core = join(work, 'core.wasm');

	if (release) {
		// wasm-opt over the whole program, then everything a component does not need stripped;
		// the world's type rides in the component-type custom section, which stays
		await step('wasm-opt', tools.wasmOpt, [
			...args.wasmOptFlags,
			'--all-features',
			core,
			'-o',
			join(work, 'core.opt.wasm')
		]);
		await step('strip', tools.wasmTools, [
			'strip',
			'--delete',
			'^(\\.debug_.*|name|producers)$',
			join(work, 'core.opt.wasm'),
			'-o',
			join(work, 'core.strip.wasm')
		]);
		core = join(work, 'core.strip.wasm');
	}
	mkdirSync(dirname(out), { recursive: true });
	await step('component', tools.wasmTools, ['component', 'new', core, '-o', out]);
	await step('validate', tools.wasmTools, ['validate', '--features', 'all', out]);

	const bytes = statSync(out).size;
	log(
		`wasi-porffor: ${basename(out)} (${args.mode}, ${args.target}${eh ? ', eh' : ''}, ${lift} exports): ${bytes} bytes`
	);
	return { out, bytes, lift, eh, work };
}
