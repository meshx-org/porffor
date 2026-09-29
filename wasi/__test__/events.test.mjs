// EventTarget, Event, CustomEvent and AbortSignal's events, end to end: the guest
// (events/guest.mjs) runs in a P3 component, and its record of what every listener saw
// must equal the same guest's on Node, whose EventTarget is its own.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { run as native } from './events/guest.mjs';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`events test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'events: EventTarget dispatches as the engine does',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('events', 'events');

		const expected = JSON.parse(native());
		const phases = expected.find((entry) => entry[0] === 'spec-phase');

		// Node's EventTarget gives eventPhase 0 and currentTarget null to every listener
		// after the first; the DOM Standard (and browsers) keep AT_TARGET and the target
		phases.splice(1, phases.length - 1, true, true);
		// Node throws its own ERR_EVENT_RECURSION Error for a nested dispatch; the DOM
		// Standard throws an InvalidStateError DOMException
		expected.find((entry) => entry[0] === 'nested')[1] = 'InvalidStateError';
		expect(JSON.parse(await invoke(out, 'run()'))).toEqual(expected);
	}
);
