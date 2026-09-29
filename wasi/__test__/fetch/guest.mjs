// The fetch test's guest: every fetch() feature the test checks, from one async export.
// fetch, ReadableStream and EventSource are globals the build injects.

export async function run(base) {
	const big = await fetch(base + '/big');
	const text = await big.text();

	const post = await fetch(base + '/echo', {
		method: 'POST',
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-test': 'porffor' },
		body: 'héllo ⌘ 🙂'
	});
	const echoed = await post.json();

	// both in flight at once: /slow answers after /fast
	const order = [];
	const [slow, fast] = await Promise.all([
		fetch(base + '/slow')
			.then((response) => response.text())
			.then((body) => (order.push('slow'), body)),
		fetch(base + '/fast')
			.then((response) => response.text())
			.then((body) => (order.push('fast'), body))
	]);

	let refused = 'none';

	try {
		await fetch('http://127.0.0.1:1/nothing');
	} catch (error) {
		refused = error.payload === undefined ? String(error) : error.payload.tag;
	}

	// aborts: before the request, while waiting for headers, while reading the body
	const aborted = {};
	const errorName = (error) => (error?.name === undefined ? String(error) : error.name);

	try {
		await fetch(base + '/fast', { signal: AbortSignal.abort() });
	} catch (error) {
		aborted.before = errorName(error);
	}
	const hangStart = performance.now();

	try {
		await fetch(base + '/hang', { signal: AbortSignal.timeout(100) });
	} catch (error) {
		aborted.headers = errorName(error);
	}
	aborted.headersMs = performance.now() - hangStart;

	const controller = new AbortController();
	const drip = await fetch(base + '/drip', { signal: controller.signal });

	setTimeout(() => controller.abort(), 100);

	try {
		await drip.text();
	} catch (error) {
		aborted.body = errorName(error);
	}
	aborted.after = await (await fetch(base + '/fast')).text();

	// streaming: NDJSON read as it arrives
	const ndjsonStart = performance.now();
	const ndjson = (await fetch(base + '/ndjson')).body.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	let reads = 0;
	let firstAt = -1;
	const records = [];

	while (true) {
		const { value, done } = await ndjson.read();

		if (done) break;
		reads++;

		if (firstAt < 0) firstAt = performance.now() - ndjsonStart;
		pending += decoder.decode(value, { stream: true });
		const lines = pending.split('\n');

		pending = lines.pop();

		for (const line of lines) if (line !== '') records.push(JSON.parse(line).n);
	}
	const streamed = {
		records: records.join(','),
		reads,
		firstAt,
		totalMs: performance.now() - ndjsonStart
	};

	// values(): an async generator over the body; and leaving it early
	let valuesLength = 0;

	for await (const chunk of (await fetch(base + '/big')).body.values())
		valuesLength += chunk.length;
	streamed.valuesLength = valuesLength;
	const early = await fetch(base + '/drip');

	for await (const chunk of early.body.values()) {
		streamed.earlyChunk = decoder.decode(chunk);
		break;
	}
	streamed.lockedAfterBreak = early.body.locked;

	// a streaming request body
	const parts = ['stre', 'amed ⌘'];
	const upload = new ReadableStream({
		pull(controller) {
			if (parts.length === 0) controller.close();
			else controller.enqueue(new TextEncoder().encode(parts.shift()));
		}
	});

	streamed.uploaded = (
		await (await fetch(base + '/echo', { method: 'POST', body: upload })).json()
	).body;

	// cancelling with a read in flight
	const dripReader = (await fetch(base + '/drip')).body.getReader();

	streamed.dripFirst = decoder.decode((await dripReader.read()).value);
	const inFlight = dripReader.read();

	await dripReader.cancel('enough');
	streamed.afterCancel = (await inFlight).done;

	// EventSource: events, a comment, multi-line data, a line split across chunks, then a
	// dropped connection and a reconnect that sends Last-Event-ID
	const events = [];
	const source = new EventSource(base + '/events');

	await new Promise((resolve) => {
		source.onopen = () => events.push('open');
		source.onerror = () => events.push('error:' + source.readyState);
		source.addEventListener('greet', (event) =>
			events.push('greet:' + event.data + '#' + event.lastEventId)
		);
		source.onmessage = (event) => {
			events.push('message:' + event.data.replace('\n', '/'));

			if (event.data.startsWith('again')) {
				source.close();
				resolve();
			}
		};
	});
	streamed.events = events.join(',');
	streamed.closedState = source.readyState;

	return JSON.stringify({
		streamed,
		aborted,
		status: big.status,
		type: big.headers.get('content-type'),
		length: text.length,
		tail: text.slice(-12),
		post: post.status,
		echoed,
		slow,
		fast,
		order: order.join(','),
		refused
	});
}
