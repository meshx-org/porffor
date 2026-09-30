// The native server: `export default { fetch }` compiled with the runtime and served over libuv
// and llhttp (runtime/host/native/http-server.mjs), driven from Node with fetch and raw sockets.
// One server for the file (server/main.mjs, a route per behavior); each test has its own timeout,
// so a hang names the behavior that hung.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build, serve } from './harness.mjs';

let server;

beforeAll(async () => {
	server = await serve(await build('server'));
}, 300_000);

afterAll(async () => {
	await server?.stop();
});

const at = (path) => new URL(path, server.url).href;

/**
 * Raw bytes to the server on one connection: what came back once `done` says so (or the server
 * closed the connection).
 * @param {string | Buffer} request
 * @param {(text: string) => boolean} [done]
 */
function raw(request, done = () => false) {
	return new Promise((resolve, reject) => {
		const { hostname, port } = new URL(server.url);
		const socket = net.connect(Number(port), hostname);
		let text = '';

		socket.on('connect', () => socket.write(request));
		socket.on('data', (chunk) => {
			text += chunk;
			if (done(text)) socket.end();
		});
		socket.on('end', () => resolve(text));
		socket.on('close', () => resolve(text));
		socket.on('error', reject);
	});
}

// Node's weighted sum of a body's bytes, as /echo computes it
const weightedSum = (bytes) => {
	let sum = 0;

	for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * ((i % 251) + 1)) % 1000000007;

	return sum;
};

const responses = (text) => text.split(/(?=HTTP\/1\.1 )/).filter(Boolean);

describe('native server', { timeout: 20_000 }, () => {
	test('GET: the body, status and content type', async () => {
		const response = await fetch(at('/hello?name=porffor'));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
		expect(await response.text()).toBe('hi porffor');
	});

	test("the request's URL and method", async () => {
		const response = await fetch(at('/url?x=1'), { method: 'PATCH' });

		expect(await response.json()).toEqual({ url: at('/url?x=1'), method: 'PATCH' });
	});

	test('a request body: small and 10 MB', async () => {
		for (const size of [5, 10 * 1024 * 1024]) {
			const body = new Uint8Array(size).map((_, i) => (i * 7) & 255);
			const response = await fetch(at('/echo'), {
				method: 'POST',
				body,
				headers: { 'content-type': 'application/octet-stream' }
			});

			expect(await response.json()).toEqual({
				method: 'POST',
				length: size,
				sum: weightedSum(body),
				type: 'application/octet-stream',
				te: null
			});
		}
	});

	test('a chunked request body', async () => {
		const parts = ['one ', 'two ', 'three'];
		const body = new ReadableStream({
			pull(controller) {
				if (parts.length === 0) controller.close();
				else controller.enqueue(new TextEncoder().encode(parts.shift()));
			}
		});
		const response = await fetch(at('/echo'), { method: 'PUT', body, duplex: 'half' });
		const seen = await response.json();

		expect(seen.length).toBe(13);
		expect(seen.te).toBe('chunked');
	});

	test('a request body streamed back as the response', async () => {
		const response = await fetch(at('/pipe'), { method: 'POST', body: 'x'.repeat(100_000) });

		expect((await response.text()).length).toBe(100_000);
	});

	test('headers: several of a name, and the request headers as sent', async () => {
		const response = await fetch(at('/headers'), { headers: { 'X-Custom': 'Value' } });
		const seen = new Map(await response.json());

		expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
		expect(response.headers.get('x-multi')).toBe('one, two');
		expect(response.headers.get('x-mixed-case')).toBe('Yes');
		expect(seen.get('x-custom')).toBe('Value');
	});

	test('status codes and texts; 204 with no body', async () => {
		const teapot = await fetch(at('/status/418?text=I%27m%20a%20teapot'));

		expect(teapot.status).toBe(418);
		expect(teapot.statusText).toBe("I'm a teapot");
		expect(await teapot.text()).toBe('status 418');

		const empty = await fetch(at('/status/204'));

		expect(empty.status).toBe(204);
		expect(await empty.text()).toBe('');
	});

	test('a streamed response, chunk by chunk', async () => {
		const response = await fetch(at('/stream'));

		expect(response.headers.get('transfer-encoding')).toBe('chunked');
		expect(await response.text()).toBe('chunk0;chunk1;chunk2;chunk3;chunk4;');
	});

	test('JSON, bytes, a Blob, a large body', async () => {
		expect(await (await fetch(at('/json'))).json()).toEqual({
			ok: true,
			list: [1, 2, 3],
			text: 'héllo ⌘'
		});
		expect([...new Uint8Array(await (await fetch(at('/bytes'))).arrayBuffer())]).toEqual([
			0, 1, 2, 255
		]);

		const blob = await fetch(at('/blob'));

		expect(blob.headers.get('content-type')).toBe('text/x-blob');
		expect(await blob.text()).toBe('blob body');

		const big = await (await fetch(at('/big'))).text();

		expect(big.length).toBe(5_000_003);
		expect(big.endsWith('end')).toBe(true);
	});

	test('a redirect', async () => {
		const response = await fetch(at('/redirect'), { redirect: 'manual' });

		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe(at('/hello'));
	});

	test('an async handler', async () => {
		expect(await (await fetch(at('/async'))).text()).toBe('later');
	});

	test('a handler that throws, or answers with no Response: 500, and the server goes on', async () => {
		expect((await fetch(at('/throw'))).status).toBe(500);
		expect((await fetch(at('/not-response'))).status).toBe(500);
		expect((await fetch(at('/hello'))).status).toBe(200);
	});

	test('HEAD: the head alone, its content-length kept', async () => {
		const text = await raw(`HEAD /head-length HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);

		expect(text).toMatch(/^HTTP\/1\.1 200/);
		expect(text.toLowerCase()).toContain('content-length: 123');
		expect(text.endsWith('\r\n\r\n')).toBe(true);
	});

	test("a handler's own date header is kept", async () => {
		expect((await fetch(at('/date'))).headers.get('date')).toBe('Tue, 01 Jan 2030 00:00:00 GMT');
	});

	test('keep-alive: two requests on one connection', async () => {
		const request = (path) => `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`;
		const text = await new Promise((resolve, reject) => {
			const { hostname, port } = new URL(server.url);
			const socket = net.connect(Number(port), hostname);
			let seen = '';

			socket.on('connect', () => socket.write(request('/hello?name=a')));
			socket.on('data', (chunk) => {
				seen += chunk;
				if (seen.includes('hi a') && !seen.includes('hi b')) socket.write(request('/hello?name=b'));
				if (seen.includes('hi b')) socket.end();
			});
			socket.on('close', () => resolve(seen));
			socket.on('error', reject);
		});

		expect(responses(text).length).toBe(2);
	});

	test('pipelining: two requests in one write, answered in order', async () => {
		const text = await raw(
			'GET /async HTTP/1.1\r\nHost: x\r\n\r\nGET /hello?name=second HTTP/1.1\r\nHost: x\r\n\r\n',
			(seen) => seen.includes('hi second')
		);
		const [first, second] = responses(text);

		expect(first).toContain('later');
		expect(second).toContain('hi second');
	});

	test('a malformed request: 400', async () => {
		expect(await raw('THIS IS NOT HTTP\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
	});

	test('HTTP/1.1 without a Host header: 400 (RFC 9112 3.2)', async () => {
		expect(await raw('GET /hello HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
	});

	test('two Host headers: 400', async () => {
		expect(await raw('GET /hello HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n')).toMatch(
			/^HTTP\/1\.1 400/
		);
	});

	test('a request head over the limit: 431', async () => {
		const text = await raw(
			`GET /hello HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(70 * 1024)}\r\n\r\n`
		);

		expect(text).toMatch(/^HTTP\/1\.1 431/);
	});

	test('a client that leaves mid-response: the stream is cancelled, the server goes on', async () => {
		const before = await (await fetch(at('/stats'))).json();
		const controller = new AbortController();
		const response = await fetch(at('/slow'), { signal: controller.signal });
		const reader = response.body.getReader();

		await reader.read();
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 300));

		const after = await (await fetch(at('/stats'))).json();

		expect(after.aborted).toBeGreaterThan(before.aborted);
		expect(after.slowActive).toBe(before.slowActive);
	});

	test("a client that leaves before the answer: the request's signal aborts", async () => {
		const before = await (await fetch(at('/stats'))).json();
		const { hostname, port } = new URL(server.url);
		const socket = net.connect(Number(port), hostname);

		await new Promise((resolve) => socket.on('connect', resolve));
		socket.write('GET /wait-abort HTTP/1.1\r\nHost: x\r\n\r\n');
		await new Promise((resolve) => setTimeout(resolve, 100));
		socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect((await (await fetch(at('/stats'))).json()).aborted).toBe(before.aborted + 1);
	});

	test('Expect: 100-continue is answered before the body is sent', async () => {
		const text = await new Promise((resolve, reject) => {
			const { hostname, port } = new URL(server.url);
			const socket = net.connect(Number(port), hostname);
			let seen = '';

			socket.on('connect', () =>
				socket.write(
					'POST /echo-text HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n'
				)
			);
			socket.on('data', (chunk) => {
				seen += chunk;
				// the body only once the server asked for it
				if (seen === 'HTTP/1.1 100 Continue\r\n\r\n') socket.write('hello');
			});
			socket.on('close', () => resolve(seen));
			socket.on('error', reject);
		});

		expect(text.startsWith('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n')).toBe(true);
		expect(text.endsWith('\r\n\r\nhello')).toBe(true);
	});

	test('HTTP/1.0: closed after the response unless kept alive; a stream ends with the connection', async () => {
		const closed = await raw('GET /hello HTTP/1.0\r\n\r\n');

		expect(closed).toMatch(/^HTTP\/1\.0 200 OK\r\n/);
		expect(closed.toLowerCase()).toContain('connection: close');

		const kept = await raw(
			'GET /hello?name=a HTTP/1.0\r\nConnection: keep-alive\r\n\r\nGET /hello?name=b HTTP/1.0\r\n\r\n'
		);

		expect(kept.toLowerCase()).toContain('connection: keep-alive');
		expect(kept).toMatch(/hi a[\s\S]*hi b$/);

		const streamed = await raw('GET /stream HTTP/1.0\r\n\r\n');

		expect(streamed.toLowerCase()).not.toContain('transfer-encoding');
		expect(streamed.endsWith('chunk0;chunk1;chunk2;chunk3;chunk4;')).toBe(true);
	});

	test('a client that half-closes after its requests still gets every answer', async () => {
		const text = await new Promise((resolve, reject) => {
			const { hostname, port } = new URL(server.url);
			const socket = net.connect(Number(port), hostname);
			let seen = '';

			socket.on('connect', () =>
				socket.end(
					'GET /async HTTP/1.1\r\nHost: x\r\n\r\nGET /hello?name=last HTTP/1.1\r\nHost: x\r\n\r\n'
				)
			);
			socket.on('data', (chunk) => (seen += chunk));
			socket.on('close', () => resolve(seen));
			socket.on('error', reject);
		});
		const [first, second] = responses(text);

		expect(first).toContain('later');
		expect(second).toContain('hi last');
	});

	test('a request body left unread: the next request on the connection is answered', async () => {
		const text = await raw(
			'POST /hello?name=one HTTP/1.1\r\nHost: x\r\nContent-Length: 11\r\n\r\nhello worldGET /hello?name=two HTTP/1.1\r\nHost: x\r\n\r\n',
			(seen) => seen.includes('hi two')
		);

		expect(responses(text).length).toBe(2);
	});

	test('clients that leave while large responses are written: the server survives (no SIGPIPE)', async () => {
		const { hostname, port } = new URL(server.url);

		for (const path of ['/big', '/flood', '/flood']) {
			await new Promise((resolve, reject) => {
				const socket = net.connect(Number(port), hostname);
				let got = 0;

				socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`));
				socket.on('data', (chunk) => {
					got += chunk.length;
					// gone mid-body, unread bytes still queued: a reset
					if (got > 100_000) {
						socket.destroy();
						resolve();
					}
				});
				socket.on('error', reject);
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(await (await fetch(at('/hello'))).text()).toBe('hi there');

		const flood = await (await fetch(at('/flood'))).arrayBuffer();

		expect(flood.byteLength).toBe(512 * 65_536);
	});

	test('listens on IPv6 and IPv4 both: localhost and ::1 reach it', async () => {
		const { port } = new URL(server.url);

		expect(await (await fetch(`http://[::1]:${port}/hello`)).text()).toBe('hi there');
		expect(await (await fetch(`http://localhost:${port}/hello`)).text()).toBe('hi there');
	});

	test('200 requests at once', async () => {
		const answers = await Promise.all(
			Array.from({ length: 200 }, (_, i) => fetch(at(`/hello?name=${i}`)).then((r) => r.text()))
		);

		expect(answers).toEqual(Array.from({ length: 200 }, (_, i) => `hi ${i}`));
	});
});
