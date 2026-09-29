// What the end-to-end tests share: finding wasmtime 49+, building a fixture guest as a P3
// component with the package's own build, and invoking one of its exports.

import { execFile, execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { toolchain } from '../scripts/toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MIN_WASMTIME_MAJOR = 49;
const FEATURES =
	'exceptions=y,component-model-async=y,component-model-async-stackful=y,component-model-threading=y';
// a component whose async exports are lifted with a callback runs without the stackful and
// threading features: it must, or it would not be the thread-free build it claims to be
const CALLBACK_FEATURES = 'exceptions=y,component-model-async=y';
/** The components built with callback-lifted exports (their build said so). */
const callbackBuilds = new Set();

/** The wasmtime features a component runs with. */
const features = (component) => (callbackBuilds.has(component) ? CALLBACK_FEATURES : FEATURES);

/**
 * Whether a component built here lifts its async exports with a callback (every coroutine
 * stackless, so it needs no thread), rather than stackful on threads.
 * @param {string} component
 */
export const usesCallbacks = (component) => callbackBuilds.has(component);

function findWasmtime() {
	const command = process.env.WASMTIME ?? 'wasmtime';

	try {
		const version = execFileSync(command, ['--version'], { encoding: 'utf8' });
		const major = Number(/(\d+)\.\d+\.\d+/.exec(version)?.[1]);

		return major >= MIN_WASMTIME_MAJOR ? command : null;
	} catch {
		return null;
	}
}

const wasmtime = findWasmtime();

/** Why the end-to-end tests cannot run here, or null. */
export function missing() {
	if (wasmtime === null) return `wasmtime ${MIN_WASMTIME_MAJOR}+ (set WASMTIME)`;

	try {
		toolchain();

		return null;
	} catch (error) {
		return error.message;
	}
}

/**
 * Builds the fixture `__test__/<name>/` (guest.mjs + wit/) as a component; its path.
 * WASI_PORFFOR_UNITS builds the program split into that many C units; WASI_PORFFOR_CFLAGS
 * adds C flags (a Porffor switch such as -DPORF_NO_STACK_CHECK, when bisecting).
 */
export function buildFixture(name, world, target = 'p3') {
	const out = join(mkdtempSync(join(tmpdir(), `wasi-porffor-${name}-`)), `${world}.wasm`);

	const log = execFileSync(
		process.execPath,
		[
			join(here, '../scripts/build-component.mjs'),
			...['--guest', join(here, name, 'guest.mjs'), '--wit', join(here, name, 'wit')],
			...['--world', world, '--out', out, '--target', target],
			...(process.env.WASI_PORFFOR_UNITS ? ['--units', process.env.WASI_PORFFOR_UNITS] : []),
			...(process.env.WASI_PORFFOR_CFLAGS ? [`--cflags=${process.env.WASI_PORFFOR_CFLAGS}`] : [])
		],
		{ stdio: 'pipe', encoding: 'utf8' }
	);

	if (/, callback exports\)/.test(log)) callbackBuilds.add(out);

	return out;
}

/**
 * Invokes an export (`run("…")`) in wasmtime with the given WASI options (P3 by default, '' for none); the
 * string it returned. Asynchronous, so a server in this process can answer meanwhile.
 */
export async function invoke(component, call, wasi = 'p3=y') {
	const { stdout } = await promisify(execFile)(
		wasmtime,
		[
			'run',
			'-W',
			features(component),
			...(wasi === '' ? [] : ['-S', wasi]),
			'--invoke',
			call,
			component
		],
		{ encoding: 'utf8', timeout: Number(process.env.WASI_PORFFOR_INVOKE_TIMEOUT ?? 60_000) }
	);

	return JSON.parse(stdout.trim());
}

/** A free local TCP port. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();

		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();

			probe.close(() => resolve(port));
		});
	});
}

/**
 * Serves a wasi:http 0.3 component with `wasmtime serve` on a free port, once it answers;
 * its base URL, its log so far, and a stop function.
 * @param {string} component
 * @param {Record<string, string>} [env] environment variables for the guest
 */
export async function serve(component, env = {}) {
	const port = await freePort();
	const envArgs = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
	const child = spawn(
		wasmtime,
		[
			'serve',
			'-W',
			features(component),
			'-S',
			'p3=y,cli=y',
			...envArgs,
			'--addr',
			`127.0.0.1:${port}`,
			component
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let log = '';

	child.stdout.on('data', (chunk) => {
		log += chunk;
	});
	child.stderr.on('data', (chunk) => {
		log += chunk;
	});
	const base = `http://127.0.0.1:${port}`;

	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await fetch(base + '/');

			break;
		} catch {
			await new Promise((resolve) => {
				setTimeout(resolve, 100);
			});
		}
	}

	return { base, log: () => log, stop: () => child.kill() };
}
