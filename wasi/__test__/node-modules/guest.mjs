// The Node modules fixture: a little of each of runtime/node's modules, what each gave returned
// as JSON for the test to check.
import EventEmitter, { once } from 'node:events';
import { Buffer } from 'node:buffer';
import util, { format, inspect, isDeepStrictEqual, promisify } from 'node:util';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { setTimeout as nodeSetTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

// a Buffer as a string: Buffer's own toString (a .toString, .slice... call on one is
// Uint8Array's under Porffor for now: it dispatches a typed array's builtin methods by type)
const text = (buffer, encoding) => Buffer.prototype.toString.call(buffer, encoding);

export async function run() {
	const out = {};

	const emitter = new EventEmitter();
	const heard = [];
	emitter.on('x', (value) => heard.push(value));
	emitter.once('x', (value) => heard.push(`once ${value}`));
	emitter.emit('x', 1);
	emitter.emit('x', 2);
	setTimeout(() => emitter.emit('later', 'a', 'b'), 1);
	out.events = { heard, later: await once(emitter, 'later') };

	const bytes = Buffer.from('héllo');
	out.buffer = {
		length: bytes.length,
		hex: text(bytes, 'hex'),
		base64: text(Buffer.from('hello'), 'base64'),
		fromBase64: text(Buffer.from('aGVsbG8=', 'base64')),
		concat: text(Buffer.concat([Buffer.from('a'), Buffer.from('b')])),
		uint32: Buffer.from([1, 2, 3, 4]).readUInt32BE(0),
		isBuffer: Buffer.isBuffer(Buffer.prototype.slice.call(bytes, 1))
	};

	const delayed = promisify((value, callback) =>
		nodeSetTimeout(() => callback(null, value * 2), 1)
	);
	out.util = {
		format: format('%s=%d %j', 'a', 42, { b: [1] }),
		inspect: inspect({ a: 1, list: [1, 2], nested: { map: new Map([[1, true]]) } }),
		deep: isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
		promisify: await delayed(21),
		types: util.types.isUint8Array(bytes)
	};

	const url = new URL('https://example.com/a/b?c=1#d');
	out.url = {
		host: url.host,
		search: url.searchParams.get('c'),
		path: fileURLToPath('file:///tmp/a%20b'),
		file: pathToFileURL('/tmp/x y').href
	};

	out.crypto = {
		random: randomBytes(32).length,
		uuid: randomUUID().length,
		sha256: createHash('sha256').update('abc').digest('hex'),
		hmac: createHmac('sha256', 'key').update('data').digest('base64')
	};

	const chunks = [];
	await pipeline(
		Readable.from(['a', 'b', 'c']),
		new Transform({
			objectMode: true,
			transform(chunk, encoding, callback) {
				callback(null, chunk.toUpperCase());
			}
		}),
		new Writable({
			objectMode: true,
			write(chunk, encoding, callback) {
				chunks.push(chunk);
				callback();
			}
		})
	);
	const decoder = new StringDecoder('utf8');
	const euro = Buffer.from('€');
	out.stream = {
		chunks,
		decoded: decoder.write(euro.subarray(0, 1)) + decoder.write(euro.subarray(1))
	};

	const start = performance.now();
	await sleep(20);
	out.timers = { waited: performance.now() - start >= 15, value: await sleep(1, 'v') };

	out.process = {
		platform: process.platform,
		cwd: typeof process.cwd(),
		hrtime: process.hrtime().length,
		nodeVersion: typeof process.versions.node
	};

	return JSON.stringify(out);
}
