// Blob and File, end to end: the guest (blob/guest.mjs) runs the corpus in a P3 component
// and the results must match Node's own Blob, File and Response over the same corpus.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { runCorpus } from './blob/corpus.mjs';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`blob test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'blob: Blob, File and Blob bodies match Node',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('blob', 'blob');
		const { lines: guest, detected } = JSON.parse(await invoke(out, 'run()'));
		const expected = await runCorpus(globalThis.Blob, globalThis.File, globalThis.Response);
		const differing = expected
			.map((line, index) => ({ index, expected: line, guest: guest[index] }))
			.filter((row) => row.guest !== row.expected);

		expect(guest.length).toBe(expected.length);
		expect(differing).toEqual([]);
		expect(detected).toBe('function');
	}
);
