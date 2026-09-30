// node:module: builtinModules and isBuiltin for the Node modules the runtime provides
// (runtime/node), and createRequire: a require() for ES modules that need one, which returns
// those modules (their default export, as Node's require does). A program is compiled ahead of
// time, so require() of anything else (a file, a package) throws MODULE_NOT_FOUND: import it.
import * as async_hooks from './async_hooks.mjs';
import * as buffer from './buffer.mjs';
import * as child_process from './child_process.mjs';
import * as crypto from './crypto.mjs';
import * as events from './events.mjs';
import * as fs from './fs.mjs';
import * as os from './os.mjs';
import * as path from './path.mjs';
import * as perf_hooks from './perf_hooks.mjs';
import * as process from './process.mjs';
import * as stream from './stream.mjs';
import * as streamPromises from './stream/promises.mjs';
import * as string_decoder from './string_decoder.mjs';
import * as timers from './timers.mjs';
import * as timersPromises from './timers/promises.mjs';
import * as url from './url.mjs';
import * as util from './util.mjs';

// the modules by name; module itself is added below, once `modules` exists
const modules = {
	async_hooks,
	buffer,
	child_process,
	crypto,
	events,
	fs,
	os,
	path,
	perf_hooks,
	process,
	stream,
	'stream/promises': streamPromises,
	string_decoder,
	timers,
	'timers/promises': timersPromises,
	url,
	util
};

/** The names of the Node modules there are (without the node: prefix). */
export const builtinModules = [...Object.keys(modules), 'module'].sort();

const builtinName = (id) => (typeof id === 'string' && id.startsWith('node:') ? id.slice(5) : id);

/** Whether id names a Node module there is ('fs', 'node:fs'). */
export const isBuiltin = (id) => builtinModules.includes(builtinName(id));

const notFound = (id, from) => {
	const e = new Error(
		`Cannot find module '${id}'${from ? ` from '${from}'` : ''}: a Porffor program can require() only Node's modules (${builtinModules.join(', ')}); import anything else`
	);
	e.code = 'MODULE_NOT_FOUND';
	return e;
};

/**
 * A require() as a module at filename would have: Node's modules by name ('fs' or 'node:fs'),
 * each its default export (the namespace for one without).
 * @param {string | URL} filename
 */
export function createRequire(filename) {
	const from = typeof filename === 'string' ? filename : String(filename?.href ?? filename);
	const require = (id) => {
		const name = builtinName(id);
		if (name === 'module') return Module;
		const namespace = Object.prototype.hasOwnProperty.call(modules, name)
			? modules[name]
			: undefined;
		if (namespace === undefined) throw notFound(id, from);
		return namespace.default ?? namespace;
	};
	require.resolve = (id) => {
		if (!isBuiltin(id)) throw notFound(id, from);
		// as it was asked for: 'fs' or 'node:fs'
		return id;
	};
	require.resolve.paths = (id) => (isBuiltin(id) ? null : []);
	require.cache = Object.create(null);
	require.main = undefined;
	require.extensions = Object.create(null);
	return require;
}

/** Node's Module class, as far as code reaches for its statics. */
export function Module(id = '') {
	this.id = id;
	this.exports = {};
	this.children = [];
	this.loaded = false;
}

Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module.createRequire = createRequire;

/** Source maps are not read: stack traces stay as they are. */
export const findSourceMap = () => undefined;
export const syncBuiltinESMExports = () => undefined;
export const register = () => undefined;
export const enableCompileCache = () => ({ status: 0 });

Module.findSourceMap = findSourceMap;
Module.syncBuiltinESMExports = syncBuiltinESMExports;
Module.register = register;
Module.enableCompileCache = enableCompileCache;
Module.Module = Module;

export default Module;
