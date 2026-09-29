// Finds the web-platform-tests this runner runs: the `.any.js` tests under DIRECTORIES of the
// checkout (wpt/wpt), each with what its `// META:` lines say, one test per variant.
// https://web-platform-tests.org/writing-tests/testharness.html#tests-for-other-or-multiple-globals-any-js

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** The WPT directories run: the Web APIs runtime/ provides, or will. */
export const DIRECTORIES = [
	'url',
	'encoding',
	'WebCryptoAPI',
	'FileAPI',
	'fetch/api',
	'streams',
	'dom/abort',
	'dom/events',
	'html/webappapis/structured-clone',
	'html/webappapis/timers',
	'hr-time',
	'console',
	'xhr/formdata',
	'compression'
];

/** The directories `git sparse-checkout` needs: DIRECTORIES, the shared helpers, the IDL. */
export const CHECKOUT = ['resources', 'common', 'interfaces', ...DIRECTORIES];

// the globals a component is closest to: a worker, or a plain JavaScript shell. A test for
// the window alone needs a document
const RUNNABLE_GLOBALS = new Set([
	'worker',
	'dedicatedworker',
	'dedicatedworker-module',
	'shadowrealm',
	'shadowrealm-in-window',
	'jsshell'
]);
// what a test without a `global` line runs in
const DEFAULT_GLOBALS = ['window', 'dedicatedworker'];

/**
 * @typedef {object} WptTest
 * @property {string} id the test's name in results: its path from the checkout, plus variant
 * @property {string} file the path from the checkout
 * @property {string} variant the query string it runs with ('' or '?…')
 * @property {string[]} scripts the helper scripts before it, as paths from the checkout
 * @property {boolean} long whether it asked for the long timeout
 * @property {string} title its META title, if any
 */

/** Every `.any.js` file under a directory, as paths from the checkout (helpers left out). */
function anyFiles(root, directory) {
	const out = [];
	const walk = (relative) => {
		const entries = readdirSync(join(root, relative), { withFileTypes: true });

		for (const entry of entries) {
			const path = posix.join(relative, entry.name);

			if (entry.isDirectory()) {
				// helpers and data, never tests
				if (entry.name !== 'resources' && entry.name !== 'support') walk(path);
			} else if (entry.name.endsWith('.any.js')) out.push(path);
		}
	};

	if (existsSync(join(root, directory))) walk(directory);

	return out.sort();
}

/** A test file's META lines, as [key, value] pairs in order. */
export function metaLines(source) {
	const out = [];

	for (const line of source.split('\n')) {
		const match = /^\/\/ META: ?([a-z_]+)=(.*)$/.exec(line.trim());

		if (match) out.push([match[1], match[2].trim()]);
		else if (line.trim() !== '' && !line.startsWith('//')) break;
	}

	return out;
}

// paths WPT's server answers from another file (tools/serve): the WebIDL parser idlharness.js
// loads is the webidl2 package's build
const SERVER_ROUTES = { 'resources/WebIDLParser.js': 'resources/webidl2/lib/webidl2.js' };

/** A META script path as a path from the checkout ('/common/x.js', or relative to the test). */
export function checkoutPath(file, reference) {
	const path = reference.split('?')[0];
	const resolved = path.startsWith('/')
		? path.slice(1)
		: posix.normalize(posix.join(posix.dirname(file), path));

	return SERVER_ROUTES[resolved] ?? resolved;
}

/**
 * The tests under the checkout at root: all of DIRECTORIES, or those whose id starts with
 * filter (a directory or one file), or exactly the ids in files.
 * @param {string} root
 * @param {{ filter?: string, files?: string[] }} [select]
 * @returns {WptTest[]}
 */
export function readTests(root, select = {}) {
	const wanted = select.files ? new Set(select.files) : null;
	const filter = (select.filter ?? '').replace(/\/+$/, '');
	const tests = [];

	for (const directory of DIRECTORIES) {
		for (const file of anyFiles(root, directory)) {
			const meta = metaLines(readFileSync(join(root, file), 'utf8'));
			const globals = meta
				.filter(([key]) => key === 'global')
				.flatMap(([, value]) => value.split(','))
				.map((name) => name.trim());

			if (
				!(globals.length > 0 ? globals : DEFAULT_GLOBALS).some((name) => RUNNABLE_GLOBALS.has(name))
			)
				continue;
			const variants = meta.filter(([key]) => key === 'variant').map(([, value]) => value);

			for (const variant of variants.length > 0 ? variants : ['']) {
				const id = file + variant;

				if (wanted ? !wanted.has(id) : !(id.startsWith(filter) || filter === '')) continue;

				tests.push({
					id,
					file,
					variant,
					scripts: meta
						.filter(([key]) => key === 'script')
						.map(([, value]) => checkoutPath(file, value)),
					long: meta.some(([key, value]) => key === 'timeout' && value === 'long'),
					title: meta.find(([key]) => key === 'title')?.[1] ?? ''
				});
			}
		}
	}

	return tests;
}
