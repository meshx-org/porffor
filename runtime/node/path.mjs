// node:path, POSIX: Node's algorithms (lib/path.js), paths as strings. win32 is not provided.
import { cwd } from '../host/native/process.mjs';

const validateString = (value, name) => {
	if (typeof value !== 'string') {
		const e = new TypeError(
			`The "${name}" argument must be of type string. Received ${value === null ? 'null' : typeof value}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
};

// resolves . and .. segments; the result has no leading or trailing slash
const normalizeString = (path, allowAboveRoot) => {
	let res = '';
	let lastSegmentLength = 0;
	let lastSlash = -1;
	let dots = 0;
	let code = '';
	for (let i = 0; i <= path.length; ++i) {
		if (i < path.length) code = path[i];
		else if (code === '/') break;
		else code = '/';

		if (code === '/') {
			if (lastSlash === i - 1 || dots === 1) {
				// nothing: an empty or . segment
			} else if (dots === 2) {
				if (
					res.length < 2 ||
					lastSegmentLength !== 2 ||
					res[res.length - 1] !== '.' ||
					res[res.length - 2] !== '.'
				) {
					if (res.length > 2) {
						const lastSlashIndex = res.lastIndexOf('/');
						if (lastSlashIndex === -1) {
							res = '';
							lastSegmentLength = 0;
						} else {
							res = res.slice(0, lastSlashIndex);
							lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
						}
						lastSlash = i;
						dots = 0;
						continue;
					} else if (res.length !== 0) {
						res = '';
						lastSegmentLength = 0;
						lastSlash = i;
						dots = 0;
						continue;
					}
				}
				if (allowAboveRoot) {
					res += res.length > 0 ? '/..' : '..';
					lastSegmentLength = 2;
				}
			} else {
				if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
				else res = path.slice(lastSlash + 1, i);
				lastSegmentLength = i - lastSlash - 1;
			}
			lastSlash = i;
			dots = 0;
		} else if (code === '.' && dots !== -1) {
			++dots;
		} else {
			dots = -1;
		}
	}
	return res;
};

export const sep = '/';
export const delimiter = ':';

export const resolve = (...args) => {
	let resolvedPath = '';
	let resolvedAbsolute = false;
	for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
		const path = i >= 0 ? args[i] : cwd();
		validateString(path, `paths[${i}]`);
		if (path.length === 0) continue;
		resolvedPath = `${path}/${resolvedPath}`;
		resolvedAbsolute = path[0] === '/';
	}

	resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
	if (resolvedAbsolute) return `/${resolvedPath}`;
	return resolvedPath.length > 0 ? resolvedPath : '.';
};

export const normalize = (path) => {
	validateString(path, 'path');
	if (path.length === 0) return '.';

	const absolute = path[0] === '/';
	const trailingSeparator = path[path.length - 1] === '/';
	path = normalizeString(path, !absolute);
	if (path.length === 0) {
		if (absolute) return '/';
		return trailingSeparator ? './' : '.';
	}
	if (trailingSeparator) path += '/';
	return absolute ? `/${path}` : path;
};

export const isAbsolute = (path) => {
	validateString(path, 'path');
	return path.length > 0 && path[0] === '/';
};

export const join = (...args) => {
	if (args.length === 0) return '.';
	let joined;
	for (let i = 0; i < args.length; ++i) {
		const arg = args[i];
		validateString(arg, 'path');
		if (arg.length > 0) joined = joined === undefined ? arg : `${joined}/${arg}`;
	}
	if (joined === undefined) return '.';
	return normalize(joined);
};

export const relative = (from, to) => {
	validateString(from, 'from');
	validateString(to, 'to');
	if (from === to) return '';

	from = resolve(from);
	to = resolve(to);
	if (from === to) return '';

	const fromStart = 1;
	const fromEnd = from.length;
	const fromLen = fromEnd - fromStart;
	const toStart = 1;
	const toLen = to.length - toStart;

	// the longest common leading path
	const length = fromLen < toLen ? fromLen : toLen;
	let lastCommonSep = -1;
	let i = 0;
	for (; i < length; i++) {
		const fromCode = from[fromStart + i];
		if (fromCode !== to[toStart + i]) break;
		else if (fromCode === '/') lastCommonSep = i;
	}
	if (i === length) {
		if (toLen > length) {
			// from is a prefix of to: /foo/bar to /foo/bar/baz is baz
			if (to[toStart + i] === '/') return to.slice(toStart + i + 1);
			// from is the root: / to /foo is foo
			if (i === 0) return to.slice(toStart + i);
		} else if (fromLen > length) {
			if (from[fromStart + i] === '/') lastCommonSep = i;
			else if (i === 0) lastCommonSep = 0;
		}
	}

	let out = '';
	// a .. for each segment of from after the common part
	for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
		if (i === fromEnd || from[i] === '/') out += out.length === 0 ? '..' : '/..';
	}
	return `${out}${to.slice(toStart + lastCommonSep)}`;
};

export const toNamespacedPath = (path) => path;

export const dirname = (path) => {
	validateString(path, 'path');
	if (path.length === 0) return '.';

	const hasRoot = path[0] === '/';
	let end = -1;
	let matchedSlash = true;
	for (let i = path.length - 1; i >= 1; --i) {
		if (path[i] === '/') {
			if (!matchedSlash) {
				end = i;
				break;
			}
		} else {
			matchedSlash = false;
		}
	}

	if (end === -1) return hasRoot ? '/' : '.';
	if (hasRoot && end === 1) return '//';
	return path.slice(0, end);
};

export const basename = (path, suffix) => {
	if (suffix !== undefined) validateString(suffix, 'suffix');
	validateString(path, 'path');

	let start = 0;
	let end = -1;
	let matchedSlash = true;

	if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
		if (suffix === path) return '';
		let extIdx = suffix.length - 1;
		let firstNonSlashEnd = -1;
		for (let i = path.length - 1; i >= 0; --i) {
			const code = path[i];
			if (code === '/') {
				if (!matchedSlash) {
					start = i + 1;
					break;
				}
			} else {
				if (firstNonSlashEnd === -1) {
					matchedSlash = false;
					firstNonSlashEnd = i + 1;
				}
				if (extIdx >= 0) {
					if (code === suffix[extIdx]) {
						if (--extIdx === -1) end = i;
					} else {
						extIdx = -1;
						end = firstNonSlashEnd;
					}
				}
			}
		}

		if (start === end) end = firstNonSlashEnd;
		else if (end === -1) end = path.length;
		return path.slice(start, end);
	}

	for (let i = path.length - 1; i >= 0; --i) {
		if (path[i] === '/') {
			if (!matchedSlash) {
				start = i + 1;
				break;
			}
		} else if (end === -1) {
			matchedSlash = false;
			end = i + 1;
		}
	}

	if (end === -1) return '';
	return path.slice(start, end);
};

export const extname = (path) => {
	validateString(path, 'path');
	let startDot = -1;
	let startPart = 0;
	let end = -1;
	let matchedSlash = true;
	// 0: no dot yet, 1: a dot after other characters, -1: characters after the dot
	let preDotState = 0;
	for (let i = path.length - 1; i >= 0; --i) {
		const code = path[i];
		if (code === '/') {
			if (!matchedSlash) {
				startPart = i + 1;
				break;
			}
			continue;
		}
		if (end === -1) {
			matchedSlash = false;
			end = i + 1;
		}
		if (code === '.') {
			if (startDot === -1) startDot = i;
			else if (preDotState !== 1) preDotState = 1;
		} else if (startDot !== -1) {
			preDotState = -1;
		}
	}

	if (
		startDot === -1 ||
		end === -1 ||
		preDotState === 0 ||
		(preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
	)
		return '';
	return path.slice(startDot, end);
};

export const parse = (path) => {
	validateString(path, 'path');
	const ret = { root: '', dir: '', base: '', ext: '', name: '' };
	if (path.length === 0) return ret;

	const absolute = path[0] === '/';
	let start = 0;
	if (absolute) {
		ret.root = '/';
		start = 1;
	}

	let startDot = -1;
	let startPart = 0;
	let end = -1;
	let matchedSlash = true;
	let preDotState = 0;
	for (let i = path.length - 1; i >= start; --i) {
		const code = path[i];
		if (code === '/') {
			if (!matchedSlash) {
				startPart = i + 1;
				break;
			}
			continue;
		}
		if (end === -1) {
			matchedSlash = false;
			end = i + 1;
		}
		if (code === '.') {
			if (startDot === -1) startDot = i;
			else if (preDotState !== 1) preDotState = 1;
		} else if (startDot !== -1) {
			preDotState = -1;
		}
	}

	if (end !== -1) {
		const from = startPart === 0 && absolute ? 1 : startPart;
		if (
			startDot === -1 ||
			preDotState === 0 ||
			(preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
		) {
			ret.base = ret.name = path.slice(from, end);
		} else {
			ret.name = path.slice(from, startDot);
			ret.base = path.slice(from, end);
			ret.ext = path.slice(startDot, end);
		}
	}

	if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
	else if (absolute) ret.dir = '/';
	return ret;
};

export const format = (pathObject) => {
	if (pathObject === null || typeof pathObject !== 'object') {
		const e = new TypeError(
			`The "pathObject" argument must be of type object. Received ${pathObject === null ? 'null' : typeof pathObject}`
		);
		e.code = 'ERR_INVALID_ARG_TYPE';
		throw e;
	}
	const dir = pathObject.dir || pathObject.root;
	const ext = pathObject.ext
		? pathObject.ext[0] === '.'
			? pathObject.ext
			: `.${pathObject.ext}`
		: '';
	const base = pathObject.base || `${pathObject.name || ''}${ext}`;
	if (!dir) return base;
	return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`;
};

const path = {
	sep,
	delimiter,
	resolve,
	normalize,
	isAbsolute,
	join,
	relative,
	toNamespacedPath,
	dirname,
	basename,
	extname,
	parse,
	format
};
path.posix = path;

export const posix = path;
export default path;
