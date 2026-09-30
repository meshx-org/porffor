// The native server's fixture: export default { fetch } served by the runtime (runtime/serve.mjs over
// runtime/host/native/http-server.mjs: libuv and llhttp), a route for each behavior server.test.mjs
// checks. PORT=0 in the tests: a free port, which the server prints.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let aborted = 0;
let slowActive = 0;

export default {
	port: Number(process.env.PORT ?? 3000),
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/hello') return new Response('hi ' + (url.searchParams.get('name') ?? 'there'));

		if (path === '/url') return Response.json({ url: request.url, method: request.method });

		if (path === '/echo') {
			const bytes = new Uint8Array(await request.arrayBuffer());
			let sum = 0;

			for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * ((i % 251) + 1)) % 1000000007;

			return Response.json({
				method: request.method,
				length: bytes.length,
				sum,
				type: request.headers.get('content-type'),
				te: request.headers.get('transfer-encoding')
			});
		}

		if (path === '/echo-text') return new Response(await request.text());

		// the body streamed straight back
		if (path === '/pipe') return new Response(request.body);

		if (path === '/headers') {
			const headers = new Headers();

			headers.append('Set-Cookie', 'a=1');
			headers.append('Set-Cookie', 'b=2');
			headers.append('X-Multi', 'one');
			headers.append('X-Multi', 'two');
			headers.set('X-Mixed-Case', 'Yes');

			return new Response(JSON.stringify([...request.headers]), { headers });
		}

		if (path.startsWith('/status/')) {
			const status = Number(path.slice(8));
			const statusText = url.searchParams.get('text') ?? undefined;

			return new Response(status === 204 || status === 304 ? null : 'status ' + status, {
				status,
				statusText
			});
		}

		if (path === '/stream') {
			let sent = 0;

			return new Response(
				new ReadableStream({
					async pull(controller) {
						if (sent === 5) return controller.close();
						await sleep(40);
						controller.enqueue(new TextEncoder().encode(`chunk${sent++};`));
					}
				}),
				{ headers: { 'content-type': 'text/plain' } }
			);
		}

		if (path === '/slow') {
			slowActive++;
			const signal = request.signal;
			let n = 0;

			return new Response(
				new ReadableStream({
					async pull(controller) {
						await sleep(20);

						if (signal.aborted) return;
						controller.enqueue(new TextEncoder().encode(`tick${n++}\n`));
					},
					cancel() {
						slowActive--;
						aborted++;
					}
				})
			);
		}

		if (path === '/wait-abort') {
			// never answers until the client leaves
			await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
			aborted++;

			return new Response('late');
		}

		if (path === '/stats') return Response.json({ aborted, slowActive });

		if (path === '/json') return Response.json({ ok: true, list: [1, 2, 3], text: 'héllo ⌘' });

		if (path === '/redirect') return Response.redirect(new URL('/hello', request.url), 301);

		if (path === '/throw') throw new Error('boom');

		if (path === '/not-response') return 42;

		if (path === '/async') {
			await sleep(30);

			return new Response('later');
		}

		if (path === '/bytes') return new Response(new Uint8Array([0, 1, 2, 255]));

		if (path === '/big') return new Response('x'.repeat(5_000_000) + 'end');

		// 32 MB, as fast as the socket takes it: backpressure, and a client that leaves mid-way
		if (path === '/flood') {
			const chunk = new Uint8Array(65_536).fill(120);
			let left = 512;

			return new Response(
				new ReadableStream({
					pull(controller) {
						if (left-- === 0) controller.close();
						else controller.enqueue(chunk);
					}
				})
			);
		}

		if (path === '/blob') return new Response(new Blob(['blob ', 'body'], { type: 'text/x-blob' }));

		if (path === '/head-length')
			return new Response(null, { headers: { 'content-length': '123' } });

		if (path === '/date')
			return new Response('d', { headers: { date: 'Tue, 01 Jan 2030 00:00:00 GMT' } });

		return new Response('not found: ' + path, { status: 404 });
	}
};
