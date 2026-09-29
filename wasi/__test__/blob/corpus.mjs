// The Blob corpus: each case's result as one line, run against a given Blob, File and
// Response (the guest's, from runtime/, and Node's own), so the two can be compared line by line.

/** A value as a stable line. */
const show = (value) =>
	value instanceof Uint8Array ? `bytes[${Array.from(value).join(',')}]` : JSON.stringify(value);

/**
 * Runs the corpus.
 * @param {typeof globalThis.Blob} Blob
 * @param {typeof globalThis.File} File
 * @param {typeof globalThis.Response} Response
 * @returns {Promise<string[]>}
 */
export async function runCorpus(Blob, File, Response) {
	const lines = [];
	const line = async (name, fn) => {
		try {
			lines.push(`${name}: ${show(await fn())}`);
		} catch (error) {
			lines.push(
				`${name}: throws ${error instanceof TypeError ? 'TypeError' : String(error?.name)}`
			);
		}
	};
	const describe = async (blob) => [blob.size, blob.type, await blob.text()];

	await line('empty', () => describe(new Blob()));
	await line('strings', () => describe(new Blob(['ab', 'cé', '€'])));
	await line('typed', () =>
		describe(new Blob([new Uint8Array([104, 105]), new Uint16Array([0x6f6f])]))
	);
	await line('buffer', () => describe(new Blob([new Uint8Array([65, 66, 67]).buffer])));
	await line('view offset', () =>
		describe(new Blob([new Uint8Array([1, 2, 72, 73, 5]).subarray(2, 4)]))
	);
	await line('nested', () =>
		describe(new Blob([new Blob(['in']), '-', new Blob(['ner'], { type: 'x/y' })]))
	);
	await line('other values', () => describe(new Blob([1, null, undefined, { a: 1 }, true])));
	await line('type lower', () => new Blob([], { type: 'Text/HTML; Charset=UTF-8' }).type);
	await line('type non-ascii', () => new Blob([], { type: 'text/é' }).type);
	await line('type control', () => new Blob([], { type: 'a\u0019b' }).type);
	// (CRLF only: a lone CR is converted as well by the spec, which Node does not do)
	await line('endings native', () => new Blob(['a\r\nb\nc\r\n'], { endings: 'native' }).text());
	await line('endings transparent', () => new Blob(['a\r\nb'], { endings: 'transparent' }).text());
	await line('endings bad', () => new Blob(['a'], { endings: 'other' }).size);
	await line('parts not iterable', () => new Blob({}).size);
	await line('parts null', () => new Blob(null).size);
	await line('parts from set', () => new Blob(new Set(['x', 'y'])).text());

	const base = new Blob(['0123456789'], { type: 'text/plain' });

	await line('slice all', () => describe(base.slice()));
	await line('slice start', () => base.slice(3).text());
	await line('slice range', () => base.slice(2, 5).text());
	await line('slice negative', () => base.slice(-3).text());
	await line('slice negative end', () => base.slice(1, -2).text());
	await line('slice backwards', () => describe(base.slice(6, 2)));
	await line('slice past end', () => base.slice(8, 50).text());
	await line('slice fractional', () => base.slice(1.7, 3.2).text());
	await line('slice type', () => base.slice(0, 1, 'Image/PNG').type);
	await line('slice of slice', () => base.slice(2, 8).slice(1, 3).text());

	await line('bytes', () => new Blob(['hi']).bytes());
	await line('arrayBuffer', async () => new Uint8Array(await new Blob(['hé']).arrayBuffer()));
	await line('bytes copy', async () => {
		const blob = new Blob(['ab']);
		const bytes = await blob.bytes();

		bytes[0] = 120;
		return blob.text();
	});
	await line('stream', async () => {
		const reader = new Blob(['str', 'eam']).stream().getReader();
		const chunks = [];

		while (true) {
			const { value, done } = await reader.read();

			if (done) break;
			chunks.push(...value);
		}
		return new TextDecoder().decode(new Uint8Array(chunks));
	});
	await line('toStringTag', () => [Object.prototype.toString.call(new Blob()), String(new Blob())]);
	await line('instanceof', () => [new Blob() instanceof Blob, new File([], 'f') instanceof Blob]);

	await line('file', async () => {
		// (an integer: the spec's long long truncates a fraction, which Node keeps)
		const file = new File(['data'], 'name.txt', { type: 'Text/Plain', lastModified: 1234 });

		return [file.name, file.size, file.type, file.lastModified, await file.text()];
	});
	await line('file default time', () => typeof new File([], 'x').lastModified);
	await line('file args', () => new File(['a']).name);
	await line('file tag', () => Object.prototype.toString.call(new File([], 'x')));

	await line('response body', async () => {
		const response = new Response(new Blob(['body'], { type: 'text/x-test' }));

		return [response.headers.get('content-type'), await response.text()];
	});
	await line('response untyped', () => new Response(new Blob(['z'])).headers.get('content-type'));
	await line('response blob', async () => {
		const blob = await new Response('abc', { headers: { 'content-type': 'Text/CSV' } }).blob();

		return [blob.size, blob.type, await blob.text()];
	});

	return lines;
}
