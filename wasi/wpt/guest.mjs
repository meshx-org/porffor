// One WPT test as a program for Porffor: what WPT's server wraps a `.any.js` test in for a
// worker, as one module. A prelude (self, location, GLOBAL, an offline fetch), testharness.js,
// the names it exposes on the global declared as module bindings, the META scripts, the test,
// then the event loop (native-loop.mjs) run to the end and each subtest's result printed as
// one `WPT_RESULT {json}` line.
//
// The runner bundles it with runtime/'s shims, as a component's guest is, and compiles it to C:
// the timers are runtime/timers.mjs over native-loop.mjs in place of the host's clock.
//
// Everything shares one module scope, as the scripts share a worker's global scope: a helper's
// top-level function is visible to the test. The names testharness.js puts on the global
// object (`test`, `assert_equals`) are declared here too, since Porffor binds a free name at
// compile time, not by looking the global object up at run time.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { checkoutPath } from './read.mjs';

/** The origin tests believe they are served from (WPT's default host). */
export const ORIGIN = 'http://web-platform.test:8000';

// what the prelude declares itself
const PRELUDE_NAMES = ['self', 'location', 'GLOBAL', 'META_TITLE', 'fetch'];

// a resource over this is left for the test to fail on, not inlined into the component
const RESOURCE_LIMIT = 4 * 1024 * 1024;

/** The names testharness.js exposes on the global object, from its expose calls. */
function exposedNames(harness) {
	const names = new Set();

	for (const match of harness.matchAll(/\bexpose(?:_assert)?\([^,]+,\s*["']([\w$]+)["']\)/g))
		names.add(match[1]);

	return [...names].sort();
}

/** The names a source declares at its top level (a line starting with the declaration). */
function topLevelNames(source) {
	const names = new Set();

	for (const match of source.matchAll(
		/^(?:async\s+)?(?:function\*?|var|let|const|class)\s+([A-Za-z_$][\w$]*)/gm
	))
		names.add(match[1]);

	return names;
}

/**
 * The names helper scripts publish on the global object (`self.subsetTest = subsetTest`), less
 * those already declared: a module cannot declare one name twice. Each becomes a binding and
 * an accessor on the global object that reads and writes it, declared before the scripts: a
 * script can publish a name and use it bare right away (`self.IdlArray = function…` then
 * `IdlArray.prototype…`), which reads the global object in a browser.
 */
function publishedNames(sources, declared) {
	const names = new Set();

	for (const source of sources)
		for (const match of source.matchAll(
			// `self.x =`, and a UMD wrapper's `root["x"] =` (called with the global object as root)
			/\b(?:self|globalThis|window|root)(?:\.([A-Za-z_$][\w$]*)|\[["']([A-Za-z_$][\w$]*)["']\])\s*=(?!=)/g
		))
			if (!declared.has(match[1] ?? match[2])) names.add(match[1] ?? match[2]);

	return [...names].sort();
}

/**
 * The global names the code assigns to (`ReadableStream = function () {…}`, patching a global
 * to check that an implementation does not use it), less those declared. A name injected from
 * runtime/ is an import the bundle cannot assign, so the program gets a binding of its own,
 * initialised from the global object.
 */
function patchedGlobals(sources, declared) {
	const names = new Set();

	for (const source of sources)
		for (const match of source.matchAll(
			/(?<![\w$.]|(?:const|let|var)\s+)([A-Z][\w$]*)\s*=(?![=>])/g
		))
			if (!declared.has(match[1])) names.add(match[1]);

	return [...names].sort();
}

/**
 * The names the code tests the global object for (`'subsetTestByKey' in self`): an accessor
 * defined up front would answer yes, so these get a plain binding, copied after the scripts.
 */
function probedNames(sources) {
	const names = new Set();

	for (const source of sources)
		for (const match of source.matchAll(
			/["']([A-Za-z_$][\w$]*)["']\s+in\s+(?:self|globalThis|window)\b/g
		))
			names.add(match[1]);

	return names;
}

/** The declarations before the META scripts for the names they publish (publishedNames). */
function bindingsBefore(published, probed) {
	if (published.length === 0) return '';
	const accessors = published
		.filter((name) => !probed.has(name))
		.map(
			(name) =>
				`Object.defineProperty(self, '${name}', { get: () => ${name}, set: (value) => { ${name} = value; }, configurable: true });`
		);

	return `// --- what the META scripts publish on the global object, as bindings\nvar ${published.join(', ')};\n${accessors.join('\n')}\n`;
}

/**
 * The specs an `idl_test([srcs], [deps], …)` call names: idlharness.js fetches each as
 * /interfaces/<name>.idl, a path it builds at run time.
 */
function idlSpecs(source) {
	const call = /\bidl_test\(\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]/.exec(source);

	return call
		? [...`${call[1]},${call[2]}`.matchAll(/["']([\w.-]+)["']/g)].map((match) => match[1])
		: [];
}

/**
 * The interfaces and namespaces the inlined IDL declares: idlharness.js looks each up on the
 * global object by a computed name, which the bundle cannot see, so the program names them
 * (`globalThis.URL`) and scripts/bundle.mjs puts those runtime/ provides there.
 */
function idlInterfaces(inlined) {
	const names = new Set();

	for (const [url, text] of Object.entries(inlined))
		if (url.endsWith('.idl'))
			for (const match of text.matchAll(
				/^\s*(?:partial\s+)?(?:interface|namespace)\s+(?:mixin\s+)?([A-Za-z_$][\w$]*)/gm
			))
				names.add(match[1]);

	return [...names].sort();
}

/**
 * The files the code fetches by a literal path, relative to the test (as the page would
 * resolve them): URL to contents, for those in the checkout.
 */
function resources(root, file, sources) {
	const out = {};
	const base = new URL(`${ORIGIN}/${file}`);
	const paths = sources.flatMap((source) => [
		...[...source.matchAll(/\bfetch\(\s*(["'`])([^"'`$]+)\1/g)].map((match) => match[2]),
		...idlSpecs(source).map((spec) => `/interfaces/${spec}.idl`)
	]);

	for (const found of paths) {
		const url = new URL(found, base);

		if (url.origin !== ORIGIN) continue;
		const path = join(root, decodeURIComponent(url.pathname.slice(1)));

		if (existsSync(path) && statSync(path).isFile() && statSync(path).size <= RESOURCE_LIMIT)
			out[url.href] = readFileSync(path, 'utf8');
	}

	return out;
}

// WPT's default configuration (tools/wptserve), which a `.sub.` file's placeholders name
const HOST = 'web-platform.test';
const ALT_HOST = 'not-web-platform.test';
const PORTS = { http: [8000, 8001], https: [8443, 8444], ws: [8888], wss: [8889] };

/** A host name with a subdomain ('' for none). */
const subdomain = (name, host) => (name ? `${name}.${host}` : host);

/**
 * A `.sub.` file as WPT's server hands it out, its placeholders filled in: `{{host}}`,
 * `{{domains[www]}}`, `{{hosts[alt][www2]}}`, `{{ports[http][1]}}`. Others stay as written.
 */
export function substitute(path, source) {
	if (!/\.sub\./.test(path)) return source;

	return source.replace(/\{\{([^}]+)\}\}/g, (whole, key) => {
		if (key === 'host') return HOST;
		const domain = /^domains\[([^\]]*)\]$/.exec(key);

		if (domain) return subdomain(domain[1], HOST);
		const host = /^hosts\[([^\]]*)\]\[([^\]]*)\]$/.exec(key);

		if (host) return subdomain(host[2], host[1] === 'alt' ? ALT_HOST : HOST);
		const port = /^ports\[(\w+)\]\[(\d+)\]$/.exec(key);

		return port ? String(PORTS[port[1]]?.[Number(port[2])] ?? whole) : whole;
	});
}

/**
 * The expressions idlharness.js evaluates (`idl_array.add_objects({ Headers: ['new Headers()'] })`),
 * as code: Porffor has no eval of a string known only at run time, so its one `eval(desc)` reads
 * them from a table of functions made at build time.
 */
function idlExpressions(body) {
	const out = new Set();

	for (const call of body.matchAll(/add_objects\(\{([\s\S]*?)\}\s*\)/g))
		for (const literal of call[1].matchAll(/(["'])((?:(?!\1)[^\\]|\\.)*)\1/g)) out.add(literal[2]);

	return [...out];
}

/** A META script as the program includes it: idlharness.js's eval reads the table. */
const patchScript = (path, source) =>
	path === 'resources/idlharness.js'
		? source.replace('obj = eval(desc);', 'obj = WPT_EVAL(desc);')
		: source;

/**
 * A test's guest module source.
 * @param {string} root the WPT checkout
 * @param {import('./read.mjs').WptTest} test
 */
export function guestSource(root, test) {
	const harness = readFileSync(join(root, 'resources/testharness.js'), 'utf8');
	const scripts = test.scripts.map((path) => ({
		path,
		source: patchScript(path, substitute(path, readFileSync(join(root, path), 'utf8')))
	}));
	const body = substitute(test.file, readFileSync(join(root, test.file), 'utf8'));
	const expressions = idlExpressions(body);
	const inlined = resources(root, test.file, [body, ...scripts.map((script) => script.source)]);
	const title = test.title || posix.basename(test.file);
	const idlNames = idlInterfaces(inlined);
	const declared = new Set([
		...PRELUDE_NAMES,
		...exposedNames(harness),
		...[body, ...scripts.map((script) => script.source)].flatMap((source) => [
			...topLevelNames(source)
		])
	]);
	const patched = patchedGlobals([body, ...scripts.map((script) => script.source)], declared);
	const helperSources = scripts.map((script) => script.source);
	const probed = probedNames(helperSources);
	const published = publishedNames(
		scripts.map((script) => script.source),
		declared
	);
	const copiedAfter = published.filter((name) => probed.has(name));
	// a classic script's top-level function is a property of the global object; a module's is
	// not, so those the code reads from it (`globalThis.fetch_spec`) are put there
	const allSources = [body, ...helperSources].join('\n');
	const globalFunctions = helperSources
		.flatMap((source) => [...source.matchAll(/^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm)])
		.map((match) => match[1])
		.filter((name) =>
			new RegExp(`\\b(?:self|globalThis|window)\\.${name.replaceAll('$', '\\$')}\\b`).test(
				allSources
			)
		);

	return `// generated by wasi-porffor's WPT runner (wpt/guest.mjs) for ${test.id}
var self = globalThis;
// a worker's global object names itself (idlharness.js reads self["self"])
self.self = self;
var location = new URL(${JSON.stringify(`${ORIGIN}/${test.file.replace(/\.any\.js$/, '.any.worker.html')}${test.variant}`)});
self.location = location;
var GLOBAL = { isWindow: () => false, isWorker: () => true, isShadowRealm: () => false };
self.GLOBAL = GLOBAL;
var META_TITLE = ${JSON.stringify(title)};
// the expressions idlharness.js evaluates, made at build time (Porffor has no run-time eval)
const WPT_EXPRESSIONS = { ${expressions.map((expr) => `${JSON.stringify(expr)}: () => (${expr})`).join(', ')} };
const WPT_EVAL = (desc) => {
	if (!(desc in WPT_EXPRESSIONS)) throw new SyntaxError('wpt: cannot evaluate ' + desc);
	return WPT_EXPRESSIONS[desc]();
};
${globalFunctions.map((name) => `self.${name} = ${name};`).join('\n')}
${idlNames.length > 0 ? `// the interfaces the test's IDL declares, named so the bundle puts them on the global object\nvoid [${idlNames.map((name) => `globalThis.${name}`).join(', ')}];` : ''}
${patched.map((name) => `var ${name} = globalThis.${name};`).join('\n')}

// resources the test fetches, inlined: a component here has no WPT server to ask
const WPT_RESOURCES = ${JSON.stringify(inlined)};
var fetch = (input, init) => {
	// what fetch does first: the request made (and checked), an aborted signal honoured
	let request;
	try {
		request = new Request(input, init);
	} catch (error) {
		return Promise.reject(error);
	}
	if (request.signal.aborted) return Promise.reject(request.signal.reason);
	const url = request.url;
	if (url.startsWith('data:')) {
		try {
			return Promise.resolve(dataUrlResponse(url));
		} catch (error) {
			return Promise.reject(error);
		}
	}
	if (!(url in WPT_RESOURCES))
		return Promise.reject(new TypeError('wpt: ' + url + ' is not available offline'));
	const type = url.endsWith('.json') ? 'application/json' : 'text/plain';
	return Promise.resolve(new Response(WPT_RESOURCES[url], { headers: { 'content-type': type } }));
};

// --- resources/testharness.js
${harness}
// --- what it exposed on the global object, as bindings
var { ${exposedNames(harness).join(', ')} } = self;

// every test the harness has made, for a report when it never finishes: which are stuck
const WPT_SEEN = new Set();
add_test_state_callback((t) => { WPT_SEEN.add(t); });
const WPT_PHASES = ['INITIAL', 'STARTED', 'HAS_RESULT', 'CLEANING', 'COMPLETE'];

const WPT_DONE = new Promise((resolve) => {
	add_completion_callback((tests, status) => {
		resolve({
			status: status.status,
			message: status.message == null ? null : String(status.message),
			tests: tests.map((t) => ({
				name: String(t.name),
				status: t.status,
				message: t.message == null ? null : String(t.message)
			}))
		});
	});
});

// --- the global is a dedicated worker's, for idlharness.js's exposure checks (a global whose
// prototype is Object.prototype reads as a ShadowRealm's, where little is exposed). Only now,
// after testharness.js chose its (shell) environment
function DedicatedWorkerGlobalScope() {}
Object.setPrototypeOf(self, DedicatedWorkerGlobalScope.prototype);
self.DedicatedWorkerGlobalScope = DedicatedWorkerGlobalScope;

${bindingsBefore(published, probed)}
${scripts.map((script) => `// --- ${script.path} (META script)\n${script.source}\n`).join('\n')}
${copiedAfter.length > 0 ? `// --- names the scripts test for (\`'x' in self\`) before publishing, copied after\n${copiedAfter.map((name) => `${name} = self.${name};`).join('\n')}\n` : ''}
// --- ${checkoutPath(test.file, posix.basename(test.file))}
${body}

// --- the host's part: the event loop, then the result
import { runEventLoop } from 'wpt-native-loop';
// data: URLs the offline fetch answers as fetch does (runtime/data-url.mjs)
import { dataUrlResponse } from ${JSON.stringify(join(import.meta.dirname, '../../runtime/data-url.mjs'))};
let WPT_RESULT = null;
const WPT_ERRORS = [];
WPT_DONE.then((result) => { WPT_RESULT = result; });
const WPT_ON_ERROR = (error) => { WPT_ERRORS.push(String(error?.message ?? error)); };
runEventLoop(WPT_ON_ERROR, () => WPT_RESULT !== null);
// nothing left to run and the harness not done: a test waits on what never happens. A browser's
// harness times out then (its tests TIMEOUT or NOTRUN, the file TIMEOUT); the shell's has no
// timeout, so it is asked to now
if (WPT_RESULT === null) {
	timeout();
	runEventLoop(WPT_ON_ERROR, () => WPT_RESULT !== null);
}
// the harness never finished: each test as far as it got (a pending one's status is null)
const WPT_PARTIAL = () => ({
	status: null,
	tests: [...WPT_SEEN].map((t) => t.phase >= 2
		? { name: String(t.name), status: t.status, message: t.message == null ? null : String(t.message) }
		: { name: String(t.name), status: null, message: 'pending: ' + WPT_PHASES[t.phase] })
});
console.log('WPT_RESULT ' + JSON.stringify({ ...(WPT_RESULT ?? WPT_PARTIAL()), errors: WPT_ERRORS }));
`;
}
