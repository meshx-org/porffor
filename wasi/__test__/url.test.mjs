// URL and URLSearchParams, end to end: the guest (url/guest.mjs) runs the corpus in a
// P3 component (try/catch needs wasm exception handling) and the results must match
// Node's own URL over the same corpus, line for line.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';
import { runCorpus } from './url/corpus.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`url test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'url: parsing, setters and URLSearchParams match Node; globalThis sees them',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('url', 'url');
		const { lines: guest, globals } = JSON.parse(await invoke(out, 'run()'));
		const expected = runCorpus(globalThis.URL, globalThis.URLSearchParams);
		const differing = expected
			.map((line, index) => ({ index, expected: line, guest: guest[index] }))
			.filter((row) => row.guest !== row.expected);

		expect(guest.length).toBe(expected.length);
		expect(differing.slice(0, 10)).toEqual([]);
		// reached through globalThis: installed before the guest ran, as a platform global is
		expect(globals).toEqual({
			detected: 'function',
			same: true,
			viaBrackets: '2',
			stream: 'function',
			enumerable: false,
			notReached: false
		});
	}
);
