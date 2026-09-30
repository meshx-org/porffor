// js/entry.mjs (the glue) + the guest bundle -> one flat script for Porffor (entry.js).
//   node bundle.mjs <work-dir> <guest-bundle.js>   (build-component.mjs runs it)
//
// Web globals Porffor lacks come from runtime/, injected (esbuild `inject`): a bare `URL` in the
// guest resolves to runtime/url.mjs, and what a guest never names is tree-shaken away. Code
// that reaches a global through `globalThis` (`globalThis.URL`, `typeof globalThis.fetch`)
// is not something injection rewrites, so a first pass finds those names, and the ones
// runtime/ provides are installed on globalThis before any guest code runs.
import { build } from 'esbuild';
import parse from '../../compiler/parser/index.js';
import { analyzeSelectors, selectedFiles } from '../../compiler/selectors.js';
import fs from 'node:fs';
import path from 'node:path';
const [outDir, guest] = process.argv.slice(2);
const aliases = JSON.parse(fs.readFileSync(path.join(outDir, 'aliases.json'), 'utf8'));
const features = JSON.parse(fs.readFileSync(path.join(outDir, 'features.json'), 'utf8'));
const lib = (name) => path.resolve(import.meta.dirname, '../../runtime', name);
/** The modules in a directory of runtime/, its subdirectories' too: `timers/promises`. */
const runtimeModules = (dir) =>
	fs
		.readdirSync(lib(dir), { recursive: true })
		.filter((file) => file.endsWith('.mjs'))
		.map((file) => file.slice(0, -'.mjs'.length).split(path.sep).join('/'));
const hasClock = aliases['wasi:clocks/monotonic-clock@0.3.0'] !== undefined;
const hasHttp = aliases['wasi:http/client@0.3.0'] !== undefined;
const hasEnvironment = aliases['wasi:cli/environment@0.3.0'] !== undefined;
// meshx:intl whole (include meshx:intl/imports@0.1.0): runtime/intl.mjs imports every interface
const hasIntl = ['locale', 'time-zone', 'date-time', 'number', 'plural', 'list', 'text'].every(
	(name) => aliases[`meshx:intl/${name}@0.1.0`] !== undefined
);

// The guest's own code and its imports, bundled without the providers (a provider would name
// what it provides itself), the world's imports and the build's other aliases left out: what
// it names decides which globals it gets (a provider's trigger, runtime/globals.json).
const guestOnly = await build({
	entryPoints: [path.resolve(guest)],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	write: false,
	metafile: true,
	logLevel: 'silent',
	plugins: [
		{
			name: 'world-imports',
			setup(pluginBuild) {
				pluginBuild.onResolve({ filter: /^[a-z][a-z0-9-]*:/ }, (args) => ({
					path: args.path,
					external: true
				}));
				pluginBuild.onResolve({ filter: /^[\w@-]/ }, (args) =>
					args.path in aliases ? { path: args.path, external: true } : undefined
				);
			}
		}
	]
});
// Whether it calls `.normalize(`: only then is String.prototype.normalize (which Porffor
// lacks) installed, ahead of the guest's code (runtime/string-normalize.mjs; ASCII only for now)
const usesNormalize = /\.normalize\s*\(/.test(guestOnly.outputFiles[0].text);
// Whether it imports @noble/hashes' scrypt (better-auth hashes passwords with it): only then
// is that module pointed at runtime/scrypt.mjs, over Colin Percival's C (runtime/c/scrypt, through
// porffor:scrypt), and the C compiled in (natives.json, which src/build.mjs reads)
const NOBLE_SCRYPT = /[\\/]@noble[\\/]hashes[\\/](?:esm[\\/])?scrypt\.js$/;
// (or node:crypto's scrypt: Node's modules are left out of that pass, so by name)
const usesScrypt =
	Object.keys(guestOnly.metafile.inputs).some((input) => NOBLE_SCRYPT.test(input)) ||
	(/\bscrypt(?:Sync)?\b/.test(guestOnly.outputFiles[0].text) &&
		/['"](?:node:)?crypto['"]/.test(guestOnly.outputFiles[0].text));

fs.writeFileSync(path.join(outDir, 'natives.json'), JSON.stringify({ scrypt: usesScrypt }));

// What runtime/ provides as globals (runtime/globals.json, which a native build reads too): those
// this world can back (a clock to wait on, outgoing HTTP, meshx:intl, async functions to yield
// in), each only when the guest names it
const capabilities = { clock: hasClock, http: hasHttp, intl: hasIntl, async: features.async };
const guestText = guestOnly.outputFiles[0].text;
const names = (word) => new RegExp(`\\b${word}\\b`).test(guestText);
// (only providers the guest names: esbuild keeps an injected file that has side effects, as
// node:process's does, even when nothing uses it)
const manifest = JSON.parse(fs.readFileSync(lib('globals.json'), 'utf8'));
// the variants the guest's selector values choose (compiler/selectors.js, as a native build
// does): every one of a selector passed a value the analysis cannot see
// (a guest the parser cannot read is all dynamic)
let analysis;
try {
	analysis = analyzeSelectors([parse(guestText, { module: true })], manifest);
} catch {
	analysis = {
		values: new Map(),
		dynamic: new Map(Object.keys(manifest.selectors).map((name) => [name, []]))
	};
}
const selected = selectedFiles(manifest, analysis);
const PROVIDERS = manifest.providers.filter(
	(provider) =>
		(provider.needs === undefined || capabilities[provider.needs]) &&
		(provider.trigger === undefined || provider.trigger.some(names)) &&
		(provider.names.some(names) ||
			selected.has(provider.file) ||
			(provider.load !== undefined && new RegExp(provider.load).test(guestText)))
);

// The providers as one injected module (js/providers.mjs): their globals re-exported, the ones the
// program reaches through the global object installed on it (as the platform's own are: writable,
// configurable, not enumerable), and those only loaded for what they do on loading imported. One
// module, not each provider injected: esbuild runs injected files before what they import, and a
// provider that uses another module while loading (node:process, TextDecoder) would find it unset
function writeProviders(installs) {
	const file = path.join(outDir, 'js', 'providers.mjs');
	const lines = ["// The runtime's globals for this program (generated by bundle.mjs)."];

	for (const provider of PROVIDERS) {
		const used = provider.names.filter(names);

		lines.push(
			used.length > 0
				? `export { ${used.join(', ')} } from ${JSON.stringify(lib(provider.file))};`
				: `import ${JSON.stringify(lib(provider.file))};`
		);
	}

	for (const { name, file: from } of installs) {
		lines.push(`import { ${name} as ${name}$ } from ${JSON.stringify(lib(from))};`);
		lines.push(
			`Object.defineProperty(globalThis, ${JSON.stringify(name)}, { value: ${name}$, writable: true, configurable: true, enumerable: false });`
		);
	}

	fs.writeFileSync(file, lines.join('\n') + '\n');

	return file;
}

const options = {
	entryPoints: [path.join(outDir, 'js/entry.mjs')],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	alias: {
		...aliases,
		'rt-guest': path.resolve(guest),
		'rt-bridge': path.resolve(outDir, 'js/rt.mjs'),
		// Node's modules, as far as Porffor's runtime provides them (runtime/node): the file
		// system through wasi-libc (wasi:filesystem); child_process throws, WASI has no processes
		...Object.fromEntries(
			runtimeModules('node').flatMap((name) => [
				[`node:${name}`, lib(`node/${name}.mjs`)],
				[name, lib(`node/${name}.mjs`)]
			])
		),
		// the platform layer the runtime is written against: WASI's (runtime/host/wasi, over this
		// build's glue); a native build's is libuv's (runtime/host/native)
		...Object.fromEntries(
			runtimeModules('host/wasi')
				.filter((name) => !name.startsWith('absent/'))
				.map((name) => [`porffor:${name}`, lib(`host/wasi/${name}.mjs`)])
		),
		// what this world cannot do stands in for the platform's (runtime/host/wasi/absent): no
		// clock to wait on, no environment
		...(hasClock ? {} : { 'porffor:clock': lib('host/wasi/absent/clock.mjs') }),
		...(hasEnvironment ? {} : { 'porffor:environment': lib('host/wasi/absent/environment.mjs') })
	},
	inject: [...(usesNormalize ? [lib('string-normalize.mjs')] : []), writeProviders([])],
	target: 'es2022',
	logLevel: 'warning',
	plugins: [
		// A package's "sideEffects": false is not trusted: esbuild drops the init call of a
		// module that is imported statically and also dynamically (it wraps it lazily), so the
		// static import reads its bindings before they are set. better-auth's memory adapter
		// does this. Only packages resolved here are affected: a guest Vite already bundled
		// imports nothing from node_modules.
		{
			name: 'package-side-effects',
			setup(pluginBuild) {
				pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
					if (args.pluginData === 'package-side-effects') return undefined;

					const resolved = await pluginBuild.resolve(args.path, {
						kind: args.kind,
						importer: args.importer,
						resolveDir: args.resolveDir,
						with: args.with,
						pluginData: 'package-side-effects'
					});

					if (resolved.errors.length > 0 || resolved.external) return undefined;

					// @noble/hashes' scrypt, however it is imported: the C one (see usesScrypt)
					if (usesScrypt && NOBLE_SCRYPT.test(resolved.path)) return { path: lib('scrypt.mjs') };

					if (!resolved.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;

					return { ...resolved, sideEffects: true };
				});
			}
		}
	]
};

// A fetch-handler server (the world exports wasi:http/handler): the guest's default export
// ({ fetch }) becomes the handler export, through porffor:http-server (runtime/host/wasi).
if (features.httpHandler) {
	const adapter = path.join(outDir, 'js', 'guest-http.mjs');
	const guestPath = JSON.stringify(path.resolve(guest));

	fs.writeFileSync(
		adapter,
		`// The guest as a wasi:http server (generated by bundle.mjs).\n` +
			`import app from ${guestPath};\nimport { serve } from 'porffor:http-server';\n\n` +
			`export * from ${guestPath};\nexport const handler = serve(app);\n`
	);
	options.alias['rt-guest'] = adapter;
}

// Pass 1: which provided globals the program reaches through the global object.
const first = await build({ ...options, write: false });
const reached = new Set();

// (globalThis.X, self.X, window.X, globalThis['X'], and 'X' in globalThis)
for (const match of first.outputFiles[0].text.matchAll(
	/\b(?:globalThis|self|window)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"])([A-Za-z_$][\w$]*)\2\s*\])|(['"])([A-Za-z_$][\w$]*)\4\s+in\s+(?:globalThis|self|window)\b/g
))
	reached.add(match[1] ?? match[3] ?? match[5]);

// the global object read by a name known only at run time (self[name], globalThis[name]): the
// globals it can find are the ones the program spells as strings
if (/\b(?:globalThis|self|window)\s*\[\s*[^'"\s\]]/.test(first.outputFiles[0].text))
	for (const match of first.outputFiles[0].text.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g))
		reached.add(match[1]);

const installs = PROVIDERS.flatMap((provider) =>
	provider.names.filter((name) => reached.has(name)).map((name) => ({ name, file: provider.file }))
);

// Pass 2: the program, with those globals installed first
writeProviders(installs);
await build({ ...options, outfile: path.join(outDir, 'entry.js') });
console.log(
	'bundled ->',
	path.join(outDir, 'entry.js'),
	installs.length > 0 ? `(on globalThis: ${installs.map(({ name }) => name).join(', ')})` : ''
);
