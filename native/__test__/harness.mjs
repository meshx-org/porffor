// What the native end-to-end tests share: compiling a fixture program with Porffor for the native
// target with the runtime (`porf native --runtime`, libuv as its loop), running it, running the
// same program under Node to compare, and starting a fixture server and reading where it listens.
// A build is cached by the fixture's text and the compiler's, so reruns only compile what changed.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const run = promisify(execFile);

// the compiler's own files, whose change rebuilds every fixture: compiler/ and runtime/ (their
// sources, not the runtime's vendored C, which compiler/deps.js caches by its own key)
const compilerKey = (() => {
	const hash = createHash('sha256');
	const add = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const file = join(dir, name);

			if (name === 'c' || name === 'target' || name === 'node_modules') continue;
			if (statSync(file).isDirectory()) add(file);
			else if (/\.(m?js|ts|json)$/.test(name)) hash.update(name).update(readFileSync(file));
		}
	};

	add(join(root, 'compiler'));
	add(join(root, 'runtime'));

	return hash.digest('hex').slice(0, 16);
})();

const cacheDir = join(tmpdir(), 'porffor-native-tests');

/**
 * A fixture program (native/__test__/<name>/<file>) compiled natively with the runtime: the
 * binary's path.
 * @param {string} name the fixture's directory
 * @param {string} [file] its entry
 */
export async function build(name, file = 'main.mjs') {
	const entry = join(here, name, file);
	const key = createHash('sha256')
		.update(compilerKey)
		.update(readFileSync(entry))
		.digest('hex')
		.slice(0, 16);
	const out = join(cacheDir, `${name}-${file.replace(/\W/g, '_')}-${key}`);

	if (existsSync(out)) return out;
	mkdirSync(cacheDir, { recursive: true });

	try {
		await run(
			process.execPath,
			[join(root, 'cli/index.js'), 'native', '--runtime', entry, '-o', out],
			{
				cwd: root,
				maxBuffer: 64 * 1024 * 1024
			}
		);
	} catch (error) {
		throw new Error(
			`porffor native ${name}/${file} failed:\n${error.stderr || error.stdout || error.message}`,
			{
				cause: error
			}
		);
	}

	return out;
}

/**
 * A program's output: stdout, stderr and exit status. Porffor's console colours numbers and
 * booleans even into a pipe (Node's does not), so stdout is returned with the colour codes
 * taken out.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ env?: object, cwd?: string }} [options]
 */
export async function execute(command, args = [], options = {}) {
	try {
		const { stdout, stderr } = await run(command, args, {
			env: { ...process.env, ...options.env },
			cwd: options.cwd,
			maxBuffer: 64 * 1024 * 1024
		});

		return { stdout: plain(stdout), stderr, status: 0 };
	} catch (error) {
		return {
			stdout: plain(error.stdout ?? ''),
			stderr: error.stderr ?? '',
			status: error.code ?? 1
		};
	}
}

// a terminal colour code: ESC [ n (; n)* m
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[\\d+(?:;\\d+)*m`, 'g');
const plain = (text) => text.replace(COLOUR, '');

/**
 * A fixture run both ways: compiled by Porffor and under Node, for a test that expects the two
 * to print the same.
 * @param {string} name the fixture's directory
 * @param {string} [file] its entry
 */
export async function both(name, file = 'main.mjs') {
	const binary = await build(name, file);
	const cwd = join(here, name);
	const [porffor, node] = await Promise.all([
		execute(binary, [], { cwd }),
		execute(process.execPath, [join(here, name, file)], { cwd })
	]);

	return { porffor, node };
}

/**
 * A fixture server started on a free port (PORT=0): where it listens, and how to stop it. The
 * server says where on stderr ("listening on http://...").
 * @param {string} binary
 * @param {{ env?: object }} [options]
 * @returns {Promise<{ url: string, stop: () => Promise<void>, output: () => string }>}
 */
export function serve(binary, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [], { env: { ...process.env, PORT: '0', ...options.env } });
		let log = '';
		let started = false;
		const exited = new Promise((done) => child.on('exit', done));
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`the server did not say where it listens within 10 s:\n${log}`));
		}, 10_000);

		const read = (chunk) => {
			log += chunk;
			const match = /listening on (http:\/\/\S+)/.exec(log);

			if (started || !match) return;
			started = true;
			clearTimeout(timer);
			resolve({
				// (the server listens on IPv4, where Node would try localhost's ::1 first)
				url: match[1].replace(/\/\/(?:0\.0\.0\.0|localhost)/, '//127.0.0.1'),
				output: () => log,
				stop: async () => {
					child.kill('SIGTERM');
					const quit = setTimeout(() => child.kill('SIGKILL'), 2000);

					await exited;
					clearTimeout(quit);
				}
			});
		};

		child.stdout.on('data', read);
		child.stderr.on('data', read);
		child.on('exit', (code) => {
			if (!started) {
				clearTimeout(timer);
				reject(new Error(`the server exited (${code}) before listening:\n${log}`));
			}
		});
	});
}
