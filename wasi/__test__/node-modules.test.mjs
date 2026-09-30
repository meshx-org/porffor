// Porffor's Node modules (runtime/node: events, buffer, util, url, crypto, stream,
// string_decoder, timers, perf_hooks, process) in a WASI component: the guest
// (node-modules/guest.mjs) is built for P3 and run in wasmtime.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`node-modules test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'node-modules: node:events, buffer, util, url, crypto, stream, timers and process (p3)',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('node-modules', 'node-modules', 'p3');
		const seen = JSON.parse(await invoke(out, 'run()'));

		expect(seen.events).toEqual({ heard: [1, 'once 1', 2], later: ['a', 'b'] });
		expect(seen.buffer).toEqual({
			length: 6,
			hex: '68c3a96c6c6f',
			base64: 'aGVsbG8=',
			fromBase64: 'hello',
			concat: 'ab',
			uint32: 0x01020304,
			isBuffer: true
		});
		expect(seen.util).toEqual({
			format: 'a=42 {"b":[1]}',
			inspect: '{ a: 1, list: [ 1, 2 ], nested: { map: Map(1) { 1 => true } } }',
			deep: true,
			promisify: 42,
			types: true
		});
		expect(seen.url).toEqual({
			host: 'example.com',
			search: '1',
			path: '/tmp/a b',
			file: 'file:///tmp/x%20y'
		});
		// the same hashes as Node's own
		expect(seen.crypto).toEqual({
			random: 32,
			uuid: 36,
			sha256: createHash('sha256').update('abc').digest('hex'),
			hmac: createHmac('sha256', 'key').update('data').digest('base64')
		});
		expect(seen.stream).toEqual({ chunks: ['A', 'B', 'C'], decoded: '€' });
		expect(seen.timers).toEqual({ waited: true, value: 'v' });
		expect(seen.process).toEqual({
			platform: 'wasi',
			cwd: 'string',
			hrtime: 2,
			nodeVersion: 'string'
		});
	}
);
