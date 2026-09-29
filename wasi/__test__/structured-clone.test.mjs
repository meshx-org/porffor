// structuredClone, end to end: the guest (structured-clone/guest.mjs) clones a corpus in a
// P3 component and describes the clones; the description must equal the same guest's on
// Node, whose structuredClone is the engine's own.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';
import { run as native } from './structured-clone/guest.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`structured-clone test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'structuredClone: clones as the engine does',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('structured-clone', 'structured-clone');
		const guest = JSON.parse(await invoke(out, 'run()'));

		expect(guest).toEqual(JSON.parse(native()));
	}
);
