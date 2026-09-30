// node:fs: the synchronous calls Porffor's compiler makes (so it can compile itself), with Node's
// signatures and errors (code, errno, syscall, path), over the host's (host/native/fs.mjs).
// Not all of Node's fs: what a program needs beyond these is not here.
import * as host from '../host/native/fs.mjs';
import { decodeUtf8, errnoName } from '../host/native/c.mjs';
import { dirname, join, resolve } from './path.mjs';

// libuv's messages, which Node's errors carry
const MESSAGES = {
	EACCES: 'permission denied',
	EEXIST: 'file already exists',
	EISDIR: 'illegal operation on a directory',
	ENOENT: 'no such file or directory',
	ENOTDIR: 'not a directory',
	ENOTEMPTY: 'directory not empty',
	EPERM: 'operation not permitted',
	EXDEV: 'cross-device link not permitted'
};

// Node's error for a failed call: ENOENT: no such file or directory, open 'a.txt'
const systemError = (errno, syscall, path, dest) => {
	const code = errnoName(errno);
	let message = `${code}: ${MESSAGES[code] ?? 'unknown error'}, ${syscall} '${path}'`;
	if (dest !== undefined) message += ` -> '${dest}'`;
	const e = new Error(message);
	e.errno = -errno;
	e.code = code;
	e.syscall = syscall;
	e.path = path;
	if (dest !== undefined) e.dest = dest;
	return e;
};

// a path argument: a string, or a file: URL
const toPath = (path) => {
	if (typeof path === 'string') return path;
	if (path !== null && typeof path === 'object' && path.protocol === 'file:')
		return decodeURIComponent(path.pathname);
	const e = new TypeError(
		`The "path" argument must be of type string or an instance of URL. Received ${typeof path}`
	);
	e.code = 'ERR_INVALID_ARG_TYPE';
	throw e;
};

const optionsObject = (options) =>
	typeof options === 'string'
		? { encoding: options }
		: options === null || options === undefined
			? {}
			: options;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const isDirectoryMode = (mode) => (mode & S_IFMT) === S_IFDIR;

export const existsSync = (path) => {
	try {
		return host.stat(toPath(path), true) !== undefined;
	} catch {
		return false;
	}
};

export const statSync = (path, options) => {
	path = toPath(path);
	const fields = host.stat(path, true);
	if (fields === undefined) {
		if (options?.throwIfNoEntry === false && errnoName(host.error()) === 'ENOENT') return undefined;
		throw systemError(host.error(), 'stat', path);
	}
	const mode = fields[2];
	return {
		mode,
		size: fields[7],
		mtimeMs: fields[11],
		isFile: () => (mode & S_IFMT) === S_IFREG,
		isDirectory: () => (mode & S_IFMT) === S_IFDIR,
		isSymbolicLink: () => (mode & S_IFMT) === S_IFLNK
	};
};

// a file as a string (utf8, else its bytes as latin1) or, with no encoding, a Uint8Array
export const readFileSync = (path, options) => {
	path = toPath(path);
	const { encoding } = optionsObject(options);
	const bytes = host.readFile(path);
	if (bytes === undefined) {
		const errno = host.error();
		throw systemError(errno, errnoName(errno) === 'EISDIR' ? 'read' : 'open', path);
	}
	if (encoding === 'utf8' || encoding === 'utf-8') return decodeUtf8(bytes);
	if (encoding === 'latin1' || encoding === 'binary') return bytes;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
	return out;
};

// a string (as UTF-8) or a typed array's bytes; flag 'a' appends, 'x' in it makes it exclusive
export const writeFileSync = (path, data, options) => {
	path = toPath(path);
	const { flag = 'w', mode = 0o666 } = optionsObject(options);
	if (host.writeFile(path, data, flag[0] === 'a' ? 1 : 0, flag.includes('x') ? 1 : 0, mode) !== 0)
		throw systemError(host.error(), 'open', path);
};

export const readdirSync = (path) => {
	path = toPath(path);
	const entries = host.readdir(path);
	if (entries === undefined) throw systemError(host.error(), 'scandir', path);
	const out = [];
	for (const [name] of entries) out.push(name);
	return out.sort();
};

// with recursive: the missing directories on the way too, and the first one made returned
export const mkdirSync = (path, options) => {
	path = toPath(path);
	const opts = typeof options === 'number' ? { mode: options } : optionsObject(options);
	const mode = opts.mode ?? 0o777;
	if (!opts.recursive) {
		if (host.pathCall(0, path, mode) !== 0) throw systemError(host.error(), 'mkdir', path);
		return undefined;
	}

	const missing = [];
	let dir = resolve(path);
	while (true) {
		const fields = host.stat(dir, true);
		if (fields !== undefined) {
			if (!isDirectoryMode(fields[2])) {
				const e = new Error(`EEXIST: file already exists, mkdir '${path}'`);
				e.code = 'EEXIST';
				e.syscall = 'mkdir';
				e.path = path;
				throw e;
			}
			break;
		}
		missing.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	let first;
	for (let i = missing.length - 1; i >= 0; i--) {
		if (host.pathCall(0, missing[i], mode) !== 0 && errnoName(host.error()) !== 'EEXIST')
			throw systemError(host.error(), 'mkdir', path);
		first ??= missing[i];
	}
	return first;
};

// a path and everything under it (its symbolic links, not what they point at)
const removeTree = (path) => {
	const fields = host.stat(path, false);
	if (fields === undefined) throw systemError(host.error(), 'lstat', path);
	if (isDirectoryMode(fields[2])) {
		const entries = host.readdir(path);
		if (entries === undefined) throw systemError(host.error(), 'scandir', path);
		for (const [name] of entries) removeTree(join(path, name));
		if (host.pathCall(1, path, 0) !== 0) throw systemError(host.error(), 'rmdir', path);
	} else if (host.pathCall(2, path, 0) !== 0) {
		throw systemError(host.error(), 'unlink', path);
	}
};

export const rmSync = (path, options) => {
	path = toPath(path);
	const { recursive = false, force = false } = optionsObject(options);
	const fields = host.stat(path, false);
	if (fields === undefined) {
		if (force && errnoName(host.error()) === 'ENOENT') return;
		throw systemError(host.error(), 'lstat', path);
	}
	if (isDirectoryMode(fields[2]) && !recursive) {
		const e = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`);
		e.code = 'ERR_FS_EISDIR';
		e.path = path;
		throw e;
	}
	removeTree(path);
};

export const mkdtempSync = (prefix) => {
	const out = host.mkdtemp(prefix);
	if (out === undefined) throw systemError(host.error(), 'mkdtemp', `${prefix}XXXXXX`);
	return out;
};

export const renameSync = (from, to) => {
	from = toPath(from);
	to = toPath(to);
	if (host.pathPairCall(0, from, to) !== 0) throw systemError(host.error(), 'rename', from, to);
};

export const symlinkSync = (target, path) => {
	path = toPath(path);
	if (host.pathPairCall(1, target, path) !== 0)
		throw systemError(host.error(), 'symlink', target, path);
};

// a file, or with recursive a directory and what is under it
export const cpSync = (src, dest, options) => {
	src = toPath(src);
	dest = toPath(dest);
	const { recursive = false } = optionsObject(options);
	const copy = (from, to) => {
		const fields = host.stat(from, true);
		if (fields === undefined) throw systemError(host.error(), 'stat', from);
		if (isDirectoryMode(fields[2])) {
			if (!recursive) {
				const e = new Error(`Recursive option is required to copy a directory: ${from}`);
				e.code = 'ERR_FS_EISDIR';
				throw e;
			}
			if (host.stat(to, true) === undefined && host.pathCall(0, to, 0o777) !== 0)
				throw systemError(host.error(), 'mkdir', to);
			const entries = host.readdir(from);
			if (entries === undefined) throw systemError(host.error(), 'scandir', from);
			for (const [name] of entries) copy(join(from, name), join(to, name));
			return;
		}
		if (host.copyFile(from, to, 0) !== 0) throw systemError(host.error(), 'copyfile', from, to);
	};
	copy(src, dest);
};

export default {
	existsSync,
	statSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	mkdirSync,
	rmSync,
	mkdtempSync,
	renameSync,
	symlinkSync,
	cpSync
};
