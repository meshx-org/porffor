// crypto.subtle, end to end: the guest (crypto-subtle/guest.mjs) runs the corpus in a P3
// component and the results must match Node's own Web Crypto over the same corpus.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { runCorpus } from './crypto-subtle/corpus.mjs';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`crypto-subtle test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'crypto.subtle: digests, HMAC and Ed25519 match Node',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('crypto-subtle', 'crypto-subtle');
		const { lines: guest, globals } = JSON.parse(await invoke(out, 'run()'));
		const expected = await runCorpus(globalThis.crypto, globalThis.CryptoKey);
		const differing = expected
			.map((line, index) => ({ index, expected: line, guest: guest[index] }))
			.filter((row) => row.guest !== row.expected);

		expect(guest.length).toBe(expected.length);
		expect(differing).toEqual([]);
		expect(globals).toEqual({ subtle: 'object', same: true });
	}
);
