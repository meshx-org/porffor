// The server benchmark's app, as Porffor (porf native) and Bun serve it: a fetch handler with a
// route per scenario (bench/server/run.mjs). bench/server/node.mjs is the same on node:http.
const json = { message: 'Hello, World!', list: [1, 2, 3], nested: { ok: true } };
const chunk = new TextEncoder().encode('x'.repeat(1024));

export default {
	port: Number(process.env.PORT ?? 3000),
	async fetch(request) {
		const path = request.url.slice(request.url.indexOf('/', 8));

		if (path === '/') return new Response('Hello World!');

		if (path === '/json') return Response.json(json);

		if (path === '/echo') return new Response(await request.text());

		// 16 chunks of 1 KB, chunked
		if (path === '/stream') {
			let left = 16;

			return new Response(
				new ReadableStream({
					pull(controller) {
						if (left-- === 0) controller.close();
						else controller.enqueue(chunk);
					}
				})
			);
		}

		return new Response('not found', { status: 404 });
	}
};
