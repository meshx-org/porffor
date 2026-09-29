// Coroutines, end to end: every case of coroutines/cases.mjs (async functions, generators,
// async generators, and closing them) runs in the component, as stackless step functions
// under callback-lifted exports (no thread), and must see what it sees in Node.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { beforeAll, describe, expect, test } from 'vitest';
import { cases } from './coroutines/cases.mjs';
import { buildFixture, invoke, missing, usesCallbacks } from './harness.mjs';

// What the build gets wrong today, and why. Such a case is expected to fail: when a fix
// makes it pass, the test fails, and the case comes off this list.
const KNOWN_GAPS = {
	promiseTicks:
		'an await of a settled promise takes no tick, and awaiting skips the constructor lookup',
	closeOnThrow: 'a throw out of for...of does not close a generator on the fast path'
};

const unavailable = missing();

if (unavailable !== null) console.warn(`coroutines test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
describe.skipIf(unavailable !== null)('coroutines', () => {
	let component = '';

	beforeAll(() => {
		component = buildFixture('coroutines', 'coroutines');
	}, 600_000);

	// what the case sees in the component, and in Node
	const outcomes = async (name) => [await invoke(component, `run("${name}")`), await cases[name]()];

	test('every coroutine is stackless: exports lifted with a callback, no thread', () => {
		expect(usesCallbacks(component)).toBe(true);
	});

	for (const name of Object.keys(cases)) {
		const gap = KNOWN_GAPS[name];

		if (gap === undefined)
			test(`${name}`, { timeout: 120_000 }, async () => {
				const [actual, expected] = await outcomes(name);

				expect(actual).toBe(expected);
			});
		else
			test.fails(`${name} (known gap: ${gap})`, { timeout: 120_000 }, async () => {
				const [actual, expected] = await outcomes(name);

				expect(actual).toBe(expected);
			});
	}
});
