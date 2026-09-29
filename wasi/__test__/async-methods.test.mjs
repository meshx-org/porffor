// Async resource methods as exports, end to end: a provider (async-methods/) exports a
// resource whose `add` and static `twice` are async and wait on a timer, and a caller
// (async-methods-caller/) imports it, awaiting them in turn and at once. wac plugs the two
// together. Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH), wac (WAC, or wac on PATH)
// and the build toolchain.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const wac = process.env.WAC ?? 'wac';

/** Why the test cannot run here, or null. */
function unavailableReason() {
	const reason = missing();

	if (reason !== null) return reason;

	try {
		execFileSync(wac, ['--version'], { stdio: 'ignore' });

		return null;
	} catch {
		return 'wac (set WAC)';
	}
}

const unavailable = unavailableReason();

if (unavailable !== null) console.warn(`async-methods test skipped: ${unavailable}`);

// needs wasmtime 49+, wac and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'async resource methods: awaited in turn and at once, beside sync ones that print and a top-level timer',
	{ timeout: 300_000 },
	async () => {
		const provider = buildFixture('async-methods', 'provider');
		const caller = buildFixture('async-methods-caller', 'caller');
		const composed = join(dirname(caller), 'composed.wasm');

		execFileSync(wac, ['plug', caller, '--plug', provider, '-o', composed], { stdio: 'pipe' });
		const out = JSON.parse(await invoke(composed, 'run()'));

		expect(out).toEqual({ first: 7, second: 10, value: 10, both: [11, 42], fired: 1 });
	}
);
