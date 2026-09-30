// node:child_process: the synchronous calls (spawnSync, execFileSync, execSync) with Node's
// signatures, results and errors, over the platform's (porffor:child_process: libuv's uv_spawn
// natively; WASI has no processes, and throws). What Porffor's compiler runs its C compiler
// with, so it can compile itself; not all of Node's child_process.
import * as host from 'porffor:child_process';
import { decodeUtf8 } from '../host/c.mjs';

// a stdio setting as the host takes it: 0 a pipe, 1 inherited, 2 ignored
const STDIO = { pipe: 0, overlapped: 0, inherit: 1, ignore: 2 };
const stdioMode = (value) => {
	if (value === undefined || value === null) return 0;
	// a file descriptor of this process's own: inherited
	if (value === 0 || value === 1 || value === 2) return 1;
	const mode = STDIO[value];
	if (mode === undefined) {
		const e = new TypeError(`The argument 'stdio' is invalid. Received '${value}'`);
		e.code = 'ERR_INVALID_ARG_VALUE';
		throw e;
	}
	return mode;
};

const stdioModes = (stdio) => {
	if (stdio === undefined || stdio === null) return [0, 0, 0];
	if (typeof stdio === 'string') {
		const mode = stdioMode(stdio);
		return [mode, mode, mode];
	}
	return [stdioMode(stdio[0]), stdioMode(stdio[1]), stdioMode(stdio[2])];
};

// captured output as the encoding asks: a string, or a Uint8Array without one
const output = (bytes, encoding) => {
	if (encoding === 'utf8' || encoding === 'utf-8') return decodeUtf8(bytes);
	if (encoding === 'latin1' || encoding === 'binary') return bytes;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
	return out;
};

const envArray = (env) => {
	if (env === undefined || env === null) return undefined;
	const out = [];
	for (const key of Object.keys(env)) if (env[key] !== undefined) out.push(`${key}=${env[key]}`);
	return out;
};

export const spawnSync = (file, args, options) => {
	if (!Array.isArray(args)) {
		options = args;
		args = [];
	}
	options ??= {};
	const modes = stdioModes(options.stdio);
	const argv = [file];
	for (const arg of args) argv.push(String(arg));

	const [status, signal, stdout, stderr, spawnError] = host.spawnSync(
		file,
		argv,
		envArray(options.env),
		options.cwd,
		options.input,
		modes[0],
		modes[1],
		modes[2]
	);

	const result = { pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null };
	if (spawnError !== 0) {
		const code = host.errorName(spawnError);
		const e = new Error(`spawnSync ${file} ${code}`);
		e.errno = spawnError;
		e.code = code;
		e.syscall = `spawnSync ${file}`;
		e.path = file;
		e.spawnargs = argv.slice(1);
		result.error = e;
		return result;
	}

	result.stdout = modes[1] === 0 ? output(stdout, options.encoding) : null;
	result.stderr = modes[2] === 0 ? output(stderr, options.encoding) : null;
	result.output = [null, result.stdout, result.stderr];
	result.status = signal === 0 ? status : null;
	result.signal = signal === 0 ? null : signal;
	// execSync / execFileSync: without a stdio setting, stderr is captured and shown, as in Node
	result._stderrBytes = stderr;
	return result;
};

// execFileSync / execSync's handling of a spawnSync result: its stdout, or the error it throws
const checkedOutput = (command, result, options) => {
	if (
		options.stdio === undefined &&
		result._stderrBytes !== undefined &&
		result._stderrBytes.length > 0
	)
		host.writeStderr(result._stderrBytes);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		let message = `Command failed: ${command}`;
		if (result.stderr !== null && result.stderr.length > 0)
			message += `\n${typeof result.stderr === 'string' ? result.stderr : decodeUtf8(result._stderrBytes)}`;
		const e = new Error(message);
		e.status = result.status;
		e.signal = result.signal;
		e.stdout = result.stdout;
		e.stderr = result.stderr;
		e.output = result.output;
		throw e;
	}
	return result.stdout;
};

export const execFileSync = (file, args, options) => {
	if (!Array.isArray(args)) {
		options = args;
		args = [];
	}
	options ??= {};
	const result = spawnSync(file, args, options);
	return checkedOutput([file, ...args].join(' '), result, options);
};

// a command through the shell
export const execSync = (command, options) => {
	options ??= {};
	const result = spawnSync('/bin/sh', ['-c', command], options);
	return checkedOutput(command, result, options);
};

export default { spawnSync, execFileSync, execSync };
