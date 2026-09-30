// node:process: Node's process object over the platform's (porffor:process: libuv natively,
// wasi-libc in a WASI build): an EventEmitter with the arguments, the environment (writes to
// process.env reach the real environment, as in Node), the working directory, exit, the clock,
// standard output and error, and what Node says of itself.
//
// For a compiled program argv[1] is the program itself (as a Node single executable application
// has it), so process.argv.slice(2) are its arguments. Not here: signals and kill, a readable
// stdin stream (stdin.readLine() reads a line, blocking), and the 'exit' event at the program's
// natural end (exit() emits it; the runtime would have to call process.exit at the end).
import * as host from 'porffor:process';
import { errorMessage, errorName } from 'porffor:fs';
import { EventEmitter } from './events.mjs';

// the Node release whose API this follows, and Porffor's own version (package.json's)
const NODE_VERSION = '24.0.0';
const PORFFOR_VERSION = '0.0.1';

const startNs = host.hrtime();

const process = new EventEmitter();

// ---- arguments ----

const argv0 = host.argCount() > 0 ? host.arg(0) : 'porffor';
const execPath = host.execPath() || argv0;
const argv = [execPath, execPath];
for (let i = 1; i < host.argCount(); i++) argv.push(host.arg(i));

process.argv = argv;
process.argv0 = argv0;
process.execArgv = [];
process.execPath = execPath;
process.title = argv0.slice(argv0.lastIndexOf('/') + 1);

// ---- the environment ----

// the environment as an object: a write or delete reaches the real environment (setenv), a value
// is stored as a string, as Node's are
const envTarget = host.env();
process.env = new Proxy(envTarget, {
	set(target, name, value) {
		if (typeof name !== 'string') return false;
		const string = String(value);
		target[name] = string;
		host.setenv(name, string);
		return true;
	},
	deleteProperty(target, name) {
		if (typeof name !== 'string') return true;
		delete target[name];
		host.setenv(name, undefined);
		return true;
	},
	defineProperty(target, name, descriptor) {
		if (typeof name !== 'string' || !('value' in descriptor)) return false;
		const string = String(descriptor.value);
		target[name] = string;
		host.setenv(name, string);
		return true;
	}
});

// ---- the process ----

process.platform = host.platform();
process.arch = (() => {
	const machine = host.systemInfo(2);
	if (machine === 'x86_64' || machine === 'amd64') return 'x64';
	if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
	if (machine === 'i386' || machine === 'i686') return 'ia32';
	if (machine.startsWith('arm')) return 'arm';
	return machine;
})();
process.pid = host.pid();
process.ppid = 0;
process.version = `v${NODE_VERSION}`;
process.versions = { node: NODE_VERSION, porffor: PORFFOR_VERSION };
// 'node', as Node's: code tells Node apart by it, and this is Node's API
process.release = { name: 'node' };
process.config = { variables: {} };
process.features = { inspector: false, ipv6: true, tls: false, typescript: false };
process.exitCode = undefined;

/** The working directory. */
process.cwd = () => host.cwd();

/** Changes the working directory; Node's error (ENOENT: ..., chdir 'from' -> 'to') if it cannot. */
process.chdir = (directory) => {
	if (typeof directory !== 'string') {
		const e = new TypeError(
			`The "directory" argument must be of type string. Received ${directory === null ? 'null' : typeof directory}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
	const from = host.cwd();
	const err = host.chdir(directory);
	if (err !== 0) {
		const code = errorName(err);
		const e = new Error(`${code}: ${errorMessage(err)}, chdir ${from} -> '${directory}'`);
		e.errno = err;
		e.code = code;
		e.syscall = 'chdir';
		e.path = from;
		e.dest = directory;
		throw e;
	}
};

let exiting = false;

/** Ends the program with code (process.exitCode, else 0), after the 'exit' listeners. */
process.exit = (code) => {
	if (code !== undefined) process.exitCode = code;
	if (!exiting) {
		exiting = true;
		process.emit('exit', Number(process.exitCode ?? 0));
	}
	host.exit(Number(process.exitCode ?? 0) | 0);
};

/** Ends the program at once, as a crash would (exit code 134, SIGABRT's). */
process.abort = () => host.exit(134);

process.kill = (pid) => {
	if (pid === process.pid) process.exit(1);
	const e = new Error('kill ENOSYS');
	e.code = 'ENOSYS';
	e.syscall = 'kill';
	throw e;
};

process.umask = () => 0o022;

// ---- time and memory ----

const NS_PER_SEC = 1e9;

/**
 * The monotonic clock as [seconds, nanoseconds], or the time since an earlier such pair.
 * @param {[number, number]} [previous]
 */
process.hrtime = (previous) => {
	const ns = host.hrtime();
	let seconds = Math.floor(ns / NS_PER_SEC);
	let nanos = ns - seconds * NS_PER_SEC;
	if (previous !== undefined) {
		seconds -= previous[0];
		nanos -= previous[1];
		if (nanos < 0) {
			seconds--;
			nanos += NS_PER_SEC;
		}
	}
	return [seconds, nanos];
};

/** The monotonic clock in nanoseconds, as a BigInt. */
process.hrtime.bigint = () => BigInt(Math.floor(host.hrtime()));

/** Seconds since the program started. */
process.uptime = () => (host.hrtime() - startNs) / NS_PER_SEC;

/**
 * Memory in use, in bytes. Only the resident set size is measured (natively); the heap's
 * numbers are the same approximation of it, Porffor has no separate heap to count.
 */
process.memoryUsage = () => {
	const rss = host.residentMemory();
	return { rss, heapTotal: rss, heapUsed: rss, external: 0, arrayBuffers: 0 };
};
process.memoryUsage.rss = () => host.residentMemory();

process.cpuUsage = () => ({ user: 0, system: 0 });

/**
 * Calls fn(...args) once the current code (and the promise jobs before it) is done: a microtask,
 * where Node's runs just before them.
 */
process.nextTick = (fn, ...args) => {
	if (typeof fn !== 'function') {
		const e = new TypeError(
			`The "callback" argument must be of type function. Received ${typeof fn}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
	Promise.resolve().then(() => fn(...args));
};

/** Prints a warning (to stderr, as Node words it) and emits 'warning' with it. */
process.emitWarning = (warning, type, code) => {
	if (type !== null && typeof type === 'object') {
		code = type.code;
		type = type.type;
	}
	const error = typeof warning === 'string' ? new Error(warning) : warning;
	if (typeof warning === 'string') error.name = type ?? 'Warning';
	if (code !== undefined) error.code = code;
	host.writeTo(
		2,
		`(node:${process.pid}) ${code !== undefined ? `[${code}] ` : ''}${error.name}: ${error.message}\n`
	);
	process.emit('warning', error);
};

// ---- standard streams ----

// a standard output stream: write() of strings (UTF-8) and bytes, an EventEmitter for the rest
const outputStream = (fd) => {
	const stream = new EventEmitter();
	stream.fd = fd;
	// true on a terminal, else not set (undefined), as Node has it
	if (host.isTTY(fd)) stream.isTTY = true;
	stream.writable = true;
	stream.columns = 80;
	stream.rows = 24;
	stream.write = (chunk, encoding, callback) => {
		if (typeof encoding === 'function') callback = encoding;
		if (typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) {
			const e = new TypeError(
				`The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${chunk === null ? 'null' : typeof chunk}`
			);
			e.code = 'ERR_INVALID_ARG_TYPE';
			throw e;
		}
		host.writeTo(fd, chunk);
		if (typeof callback === 'function') Promise.resolve().then(() => callback(null));
		return true;
	};
	stream.end = (chunk, encoding, callback) => {
		if (typeof chunk === 'function') callback = chunk;
		else if (chunk !== undefined && chunk !== null) stream.write(chunk, encoding);
		if (typeof callback === 'function') Promise.resolve().then(() => callback());
		return stream;
	};
	stream.cork = () => {};
	stream.uncork = () => {};
	stream.hasColors = () => stream.isTTY === true;
	stream.getColorDepth = () => (stream.isTTY ? 8 : 1);
	return stream;
};

process.stdout = outputStream(1);
process.stderr = outputStream(2);

const stdin = new EventEmitter();
stdin.fd = 0;
if (host.isTTY(0)) stdin.isTTY = true;
stdin.readable = true;
/** One line of standard input (with its newline), undefined at its end; it blocks until then. */
stdin.readLine = () => host.readLine();
stdin.setEncoding = () => stdin;
stdin.setRawMode = () => stdin;
stdin.pause = () => stdin;
stdin.resume = () => stdin;
process.stdin = stdin;

export default process;

// Node's named exports: the process object's own members
export const {
	env,
	platform,
	arch,
	pid,
	ppid,
	version,
	versions,
	release,
	stdout,
	stderr,
	cwd,
	chdir,
	exit,
	abort,
	kill,
	umask,
	hrtime,
	uptime,
	memoryUsage,
	cpuUsage,
	nextTick,
	emitWarning,
	title
} = process;
export { argv, argv0, execPath, stdin };
