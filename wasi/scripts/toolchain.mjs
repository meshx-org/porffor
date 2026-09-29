/**
 * The external tools a Porffor component build needs, found once and checked.
 *
 * Each can be pointed at explicitly through the environment; otherwise the default is
 * the one beside it (Porffor: this checkout's cli/, the compiler it ships with) or the tool
 * on PATH. The versions are the ones the pipeline was verified with: the glue
 * reads wit-bindgen's C naming and header shapes, which change between releases.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The versions the glue generator's assumptions were verified against. */
const REQUIRED = {
	'wit-bindgen': '0.51.',
	'wasi-sdk': '34'
};

function fail(message) {
	throw new Error(`wasi-porffor toolchain: ${message}`);
}

function version(command) {
	try {
		return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function findWasiSdk() {
	const fromEnv = process.env.WASI_SDK_PATH;

	if (fromEnv !== undefined) {
		if (!existsSync(join(fromEnv, 'bin', 'clang')))
			fail(`WASI_SDK_PATH has no bin/clang: ${fromEnv}`);
		return fromEnv;
	}
	const home = homedir();
	const found = readdirSync(home)
		.filter((name) => name.startsWith(`wasi-sdk-${REQUIRED['wasi-sdk']}`))
		.map((name) => join(home, name))
		.find((dir) => existsSync(join(dir, 'bin', 'clang')));

	if (found === undefined)
		fail(
			`wasi-sdk ${REQUIRED['wasi-sdk']} not found: set WASI_SDK_PATH (no ~/wasi-sdk-${REQUIRED['wasi-sdk']}*)`
		);
	return found;
}

function findPorffor() {
	const cli = process.env.PORFFOR_CLI ?? resolve(here, '../../cli/index.js');

	if (!existsSync(cli)) fail(`Porffor's CLI is missing (${cli}): set PORFFOR_CLI`);
	return cli;
}

function requireTool(command, prefix) {
	const found = version(command);

	if (found === null) fail(`${command} is not on PATH`);

	if (prefix !== undefined && !found.split(/\s+/).some((word) => word.startsWith(prefix)))
		fail(`${command} ${prefix}x is required, found: ${found}`);
	return command;
}

let cached;

/**
 * The resolved toolchain: `clang`, `porffor` (the fork's CLI entry, run with node),
 * `witBindgen`, `wasmTools`, `wasmOpt`.
 * @returns {{ clang: string, porffor: string, witBindgen: string, wasmTools: string, wasmOpt: string }}
 */
export function toolchain() {
	if (cached !== undefined) return cached;
	const sdk = findWasiSdk();
	cached = {
		clang: join(sdk, 'bin', 'clang'),
		porffor: findPorffor(),
		witBindgen: requireTool(process.env.WIT_BINDGEN ?? 'wit-bindgen', REQUIRED['wit-bindgen']),
		wasmTools: requireTool(process.env.WASM_TOOLS ?? 'wasm-tools'),
		wasmOpt: requireTool(process.env.WASM_OPT ?? 'wasm-opt')
	};
	return cached;
}
