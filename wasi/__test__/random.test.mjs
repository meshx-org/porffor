// Math.random seeding and crypto.getRandomValues / randomUUID, end to end: the guest
// (random/guest.mjs) is built for P2 and for P3 (wasi-libc reaches wasi:random through
// each) and run twice in wasmtime.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

const unavailable = missing();

if (unavailable !== null) console.warn(`random test skipped: ${unavailable}`);

for (const target of ['p2', 'p3'])
	// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
	test.skipIf(unavailable !== null)(
		`random: Math.random seeded per instance, crypto values (${target})`,
		{ timeout: 300_000 },
		async () => {
			const out = buildFixture('random', 'random', target);
			const p3 = target === 'p3';
			const call = `run(${p3})`;
			const first = JSON.parse(await invoke(out, call, p3 ? 'p3=y' : ''));
			const second = JSON.parse(await invoke(out, call, p3 ? 'p3=y' : ''));

			for (const value of first.random) {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThan(1);
			}
			// a fresh instance draws a fresh sequence
			expect(second.random).not.toEqual(first.random);
			expect(second.words).not.toEqual(first.words);

			for (const uuid of [...first.uuids, ...second.uuids]) expect(uuid).toMatch(UUID_V4);
			expect(new Set([...first.uuids, ...second.uuids]).size).toBe(4);
			expect(first.words).toHaveLength(4);
			expect(first.outside).toBe(true);
			expect(first.errors).toEqual(p3 ? ['TypeError', 'RangeError'] : []);
		}
	);
