#!/usr/bin/env node
// Runs web-platform-tests (wpt/wpt, a sparse checkout: `node wpt/setup.mjs`) against
// wasi-porffor's Web API shims, the way Porffor's test262/ runs test262: each test compiled
// natively (Porffor to C, run by tcc -run, or cc without tcc), in parallel, and the results
// compared with the last run's (wpt/results.json).
//
//   node wpt/index.mjs [dir or file] [--threads=N] [--files=list.json] [--log-errors] [--no-save]
//
// Each test is a program (wpt/guest.mjs): testharness.js, the META scripts, the test and an
// event loop, bundled with runtime/'s shims as a component's guest is (scripts/bundle.mjs). A test
// passes when the harness finished and every subtest passed. Threads come from --threads or
// wpt/.threads. Porffor is the one PORFFOR_CLI names (default: this checkout's cli/).

import cluster from 'node:cluster';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { guestSource } from './guest.mjs';
import { DIRECTORIES, readTests } from './read.mjs';

const here = import.meta.dirname;
const root = join(here, 'wpt');
const resultsPath = join(here, 'results.json');
const diffPath = join(here, 'diff.json');
const TIMEOUT = 10_000;
const LONG_TIMEOUT = 60_000;
// the most tests compiled by cc at once, without tcc (see primary)
const CC_THREADS = 3;
const CATEGORIES = [
	'passes',
	'fails',
	'runtimeErrors',
	'nativeErrors',
	'compileErrors',
	'timeouts'
];
const LABELS = [
	'pass',
	'fail',
	'runtime error',
	'native compile error',
	'compile error',
	'timeout'
];

const argv = process.argv.slice(2);
/** A line to standard output (the report). */
const print = (text) => process.stdout.write(`${text}\n`);
const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

if (cluster.isPrimary) {
	// Porffor's package is untyped ESM: Node warns about it once per worker
	cluster.setupPrimary({
		execArgv: [...process.execArgv, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
	});
	await primary();
} else await worker();

/** The test-picking, scheduling and reporting side. */
async function primary() {
	if (!existsSync(join(root, 'resources/testharness.js'))) {
		console.error('wpt: no checkout at wpt/wpt: run `node wpt/setup.mjs` first');
		process.exit(1);
	}
	const filesArg = flag('files');
	const tests = readTests(root, {
		filter: argv.find((arg) => !arg.startsWith('-')) ?? '',
		files: filesArg ? JSON.parse(readFileSync(filesArg, 'utf8')) : undefined
	});

	if (tests.length === 0) {
		console.error('wpt: no tests match');
		process.exit(1);
	}
	const logErrors = argv.includes('--log-errors') || tests.length === 1;
	const threadFile = join(here, '.threads');
	const threads = logErrors
		? 1
		: Number(flag('threads') ?? (existsSync(threadFile) ? readFileSync(threadFile, 'utf8') : 4));

	// cc on Porffor's C takes a gigabyte or more a test, where tcc takes little: many at once
	// exhausted a 61 GB machine (the OOM killer took its desktop session down)
	if (findTcc() === null && threads > CC_THREADS) {
		console.error(
			`wpt: no tcc (PATH, TCC or PORFFOR_TEST262_TCC): cc runs at most ${CC_THREADS} threads, not ${threads}`
		);
		process.exit(1);
	}
	const last = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
	const results = Object.fromEntries(CATEGORIES.map((category) => [category, []]));
	const subtests = {};
	const started = performance.now();
	let next = 0;
	let finished = 0;

	await new Promise((done) => {
		const give = (child) => {
			if (next < tests.length) child.send({ test: tests[next++], logErrors });
			else child.kill();
		};

		for (let slot = 0; slot < Math.min(threads, tests.length); slot++) {
			const child = cluster.fork({ WPT_SLOT: String(slot), WPT_RUN: String(process.pid) });

			child.on('message', (message) => {
				if (message.ready) return give(child);

				results[message.category].push(message.id);
				subtests[message.id] = message.subtests;

				if (logErrors && message.log) print(message.log);
				finished++;

				if (!logErrors)
					process.stdout.write(
						`\r\u001b[2K${finished}/${tests.length} ${message.id}`.slice(0, 160)
					);

				if (finished === tests.length) done();
				else give(child);
			});
		}
	});

	for (const category of CATEGORIES) results[category].sort();

	report(tests, results, subtests, last, performance.now() - started);
	process.exit(0);
}

/** Prints the totals (with the change since the last run) and each directory's. */
function report(tests, results, subtests, last, elapsed) {
	const ran = new Set(tests.map((test) => test.id));
	const counts = CATEGORIES.map((category) => results[category].length);
	// the last run's counts over the same tests, which a partial run is compared with
	const lastCounts = CATEGORIES.map(
		(category) => (last[category] ?? []).filter((id) => ran.has(id)).length
	);
	const change = (index) => {
		const delta = counts[index] - lastCounts[index];

		return lastCounts.some(Boolean) && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
	};
	const [subPass, subTotal] = Object.values(subtests).reduce(
		(sum, [pass, total]) => [sum[0] + pass, sum[1] + total],
		[0, 0]
	);

	process.stdout.write('\r\u001b[2K');
	print(
		`wpt: ${tests.length} tests, ${((counts[0] / tests.length) * 100).toFixed(2)}% passing | ` +
			LABELS.map((label, index) => `${label} ${counts[index]}${change(index)}`).join(' | ') +
			` | subtests ${subPass}/${subTotal} (${(elapsed / 1000).toFixed(1)}s)`
	);

	for (const directory of DIRECTORIES) {
		const ids = tests.filter((test) => test.id.startsWith(`${directory}/`)).map((test) => test.id);

		if (ids.length === 0) continue;
		const passing = ids.filter((id) => results.passes.includes(id)).length;

		print(`  ${directory.padEnd(34)} ${String(passing).padStart(4)}/${ids.length}`);
	}

	// a run of part of the suite keeps the rest of the last results
	const whole = { ...last, subtests: { ...last.subtests, ...subtests } };

	for (const category of CATEGORIES)
		whole[category] = [
			...(last[category] ?? []).filter((id) => !ran.has(id)),
			...results[category]
		].sort();
	const lastPasses = new Set(last.passes ?? []);
	const diff = {
		newPasses: results.passes.filter((id) => !lastPasses.has(id)),
		newFailures: [...ran].filter((id) => lastPasses.has(id) && !results.passes.includes(id))
	};

	if (diff.newPasses.length > 0) print(`\nnow passing:\n  ${diff.newPasses.join('\n  ')}`);

	if (diff.newFailures.length > 0)
		print(`\nno longer passing:\n  ${diff.newFailures.join('\n  ')}`);
	// --no-save: a look at part of the suite that leaves the recorded results alone (runs side
	// by side would each write theirs over the others')
	if (!argv.includes('--no-save')) {
		writeFileSync(resultsPath, JSON.stringify(whole));
		writeFileSync(diffPath, JSON.stringify(diff, null, 2));
	}
	// this run's work directories (another run's may be in use)
	for (const dir of existsSync(join(here, '.work')) ? readdirSync(join(here, '.work')) : [])
		if (dir.startsWith(`${process.pid}-`))
			rmSync(join(here, '.work', dir), { recursive: true, force: true });
}

/** The compiling and running side: one test at a time, as the primary hands them out. */
async function worker() {
	const porffor = resolve(process.env.PORFFOR_CLI ?? join(here, '../../cli/index.js'));
	const compiler = join(dirname(porffor), '../compiler');

	await import(join(compiler, 'prefs.js'));
	const parse = (await import(join(compiler, 'parse.js'))).default;
	const codegen = (await import(join(compiler, 'codegen.js'))).default;
	const render = (await import(join(compiler, 'render.js'))).default;

	globalThis.pageSize = globalThis.Prefs.pageSize ?? 65536 / 4;
	// (a run's own: runs side by side do not share a directory)
	const work = join(here, '.work', `${process.env.WPT_RUN}-w${process.env.WPT_SLOT}`);
	const tcc = findTcc();

	rmSync(work, { recursive: true, force: true });
	mkdirSync(join(work, 'js'), { recursive: true });
	// what scripts/bundle.mjs reads from a build's work directory: the host's clock and
	// async runtime are native-loop.mjs, and the entry runs the program
	const loop = join(here, 'native-loop.mjs');

	writeFileSync(
		join(work, 'aliases.json'),
		JSON.stringify({
			'wasi:clocks/monotonic-clock@0.3.0': loop,
			'rt-async': loop,
			'wpt-native-loop': loop
		})
	);
	writeFileSync(join(work, 'features.json'), '{}');
	writeFileSync(join(work, 'js/entry.mjs'), "import 'rt-guest';\n");

	const compile = (test) => {
		writeFileSync(join(work, 'guest.mjs'), guestSource(root, test));
		execFileSync(
			process.execPath,
			[join(here, '../scripts/bundle.mjs'), work, join(work, 'guest.mjs')],
			{
				stdio: 'pipe'
			}
		);
		globalThis.Prefs.module = true;
		globalThis.file = join(root, test.file);
		const generated = codegen(parse(readFileSync(join(work, 'entry.js'), 'utf8'), {}));
		const out = render({ ...generated, prefs: { ...generated.prefs, d: true } });

		return typeof out === 'string' ? out : out.c;
	};

	process.on('message', async ({ test, logErrors }) => {
		let source;

		try {
			source = compile(test);
		} catch (error) {
			const text = String(error.stderr ?? error.stack ?? error).trim();

			process.send(outcome(test, 'compileErrors', [0, 0], logErrors ? text : ''));
			return;
		}
		writeFileSync(join(work, 'program.c'), source);
		const res = await runNative(tcc, work, test.long ? LONG_TIMEOUT : TIMEOUT);

		process.send(classify(test, res, logErrors));
	});
	process.send({ ready: true });
}

const outcome = (test, category, subtests, log) => ({ id: test.id, category, subtests, log });

const STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];

/** A finished run's category, subtest counts and (for --log-errors) what went wrong. */
function classify(test, res, logErrors) {
	if (res.timedOut) return outcome(test, 'timeouts', [0, 0], logErrors ? res.stderr : '');
	const line = res.stdout.split('\n').find((text) => text.startsWith('WPT_RESULT '));

	if (!line) {
		const category = /: error:|^tcc: error/m.test(res.stderr) ? 'nativeErrors' : 'runtimeErrors';

		return outcome(test, category, [0, 0], logErrors ? res.stderr.trim().slice(-4000) : '');
	}
	const result = JSON.parse(line.slice('WPT_RESULT '.length));
	const passed = result.tests.filter((sub) => sub.status === 0).length;
	const counts = [passed, result.tests.length];
	const log = logErrors
		? [
				`harness: ${['OK', `ERROR ${result.message ?? ''}`, 'TIMEOUT (a test never finished)', 'PRECONDITION_FAILED'][result.status] ?? 'did not finish'}`,
				...result.errors.map((error) => `error in a job: ${error}`),
				...result.tests.map(
					(sub) =>
						`  ${STATUS[sub.status] ?? 'PENDING'} ${sub.name}${sub.message ? `: ${sub.message}` : ''}`
				)
			].join('\n')
		: '';

	// the harness timed out (a test never finished): a timeout, with what did finish
	if (result.status === 2) return outcome(test, 'timeouts', counts, log);

	if (result.status !== 0) return outcome(test, 'runtimeErrors', counts, log);

	return outcome(test, passed === counts[1] && passed > 0 ? 'passes' : 'fails', counts, log);
}

/** tcc (PORFFOR_TEST262_TCC, TCC, or on the PATH), or null. */
function findTcc() {
	for (const candidate of [process.env.PORFFOR_TEST262_TCC, process.env.TCC, 'tcc'].filter(
		Boolean
	)) {
		try {
			execFileSync(candidate, ['-v'], { stdio: 'ignore' });

			return candidate;
		} catch {
			// not this one
		}
	}

	return null;
}

const run = promisify(execFile);

/** Runs the C in work/program.c: tcc -run, or cc to a binary and that. */
async function runNative(tcc, work, timeout) {
	const source = join(work, 'program.c');
	const darwin = process.platform === 'darwin' ? ['-D_XOPEN_SOURCE=600', '-D_DARWIN_C_SOURCE'] : [];
	const exec = async (command, args) => {
		try {
			const { stdout, stderr } = await run(command, args, {
				timeout,
				killSignal: 'SIGKILL',
				maxBuffer: 1 << 26
			});

			return { stdout, stderr, status: 0 };
		} catch (error) {
			return {
				stdout: String(error.stdout ?? ''),
				stderr: String(error.stderr ?? error.message),
				status: error.code ?? 1,
				timedOut: error.killed === true && error.signal === 'SIGKILL'
			};
		}
	};

	if (tcc) return exec(tcc, ['-w', '-lm', ...darwin, '-run', source]);
	const binary = join(work, 'program');
	const built = await exec('cc', ['-O0', '-w', '-xc', source, '-o', binary, '-lm']);

	return built.status === 0 ? exec(binary, []) : built;
}
