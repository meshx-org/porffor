// The host's time zone (wasi:clocks/timezone), end to end: the guest (timezone/guest.mjs)
// reads it through Date and Temporal.Now. wasmtime has no wasi:clocks/timezone, so a
// provider component (timezone-host/, Europe/Budapest) is plugged in with wac. Built for P2
// and for P3; a world that does not import the interface reads UTC.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH), wac (WAC, or wac on PATH) and the
// build toolchain.

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

if (unavailable !== null) console.warn(`timezone test skipped: ${unavailable}`);

for (const target of ['p2', 'p3'])
	// needs wasmtime 49+, wac and the build toolchain; skipped, with the reason printed, without them
	test.skipIf(unavailable !== null)(
		`timezone: Date and Temporal.Now read the host's zone (${target})`,
		{ timeout: 300_000 },
		async () => {
			const guest = buildFixture('timezone', 'timezone', target);
			const host = buildFixture('timezone-host', 'timezone-host', 'p3');
			const composed = join(dirname(guest), 'composed.wasm');

			execFileSync(wac, ['plug', guest, '--plug', host, '-o', composed], { stdio: 'pipe' });
			const out = JSON.parse(await invoke(composed, 'run()'));

			expect(out).toEqual({ id: 'Europe/Budapest', offsets: [-120, -60], hours: [14, 13] });
		}
	);

test.skipIf(unavailable !== null)(
	'timezone: no wasi:clocks/timezone reads UTC',
	{ timeout: 300_000 },
	async () => {
		const out = JSON.parse(await invoke(buildFixture('timezone', 'no-timezone'), 'run()'));

		expect(out).toEqual({ id: 'UTC', offsets: [0, 0], hours: [12, 12] });
	}
);
