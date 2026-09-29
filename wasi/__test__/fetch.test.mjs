// fetch() over wasi:http 0.3, end to end: the guest (fetch/guest.mjs) is built as a P3
// component with the package's own build, run in wasmtime against a local server.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import http from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const BIG = 'x'.repeat(100_000) + 'end ⌘ 🙂 ok';
const SLOW_MS = 400;
const FAST_MS = 50;
// /hang and /drip hold their connection this long: an abort must not wait for it
const HANG_MS = 3_000;
const NDJSON_GAP_MS = 60;

const unavailable = missing();

if (unavailable !== null) console.warn(`fetch test skipped: ${unavailable}`);
let server;
let base;
let eventConnections = 0;
/** Writes `parts` into a response, `gapMs` apart, then ends it. */
function trickle(response, parts, gapMs, end = true) {
	parts.forEach((part, index) => {
		setTimeout(() => {
			response.write(part);

			if (end && index === parts.length - 1) response.end();
		}, index * gapMs);
	});
}

beforeAll(async () => {
	server = http.createServer((request, response) => {
		const chunks = [];

		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');

			if (request.url === '/big') {
				response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(BIG);

				return;
			}

			if (request.url === '/echo') {
				const echo = {
					method: request.method,
					type: request.headers['content-type'],
					test: request.headers['x-test'],
					body: text
				};

				response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(echo));

				return;
			}

			if (request.url === '/slow') {
				setTimeout(() => response.end('slow done'), SLOW_MS);

				return;
			}

			if (request.url === '/ndjson') {
				response.writeHead(200, { 'content-type': 'application/x-ndjson' });
				trickle(response, ['{"n":1}\n{"n":', '2}\n', '{"n":3}\n'], NDJSON_GAP_MS);

				return;
			}

			if (request.url === '/events') {
				eventConnections++;
				response.writeHead(200, { 'content-type': 'text/event-stream' });

				if (eventConnections === 1) {
					trickle(
						response,
						[
							'\uFEFFretry: 50\nid: 1\nevent: greet\ndata: hi\n\n',
							': a comment\ndata: line1\r\ndata: line2\r\n\r\n'
						],
						20
					);

					return;
				}
				// the reconnect: echoes Last-Event-ID, a line split across writes, then stays open
				const last = request.headers['last-event-id'] ?? 'none';

				trickle(response, ['data: aga', `in ${last}\n\n`], 20, false);

				return;
			}

			if (request.url === '/hang') {
				setTimeout(() => response.end('too late'), HANG_MS);

				return;
			}

			if (request.url === '/drip') {
				response.writeHead(200, { 'content-type': 'text/plain' }).write('first');
				setTimeout(() => response.end(' last'), HANG_MS);

				return;
			}

			if (request.url === '/fast') {
				setTimeout(() => response.end('fast done'), FAST_MS);

				return;
			}
			response.writeHead(404).end('no');
		});
	});
	await new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
	server.closeAllConnections();
	server.close();
});

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'fetch: bodies, headers, a POST, concurrency and errors over wasi:http 0.3',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('fetch', 'fetcher');
		const started = Date.now();
		const result = JSON.parse(await invoke(out, `run("${base}")`, 'p3=y,http=y'));

		expect(result.status).toBe(200);
		expect(result.type).toBe('text/plain; charset=utf-8');
		expect(result.length).toBe(BIG.length);
		expect(result.tail).toBe(BIG.slice(-12));
		expect(result.post).toBe(201);
		expect(result.echoed).toEqual({
			method: 'POST',
			type: 'text/plain; charset=utf-8',
			test: 'porffor',
			body: 'héllo ⌘ 🙂'
		});
		expect(result.slow).toBe('slow done');
		expect(result.fast).toBe('fast done');
		expect(result.order).toBe('fast,slow');
		expect(result.refused).toBe('connection-refused');
		expect(result.streamed).toMatchObject({
			records: '1,2,3',
			// bytes, not UTF-16 units: BIG ends in multi-byte characters
			valuesLength: Buffer.byteLength(BIG),
			earlyChunk: 'first',
			uploaded: 'streamed ⌘',
			dripFirst: 'first',
			afterCancel: true,
			events: 'open,greet:hi#1,message:line1/line2,error:0,open,message:again 1',
			closedState: 2
		});
		// the body arrived in pieces, the first well before the last
		expect(result.streamed.reads).toBeGreaterThanOrEqual(2);
		expect(result.streamed.firstAt).toBeLessThan(result.streamed.totalMs - NDJSON_GAP_MS);
		expect(result.aborted).toMatchObject({
			before: 'AbortError',
			headers: 'TimeoutError',
			body: 'AbortError',
			after: 'fast done'
		});
		expect(result.aborted.headersMs).toBeLessThan(HANG_MS / 2);
		// cancelled requests do not keep run() waiting for their connections
		expect(Date.now() - started).toBeLessThan(HANG_MS);
	}
);
