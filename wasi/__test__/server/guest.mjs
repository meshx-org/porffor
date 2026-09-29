// The server fixture: a fetch handler, as Cloudflare Workers and Hono write one.

const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

// requests in flight in this instance, and the most at once: above 1 only when calls
// really run concurrently inside one instance
let inFlight = 0;
let peak = 0;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/stats') return Response.json({ peak });

		if (url.pathname === '/hello')
			return new Response('hi ' + (url.searchParams.get('name') ?? 'there'), {
				headers: { 'x-porffor': 'yes' }
			});

		if (url.pathname === '/echo')
			return Response.json({
				method: request.method,
				type: request.headers.get('content-type'),
				body: await request.text(),
				greeting: env.GREETING ?? null
			});

		if (url.pathname === '/stream') {
			let sent = 0;

			inFlight++;
			peak = Math.max(peak, inFlight);

			return new Response(
				new ReadableStream({
					async pull(controller) {
						if (sent === 3) {
							inFlight--;
							controller.close();

							return;
						}
						await sleep(50);
						controller.enqueue(new TextEncoder().encode(`chunk${sent++};`));
					}
				})
			);
		}

		if (url.pathname === '/big') return new Response('x'.repeat(200_000) + 'end');

		if (url.pathname === '/throw') throw new Error('boom');

		// a proxy that passes the upstream's body through, and leaves it unread on an error
		if (url.pathname.startsWith('/proxy/')) {
			const upstream = await fetch(env.UPSTREAM + url.pathname.slice('/proxy'.length));

			if (!upstream.ok) return new Response('upstream failed', { status: 502 });

			return new Response(upstream.body, { headers: { 'x-proxied': 'yes' } });
		}

		return new Response('not found: ' + url.pathname, { status: 404 });
	}
};
