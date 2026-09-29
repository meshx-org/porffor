// The Web Crypto corpus: each case's result as one line, run against a given crypto and
// CryptoKey (the guest's shim and Node's own), so the two can be compared line by line.
// Deterministic cases compare bytes; generated keys are checked by shape and round trip.
// Left out where Node departs from the spec: 'raw' export of an Ed25519 private key is an
// InvalidAccessError in the spec (the shim) and a NotSupportedError in Node.

const text = (value) => new TextEncoder().encode(value);
const hex = (buffer) =>
	Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (value) => new Uint8Array(value.match(/../g).map((pair) => parseInt(pair, 16)));

// RFC 8032, 7.1, test 1: the seed, its public key and the signature of the empty message
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PKCS8 = `302e020100300506032b657004220420${SEED}`;

/**
 * Runs the corpus.
 * @param {Crypto} crypto
 * @param {typeof CryptoKey} CryptoKey
 * @returns {Promise<string[]>}
 */
export async function runCorpus(crypto, CryptoKey) {
	const { subtle } = crypto;
	const lines = [];
	const line = async (name, fn) => {
		try {
			lines.push(`${name}: ${JSON.stringify(await fn())}`);
		} catch (error) {
			lines.push(
				`${name}: throws ${error instanceof TypeError ? 'TypeError' : String(error?.name)}`
			);
		}
	};
	const describe = (key) => [key.type, key.extractable, key.algorithm, key.usages];

	for (const hash of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'])
		await line(`digest ${hash}`, async () => hex(await subtle.digest(hash, text('abc'))));
	await line('digest object name', async () =>
		hex(await subtle.digest({ name: 'sha-256' }, new Uint8Array()))
	);
	await line('digest view', async () =>
		hex(await subtle.digest('SHA-256', new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)))
	);
	await line('digest unsupported', () => subtle.digest('MD5', text('x')));
	await line('digest not bytes', () => subtle.digest('SHA-256', 'abc'));

	for (const hash of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
		const key = await subtle.importKey('raw', text('key'), { name: 'HMAC', hash }, true, [
			'sign',
			'verify'
		]);
		const mac = await subtle.sign('HMAC', key, text('The quick brown fox'));

		await line(`hmac ${hash} key`, () => describe(key));
		await line(`hmac ${hash} sign`, () => hex(mac));
		await line(`hmac ${hash} verify`, () =>
			subtle.verify('HMAC', key, mac, text('The quick brown fox'))
		);
		await line(`hmac ${hash} verify wrong`, () =>
			subtle.verify('HMAC', key, mac, text('the quick brown fox'))
		);
		await line(`hmac ${hash} jwk`, () => subtle.exportKey('jwk', key));
		await line(`hmac ${hash} raw`, async () => hex(await subtle.exportKey('raw', key)));
	}
	await line('hmac jwk import', async () => {
		const key = await subtle.importKey(
			'jwk',
			{ kty: 'oct', k: 'a2V5', alg: 'HS256' },
			{ name: 'HMAC', hash: { name: 'SHA-256' } },
			false,
			['sign']
		);

		return [describe(key), hex(await subtle.sign({ name: 'HMAC' }, key, text('x')))];
	});
	await line('hmac jwk wrong alg', () =>
		subtle.importKey(
			'jwk',
			{ kty: 'oct', k: 'a2V5', alg: 'HS512' },
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		)
	);
	await line('hmac jwk wrong kty', () =>
		subtle.importKey('jwk', { kty: 'RSA', k: 'a2V5' }, { name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign'
		])
	);
	await line('hmac empty key', () =>
		subtle.importKey('raw', new Uint8Array(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	);
	await line('hmac bad usage', () =>
		subtle.importKey('raw', text('k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['encrypt'])
	);
	await line('hmac no hash', () =>
		subtle.importKey('raw', text('k'), { name: 'HMAC' }, false, ['sign'])
	);
	await line('hmac generate', async () => {
		const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-512' }, true, ['sign']);

		return [describe(key), (await subtle.exportKey('raw', key)).byteLength];
	});
	await line('hmac generate length', async () =>
		describe(
			await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 128 }, false, ['verify'])
		)
	);
	await line('hmac generate no usages', () =>
		subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [])
	);
	await line('hmac not extractable', async () =>
		subtle.exportKey(
			'raw',
			await subtle.importKey('raw', text('k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
		)
	);
	await line('hmac sign without usage', async () =>
		subtle.sign(
			'HMAC',
			await subtle.importKey('raw', text('k'), { name: 'HMAC', hash: 'SHA-256' }, false, [
				'verify'
			]),
			text('x')
		)
	);

	const privateKey = await subtle.importKey('pkcs8', fromHex(PKCS8), 'Ed25519', true, ['sign']);
	const signature = await subtle.sign('Ed25519', privateKey, new Uint8Array());
	const spki = await subtle.exportKey(
		'spki',
		await subtle.importKey(
			'jwk',
			{ ...(await subtle.exportKey('jwk', privateKey)), d: undefined, key_ops: ['verify'] },
			'Ed25519',
			true,
			['verify']
		)
	);
	const publicKey = await subtle.importKey('spki', spki, { name: 'Ed25519' }, true, ['verify']);

	await line('ed25519 private', () => describe(privateKey));
	await line('ed25519 public', () => describe(publicKey));
	await line('ed25519 sign rfc8032', () => hex(signature));
	await line('ed25519 verify', () =>
		subtle.verify('Ed25519', publicKey, signature, new Uint8Array())
	);
	await line('ed25519 verify tampered', () =>
		subtle.verify('Ed25519', publicKey, signature, new Uint8Array([1]))
	);
	await line('ed25519 verify short', () =>
		subtle.verify('Ed25519', publicKey, new Uint8Array(10), new Uint8Array())
	);
	await line('ed25519 private jwk', () => subtle.exportKey('jwk', privateKey));
	await line('ed25519 public jwk', () => subtle.exportKey('jwk', publicKey));
	await line('ed25519 spki', () => hex(spki));
	await line('ed25519 raw', async () => hex(await subtle.exportKey('raw', publicKey)));
	await line('ed25519 pkcs8', async () => hex(await subtle.exportKey('pkcs8', privateKey)));
	await line('ed25519 raw import', async () => {
		const key = await subtle.importKey(
			'raw',
			await subtle.exportKey('raw', publicKey),
			'Ed25519',
			false,
			['verify']
		);

		return [describe(key), await subtle.verify('Ed25519', key, signature, new Uint8Array())];
	});
	await line('ed25519 raw sign usage', async () =>
		subtle.importKey('raw', await subtle.exportKey('raw', publicKey), 'Ed25519', false, ['sign'])
	);
	await line('ed25519 pkcs8 bad', () =>
		subtle.importKey('pkcs8', new Uint8Array(20), 'Ed25519', false, ['sign'])
	);
	await line('ed25519 jwk mismatch', async () => {
		const jwk = await subtle.exportKey('jwk', privateKey);

		return subtle.importKey(
			'jwk',
			{ ...jwk, x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
			'Ed25519',
			false,
			['sign']
		);
	});
	await line('ed25519 wrong key for hmac', () => subtle.sign('HMAC', privateKey, text('x')));
	await line('ed25519 generate', async () => {
		const pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
		const signed = await subtle.sign('Ed25519', pair.privateKey, text('msg'));

		return [
			describe(pair.privateKey),
			describe(pair.publicKey),
			signed.byteLength,
			await subtle.verify('Ed25519', pair.publicKey, signed, text('msg'))
		];
	});
	await line('ed25519 generate verify only', () => subtle.generateKey('Ed25519', true, ['verify']));

	await line('tags', () => [
		Object.prototype.toString.call(subtle),
		Object.prototype.toString.call(privateKey),
		privateKey instanceof CryptoKey
	]);
	await line('new CryptoKey', () => new CryptoKey());
	await line('random values', () => crypto.getRandomValues(new Uint8Array(8)).length);
	await line('uuid', () =>
		/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(crypto.randomUUID())
	);

	return lines;
}
