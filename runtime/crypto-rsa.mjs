// RSA for the Web Crypto shim (https://w3c.github.io/webcrypto/#rsassa-pkcs1, #rsa-pss,
// #rsa-oaep): RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP. @noble has no RSA, so the math is here, on
// BigInt (RFC 8017): key generation (Miller-Rabin primes), EMSA-PKCS1-v1_5, EMSA-PSS and OAEP
// with MGF1, the private key operation through the CRT. Keys import and export as 'spki',
// 'pkcs8' and 'jwk' (kty RSA). Loaded (runtime/globals.json) only into a program that names one
// of the three.
//
// A key's material is its integers as unsigned big-endian bytes ({ n, e } and for a private key
// d, p, q, dp, dq, qi), so importing and exporting never touch BigInt; the math converts them
// when it needs them.

import { makeKey } from './crypto-key.mjs';
import {
	INTEGER,
	NULL,
	SEQUENCE,
	der,
	derOid,
	derSequence,
	derUnsigned,
	parsePkcs8,
	parseSpki,
	pkcs8,
	spki,
	unsignedBytes
} from './crypto-der.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	concatBytes,
	constantTimeEqual,
	dataError,
	fromBase64url,
	invalidAccess,
	jwkCommon,
	notSupported,
	operationError
} from './crypto-util.mjs';
import { hashFunction, registerAlgorithm } from './subtle-crypto.mjs';

const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

// --- BigInt arithmetic ---

/** Unsigned big-endian bytes as a BigInt. */
function toBigInt(bytes) {
	let hex = '0x0';

	for (const byte of bytes) hex += (byte < 16 ? '0' : '') + byte.toString(16);

	return BigInt(hex);
}

/** A BigInt as `length` unsigned big-endian bytes (or as few as it takes, for no length). */
function fromBigInt(value, length = 0) {
	let hex = value.toString(16);

	if (hex.length % 2) hex = `0${hex}`;
	const size = Math.max(length, hex.length / 2);
	const out = new Uint8Array(size);
	const offset = size - hex.length / 2;

	for (let i = 0; i < hex.length / 2; i++)
		out[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

	return out;
}

/** base ** exponent % modulus, by squaring (exponent's bits from the top). */
function modPow(base, exponent, modulus) {
	let result = 1n;
	let square = base % modulus;
	const bits = exponent.toString(2);

	for (let i = bits.length - 1; i >= 0; i--) {
		if (bits[i] === '1') result = (result * square) % modulus;
		square = (square * square) % modulus;
	}

	return result;
}

/** The inverse of a modulo m (they are coprime). */
function modInverse(a, m) {
	let [oldR, r] = [((a % m) + m) % m, m];
	let [oldS, s] = [1n, 0n];

	while (r !== 0n) {
		const quotient = oldR / r;

		[oldR, r] = [r, oldR - quotient * r];
		[oldS, s] = [s, oldS - quotient * s];
	}

	return ((oldS % m) + m) % m;
}

function gcd(a, b) {
	let [x, y] = [a, b];

	while (y !== 0n) [x, y] = [y, x % y];

	return x;
}

const SMALL_PRIMES = [
	3n,
	5n,
	7n,
	11n,
	13n,
	17n,
	19n,
	23n,
	29n,
	31n,
	37n,
	41n,
	43n,
	47n,
	53n,
	59n,
	61n,
	67n,
	71n,
	73n,
	79n,
	83n,
	89n,
	97n,
	101n,
	103n,
	107n,
	109n,
	113n,
	127n,
	131n,
	137n,
	139n,
	149n,
	151n,
	157n,
	163n
];

/** A random BigInt of exactly `bits` bits, its top two bits set (so p * q has 2 * bits). */
function randomOdd(bits) {
	const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(bits / 8)));
	const excess = bytes.length * 8 - bits;

	bytes[0] &= 0xff >> excess;
	bytes[0] |= 0xc0 >> excess;

	if (excess > 6) bytes[1] |= 0x80;
	bytes[bytes.length - 1] |= 1;

	return toBigInt(bytes);
}

/** Whether n is probably prime: trial division, then Miller-Rabin to the given rounds. */
function probablyPrime(n, rounds) {
	for (const small of SMALL_PRIMES) if (n % small === 0n) return n === small;
	let d = n - 1n;
	let s = 0;

	while ((d & 1n) === 0n) {
		d >>= 1n;
		s++;
	}
	const bytes = Math.ceil(n.toString(16).length / 2);

	for (let round = 0; round < rounds; round++) {
		const a = (toBigInt(crypto.getRandomValues(new Uint8Array(bytes))) % (n - 3n)) + 2n;
		let x = modPow(a, d, n);

		if (x === 1n || x === n - 1n) continue;
		let composite = true;

		for (let i = 1; i < s && composite; i++) {
			x = (x * x) % n;

			if (x === n - 1n) composite = false;
		}

		if (composite) return false;
	}

	return true;
}

/** A random prime of `bits` bits with p - 1 coprime to e. */
function randomPrime(bits, e) {
	// (FIPS 186-4 table C.3's rounds for the size)
	const rounds = bits >= 1024 ? 4 : bits >= 512 ? 7 : 20;

	for (;;) {
		const candidate = randomOdd(bits);

		if (gcd(candidate - 1n, e) === 1n && probablyPrime(candidate, rounds)) return candidate;
	}
}

// --- the key ---

/** The key's integers as BigInts (those it has). */
function integers(key) {
	const out = {};

	for (const [name, bytes] of Object.entries(key._material)) out[name] = toBigInt(bytes);

	return out;
}

/** The modulus's size in bytes. */
const modulusBytes = (key) => Math.ceil(key._algorithm.modulusLength / 8);

/** m ** e mod n. */
function publicOp(key, message) {
	const { n, e } = integers(key);

	return modPow(message, e, n);
}

/** c ** d mod n, through the CRT. */
function privateOp(key, cipher) {
	const { p, q, dp, dq, qi } = integers(key);
	const m1 = modPow(cipher % p, dp, p);
	const m2 = modPow(cipher % q, dq, q);
	const h = (qi * (((m1 - m2) % p) + p)) % p;

	return m2 + h * q;
}

// --- encodings (RFC 8017) ---

/** MGF1 over the hash: `length` bytes from the seed. */
function mgf1(hash, seed, length) {
	const out = new Uint8Array(length);
	const counter = new Uint8Array(4);

	for (let at = 0, i = 0; at < length; i++) {
		counter[0] = i >>> 24;
		counter[1] = (i >>> 16) & 255;
		counter[2] = (i >>> 8) & 255;
		counter[3] = i & 255;
		const block = hash(concatBytes(seed, counter));

		out.set(block.subarray(0, Math.min(block.length, length - at)), at);
		at += block.length;
	}

	return out;
}

const xorInto = (target, mask) => {
	for (let i = 0; i < target.length; i++) target[i] ^= mask[i];
};

// DigestInfo's DER before the digest, by hash (EMSA-PKCS1-v1_5)
const DIGEST_INFO = {
	'SHA-1': '3021300906052b0e03021a05000414',
	'SHA-256': '3031300d060960864801650304020105000420',
	'SHA-384': '3041300d060960864801650304020205000430',
	'SHA-512': '3051300d060960864801650304020305000440'
};

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));

/** EMSA-PKCS1-v1_5: 00 01 FF..FF 00 DigestInfo. */
function pkcs1Encode(key, data) {
	const hashName = key._algorithm.hash.name;
	const t = concatBytes(hexBytes(DIGEST_INFO[hashName]), hashFunction(key._algorithm.hash)(data));
	const k = modulusBytes(key);

	if (k < t.length + 11) throw operationError('RSASSA-PKCS1-v1_5: the key is too short');
	const em = new Uint8Array(k).fill(0xff);

	em[0] = 0;
	em[1] = 1;
	em[k - t.length - 1] = 0;
	em.set(t, k - t.length);

	return em;
}

/** EMSA-PSS-ENCODE with a random salt. */
function pssEncode(key, data, saltLength) {
	const hash = hashFunction(key._algorithm.hash);
	const emBits = key._algorithm.modulusLength - 1;
	const emLen = Math.ceil(emBits / 8);
	const mHash = hash(data);

	if (emLen < mHash.length + saltLength + 2)
		throw operationError('RSA-PSS: the salt is too long for the key');
	const salt = crypto.getRandomValues(new Uint8Array(saltLength));
	const h = hash(concatBytes(new Uint8Array(8), mHash, salt));
	const db = new Uint8Array(emLen - mHash.length - 1);

	db[emLen - saltLength - mHash.length - 2] = 1;
	db.set(salt, db.length - saltLength);
	xorInto(db, mgf1(hash, h, db.length));
	db[0] &= 0xff >> (8 * emLen - emBits);

	return concatBytes(db, h, new Uint8Array([0xbc]));
}

/** EMSA-PSS-VERIFY. */
function pssVerify(key, data, em, saltLength) {
	const hash = hashFunction(key._algorithm.hash);
	const emBits = key._algorithm.modulusLength - 1;
	const emLen = Math.ceil(emBits / 8);
	const mHash = hash(data);
	const hLen = mHash.length;

	if (emLen < hLen + saltLength + 2 || em[em.length - 1] !== 0xbc) return false;
	const db = em.slice(0, emLen - hLen - 1);
	const h = em.subarray(emLen - hLen - 1, emLen - 1);

	if (db[0] & ~(0xff >> (8 * emLen - emBits)) & 0xff) return false;
	xorInto(db, mgf1(hash, h, db.length));
	db[0] &= 0xff >> (8 * emLen - emBits);
	const zeros = emLen - hLen - saltLength - 2;

	for (let i = 0; i < zeros; i++) if (db[i] !== 0) return false;

	if (db[zeros] !== 1) return false;
	const salt = db.subarray(db.length - saltLength);

	return constantTimeEqual(hash(concatBytes(new Uint8Array(8), mHash, salt)), h);
}

/** A signature's integer, or null when it cannot be one for the key. */
function signatureInteger(key, signature) {
	if (signature.length !== modulusBytes(key)) return null;
	const s = toBigInt(signature);

	return s < toBigInt(key._material.n) ? s : null;
}

// --- the algorithms ---

/** The JWK alg for a key of the algorithm and hash. */
function jwkAlg(name, hash) {
	const bits = hash.slice(4);

	if (name === 'RSA-OAEP') return hash === 'SHA-1' ? 'RSA-OAEP' : `RSA-OAEP-${bits}`;

	return `${name === 'RSA-PSS' ? 'PS' : 'RS'}${bits === '1' ? '1' : bits}`;
}

/**
 * Registers one RSA algorithm.
 * @param {string} name
 * @param {string[]} publicUsages
 * @param {string[]} privateUsages
 * @param {Record<string, Function>} operations
 * @param {Record<string, Record<string, string>>} params
 */
function registerRsa(name, publicUsages, privateUsages, operations, params) {
	const use = name === 'RSA-OAEP' ? 'enc' : 'sig';

	function rsaKey(type, hash, extractable, usages, material) {
		const n = material.n;
		// the modulus's bits: its bytes, less the top byte's leading zeros
		const modulusLength = n.length * 8 - (Math.clz32(n[0]) - 24);

		return makeKey(
			type,
			extractable,
			{ name, modulusLength, publicExponent: material.e.slice(), hash: { name: hash.name } },
			usages,
			material
		);
	}

	/** A key generation's exponent (3 or 65537) and modulus length, checked: the exponent. */
	function checkGenerateKey(algorithm) {
		const e = toBigInt(algorithm.publicExponent);

		if (e !== 3n && e !== 65537n)
			throw operationError(`${name}: the public exponent must be 3 or 65537`);
		const { modulusLength } = algorithm;

		if (modulusLength < 256 || modulusLength > 16384 || modulusLength % 8 !== 0)
			throw operationError(`${name}: unsupported modulus length`);

		return e;
	}

	function generateKey(algorithm, extractable, usages) {
		checkUsages(usages, [...publicUsages, ...privateUsages]);
		const { modulusLength } = algorithm;
		const e = checkGenerateKey(algorithm);
		let p;
		let q;
		let n;

		do {
			p = randomPrime(modulusLength / 2, e);
			q = randomPrime(modulusLength / 2, e);
			n = p * q;
		} while (p === q);

		if (p < q) [p, q] = [q, p];
		const d = modInverse(e, (p - 1n) * (q - 1n));
		const material = {
			n: fromBigInt(n),
			e: fromBigInt(e),
			d: fromBigInt(d),
			p: fromBigInt(p),
			q: fromBigInt(q),
			dp: fromBigInt(d % (p - 1n)),
			dq: fromBigInt(d % (q - 1n)),
			qi: fromBigInt(modInverse(q, p))
		};

		return {
			publicKey: rsaKey(
				'public',
				algorithm.hash,
				true,
				usages.filter((usage) => publicUsages.includes(usage)),
				{ n: material.n, e: material.e }
			),
			privateKey: rsaKey(
				'private',
				algorithm.hash,
				extractable,
				usages.filter((usage) => privateUsages.includes(usage)),
				material
			)
		};
	}

	function importJwk(jwk, algorithm, extractable, usages) {
		const isPrivate = jwk.d !== undefined;

		checkUsages(usages, isPrivate ? privateUsages : publicUsages);

		if (jwk.kty !== 'RSA') throw dataError("JWK: kty must be 'RSA'");

		if (jwk.alg !== undefined && jwk.alg !== jwkAlg(name, algorithm.hash.name))
			throw dataError('JWK: alg does not match the algorithm and hash');
		checkJwk(jwk, { kty: 'RSA', use, usages, extractable });

		if (jwk.n === undefined || jwk.e === undefined) throw dataError('JWK: n or e is missing');
		const material = { n: fromBase64url(jwk.n), e: fromBase64url(jwk.e) };

		if (isPrivate) {
			if (jwk.oth !== undefined) throw notSupported('JWK: multi-prime keys are not supported');

			for (const field of PRIVATE_FIELDS) {
				if (jwk[field] === undefined) throw dataError(`JWK: ${field} is missing`);
				material[field] = fromBase64url(jwk[field]);
			}
		}

		if (material.n.length === 0 || material.n[0] === 0 || material.e.length === 0)
			throw dataError('JWK: n or e is not an integer');

		return rsaKey(isPrivate ? 'private' : 'public', algorithm.hash, extractable, usages, material);
	}

	/** An RSAPublicKey or RSAPrivateKey's integers. */
	function parseKey(bytes, isPrivate) {
		const found = derSequence(bytes, []);

		if (found.some((element) => element.tag !== INTEGER))
			throw dataError('The RSA key is malformed');
		const values = found.map((element) => unsignedBytes(element.content));

		if (!isPrivate) {
			if (values.length !== 2) throw dataError('The RSA public key is malformed');

			return { n: values[0], e: values[1] };
		}

		if (values.length !== 9 || values[0].length !== 1 || values[0][0] !== 0)
			throw dataError('The RSA private key is malformed (or has more than two primes)');
		const [, n, e, d, p, q, dp, dq, qi] = values;

		return { n, e, d, p, q, dp, dq, qi };
	}

	/** The algorithm identifier must be rsaEncryption (its parameters NULL, or none). */
	function checkIdentifier(parsed) {
		if (parsed.oid !== RSA_ENCRYPTION) throw dataError('The key is not an RSA key');

		if (
			parsed.params !== undefined &&
			(parsed.params.tag !== NULL || parsed.params.content.length !== 0)
		)
			throw dataError('The RSA key has unexpected parameters');
	}

	function importKey(format, keyData, algorithm, extractable, usages) {
		if (format === 'jwk') return importJwk(keyData, algorithm, extractable, usages);

		if (format === 'spki') {
			checkUsages(usages, publicUsages);
			const parsed = parseSpki(keyData);

			checkIdentifier(parsed);

			return rsaKey('public', algorithm.hash, extractable, usages, parseKey(parsed.key, false));
		}

		if (format === 'pkcs8') {
			checkUsages(usages, privateUsages);
			const parsed = parsePkcs8(keyData);

			checkIdentifier(parsed);

			return rsaKey('private', algorithm.hash, extractable, usages, parseKey(parsed.key, true));
		}

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	function exportKey(format, key) {
		const material = key._material;
		const isPrivate = key._type === 'private';
		const identifier = [derOid(RSA_ENCRYPTION), der(NULL)];

		if (format === 'jwk') {
			const jwk = {
				...jwkCommon(key),
				alg: jwkAlg(name, key._algorithm.hash.name),
				kty: 'RSA',
				n: base64url(material.n),
				e: base64url(material.e)
			};

			if (isPrivate) for (const field of PRIVATE_FIELDS) jwk[field] = base64url(material[field]);

			return jwk;
		}

		if (format === 'spki') {
			if (isPrivate) throw invalidAccess("A private key cannot be exported as 'spki'");

			return spki(identifier, der(SEQUENCE, derUnsigned(material.n), derUnsigned(material.e)))
				.buffer;
		}

		if (format === 'pkcs8') {
			if (!isPrivate) throw invalidAccess("A public key cannot be exported as 'pkcs8'");
			const fields = ['n', 'e', ...PRIVATE_FIELDS].map((field) => derUnsigned(material[field]));

			return pkcs8(identifier, der(SEQUENCE, der(INTEGER, new Uint8Array([0])), ...fields)).buffer;
		}

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	const keyParams = { hash: 'hash!', modulusLength: 'ulong!', publicExponent: 'bigint!' };

	registerAlgorithm({
		name,
		params: { generateKey: keyParams, importKey: { hash: 'hash!' }, ...params },
		generateKey,
		checkGenerateKey,
		importKey,
		exportKey,
		...operations,
		getPublicKey: (key, usages) =>
			rsaKey('public', key._algorithm.hash, true, checkUsages(usages, publicUsages), {
				n: key._material.n,
				e: key._material.e
			})
	});
}

/** A signature: the encoded message through the private key. */
function signWith(encode) {
	return (algorithm, key, data) => {
		if (key._type !== 'private') throw invalidAccess('sign needs a private key');

		return fromBigInt(privateOp(key, toBigInt(encode(algorithm, key, data))), modulusBytes(key));
	};
}

/** The encoded message a signature carries, or null for one that cannot be. */
function openSignature(key, signature) {
	if (key._type !== 'public') throw invalidAccess('verify needs a public key');
	const s = signatureInteger(key, signature);

	return s === null ? null : fromBigInt(publicOp(key, s), modulusBytes(key));
}

registerRsa(
	'RSASSA-PKCS1-v1_5',
	['verify'],
	['sign'],
	{
		sign: signWith((algorithm, key, data) => pkcs1Encode(key, data)),
		verify(algorithm, key, signature, data) {
			const em = openSignature(key, signature);

			return em !== null && constantTimeEqual(em, pkcs1Encode(key, data));
		}
	},
	{ sign: {}, verify: {} }
);

registerRsa(
	'RSA-PSS',
	['verify'],
	['sign'],
	{
		sign: signWith((algorithm, key, data) => pssEncode(key, data, algorithm.saltLength)),
		verify(algorithm, key, signature, data) {
			const em = openSignature(key, signature);

			if (em === null) return false;
			const emLen = Math.ceil((key._algorithm.modulusLength - 1) / 8);

			// the leading byte of k - emLen is zero when emLen is shorter
			if (em.length > emLen && em[0] !== 0) return false;

			return pssVerify(key, data, em.subarray(em.length - emLen), algorithm.saltLength);
		}
	},
	{ sign: { saltLength: 'ulong!' }, verify: { saltLength: 'ulong!' } }
);

registerRsa(
	'RSA-OAEP',
	['encrypt', 'wrapKey'],
	['decrypt', 'unwrapKey'],
	{
		encrypt(algorithm, key, data) {
			if (key._type !== 'public') throw invalidAccess('encrypt needs a public key');
			const hash = hashFunction(key._algorithm.hash);
			const k = modulusBytes(key);
			const lHash = hash(algorithm.label ?? new Uint8Array(0));
			const hLen = lHash.length;

			if (data.length > k - 2 * hLen - 2) throw operationError('RSA-OAEP: the data is too long');
			const db = new Uint8Array(k - hLen - 1);

			db.set(lHash);
			db[db.length - data.length - 1] = 1;
			db.set(data, db.length - data.length);
			const seed = crypto.getRandomValues(new Uint8Array(hLen));

			xorInto(db, mgf1(hash, seed, db.length));
			xorInto(seed, mgf1(hash, db, hLen));
			const em = concatBytes(new Uint8Array(1), seed, db);

			return fromBigInt(publicOp(key, toBigInt(em)), k);
		},
		decrypt(algorithm, key, data) {
			if (key._type !== 'private') throw invalidAccess('decrypt needs a private key');
			const hash = hashFunction(key._algorithm.hash);
			const k = modulusBytes(key);
			const lHash = hash(algorithm.label ?? new Uint8Array(0));
			const hLen = lHash.length;

			if (data.length !== k || k < 2 * hLen + 2)
				throw operationError('RSA-OAEP: decryption failed');
			const c = toBigInt(data);

			if (c >= toBigInt(key._material.n)) throw operationError('RSA-OAEP: decryption failed');
			const em = fromBigInt(privateOp(key, c), k);
			const seed = em.slice(1, 1 + hLen);
			const db = em.slice(1 + hLen);

			xorInto(seed, mgf1(hash, db, hLen));
			xorInto(db, mgf1(hash, seed, db.length));
			let at = hLen;

			while (at < db.length && db[at] === 0) at++;

			if (
				em[0] !== 0 ||
				!constantTimeEqual(db.subarray(0, hLen), lHash) ||
				at >= db.length ||
				db[at] !== 1
			)
				throw operationError('RSA-OAEP: decryption failed');

			return db.slice(at + 1);
		}
	},
	{ encrypt: { label: 'buffer' }, decrypt: { label: 'buffer' } }
);
