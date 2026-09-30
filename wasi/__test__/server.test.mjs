// A fetch handler as a wasi:http 0.3 server, end to end: the guest (server/guest.mjs,
// export default { fetch }) is built as a P3 component and served by `wasmtime serve`.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { createServer } from 'node:http';
import { afterAll, expect, test } from 'vitest';
import { buildFixture, missing, serve } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`server test skipped: ${unavailable}`);
let server;
// what the guest's /proxy/* fetches from: /ok answers, anything else is a 404
const upstream = createServer((request, response) => {
	if (request.url === '/ok') response.end('upstream ok');
	else response.writeHead(404).end('upstream missing');
});

afterAll(() => {
	server?.stop();
	upstream.close();
});

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'server: routes, bodies both ways, streaming, errors, concurrency',
	{ timeout: 300_000 },
	async () => {
		await new Promise((resolve) => {
			upstream.listen(0, '127.0.0.1', resolve);
		});
		server = await serve(buildFixture('server', 'server'), {
			GREETING: 'hello',
			UPSTREAM: `http://127.0.0.1:${upstream.address().port}`
		});
		const { base } = server;

		const hello = await fetch(base + '/hello?name=porffor');

		expect(hello.status).toBe(200);
		expect(hello.headers.get('x-porffor')).toBe('yes');
		expect(hello.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
		expect(await hello.text()).toBe('hi porffor');

		const missingRoute = await fetch(base + '/nope');

		expect(missingRoute.status).toBe(404);
		expect(await missingRoute.text()).toBe('not found: /nope');

		const echo = await fetch(base + '/echo', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'héllo ⌘'
		});

		expect(await echo.json()).toEqual({
			method: 'POST',
			type: 'text/plain',
			body: 'héllo ⌘',
			greeting: 'hello'
		});

		// the head first, then each chunk as the guest makes it (50 ms apart)
		const started = performance.now();
		const stream = await fetch(base + '/stream');
		const reader = stream.body.getReader();
		const arrivals = [];
		let text = '';

		while (true) {
			const { value, done } = await reader.read();

			if (done) break;
			arrivals.push(performance.now() - started);
			text += new TextDecoder().decode(value);
		}
		expect(text).toBe('chunk0;chunk1;chunk2;');
		expect(arrivals.length).toBeGreaterThanOrEqual(2);
		expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(60);

		const big = await (await fetch(base + '/big')).text();

		expect(big.length).toBe(200_003);
		expect(big.endsWith('end')).toBe(true);

		const thrown = await fetch(base + '/throw');

		expect(thrown.status).toBe(500);
		expect(server.log()).toContain('fetch handler failed: Error: boom');

		// a fetched body passed through; one left unread (the 502) must not stall the next
		// request: each call's host work is waited on by its own thread
		for (const [path, status, text] of [
			['/proxy/ok', 200, 'upstream ok'],
			['/proxy/missing', 502, 'upstream failed'],
			['/proxy/ok', 200, 'upstream ok'],
			['/proxy/missing', 502, 'upstream failed'],
			['/proxy/ok', 200, 'upstream ok']
		]) {
			const proxied = await fetch(base + path);

			expect(proxied.status).toBe(status);
			expect(await proxied.text()).toBe(text);
		}

		// six streams at once finish in about the time of one
		const parallelStart = performance.now();
		const all = await Promise.all(
			Array.from({ length: 6 }, () => fetch(base + '/stream').then((response) => response.text()))
		);

		expect(all).toEqual(Array.from({ length: 6 }, () => 'chunk0;chunk1;chunk2;'));
		expect(performance.now() - parallelStart).toBeLessThan(1_000);
	}
);
