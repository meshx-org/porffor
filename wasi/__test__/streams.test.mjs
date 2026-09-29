// The web streams, end to end: the guest (streams/guest.mjs) is built as a P3 component
// and run in wasmtime.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`streams test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'streams: pipes, transforms, writers, backpressure, errors and aborts',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('streams', 'streams');
		const result = JSON.parse(await invoke(out, 'run()'));

		expect(result.lines).toBe('É⌘ LINE ONE|LINE TWO|THREE');
		expect(result.roundTrip).toBe('a🙂b');
		expect(result.piped).toBe('1,2,3,4,5,6,7,8,9,10');
		// a slow sink holds the source back: never more than a couple of chunks ahead
		expect(result.ahead).toBeLessThanOrEqual(3);
		expect(result.writer).toEqual({
			sunk: 'ab',
			sizes: '2,1,0',
			closedSink: true,
			afterClose: 'TypeError'
		});
		expect(result.failing).toEqual({ pipeError: 'source broke', abortedWith: 'source broke' });
		expect(result.signal).toEqual({ signalled: 'TimeoutError', cancelledWith: 'TimeoutError' });
	}
);
