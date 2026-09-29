// setTimeout / setInterval over wasi:clocks 0.3 and User Timing, end to end: the guest
// (timers/guest.mjs) is built as a P3 component and run in wasmtime.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`timers test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'timers: ordering, clearing, intervals and performance marks over wasi:clocks 0.3',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('timers', 'timers');
		const started = Date.now();
		const result = JSON.parse(await invoke(out, 'run()'));
		const wall = Date.now() - started;

		expect(result.order).toBe('early,middle,late');
		expect(result.ticks).toBe(3);
		// 150 ms of timeouts, three 20 ms ticks, a 60 ms sleep, a 150 ms loop
		expect(result.elapsed).toBeGreaterThanOrEqual(370);
		expect(result.measured).toBeGreaterThanOrEqual(370);
		expect(result.measured).toBeLessThanOrEqual(result.elapsed);
		expect(result.entries).toBe('mark:start,measure:run,mark:end');
		expect(result.marks).toBe(2);
		expect(result.scheduler.steps).toBe('micro,immediate,yield');
		expect(result.scheduler.budget).toBeGreaterThan(0);
		expect(result.scheduler.budget).toBeLessThanOrEqual(50);
		// the timer fired while the loop was still spinning: the host got its turns
		expect(result.scheduler.firedAt).toBeGreaterThan(0);
		expect(result.scheduler.firedAt).toBeLessThan(result.scheduler.spins);
		expect(result.abort).toEqual({
			heard: 'listener,onabort',
			reason: 'AbortError',
			timeout: 'TimeoutError',
			any: 'TimeoutError',
			thrown: 'why'
		});
		// the cleared 5 s timeout does not keep run() waiting
		expect(wall).toBeLessThan(4_000);
	}
);
