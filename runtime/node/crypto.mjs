// node:crypto: random bytes, numbers and UUIDs from the platform's CSPRNG (porffor:random:
// libuv's uv_random natively, wasi:random in a WASI build), hashes and HMACs (createHash,
// createHmac, hash) over @noble/hashes, pbkdf2 and hkdf (noble too), scrypt over Colin
// Percival's C (porffor:scrypt: natively the async form runs on libuv's threadpool), and
// timingSafeEqual. webcrypto / subtle are the runtime's Web Crypto (runtime/crypto.mjs).
//
// Not here: ciphers, signatures and key objects (createCipheriv, createSign, generateKeyPair,
// createPublicKey...): they throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM. SubtleCrypto covers some
// of the same ground.
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_224, sha3_256, sha3_384, sha3_512 } from '@noble/hashes/sha3.js';
import { fill } from 'porffor:random';
import { hash as scryptHash, hashSync as scryptHashSync } from 'porffor:scrypt';
import { Buffer } from './buffer.mjs';
import { crypto as webcrypto } from '../crypto.mjs';

export { webcrypto };

const nextTick = (fn, ...args) => {
	Promise.resolve().then(() => fn(...args));
};

const codeError = (Kind, code, message) => {
	const e = new Kind(message);
	e.code = code;
	return e;
};

const received = (value) =>
	value === null
		? 'null'
		: value === undefined
			? 'undefined'
			: typeof value === 'object'
				? `an instance of ${value.constructor?.name ?? 'Object'}`
				: `type ${typeof value} (${String(value)})`;

const checkCallback = (callback) => {
	if (typeof callback !== 'function')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "callback" argument must be of type function. Received ${received(callback)}`
		);
};

// data a hash, HMAC or KDF takes: a string (in an encoding, UTF-8 by default) or any view's bytes
const inputBytes = (data, encoding, name = 'data') => {
	if (typeof data === 'string') return Buffer.from(data, encoding);
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	throw codeError(
		TypeError,
		'ERR_INVALID_ARG_TYPE',
		`The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${received(data)}`
	);
};

// bytes as a Buffer, or as a string in an encoding (through Buffer's own toString: a .toString
// call on a Buffer is Uint8Array's under Porffor)
const output = (bytes, encoding) => {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return encoding === undefined || encoding === 'buffer'
		? buffer
		: Buffer.prototype.toString.call(buffer, encoding);
};

// ---- randomness ----

/**
 * size random bytes, as a Buffer; with a callback, (error, buffer) a turn later.
 * @param {number} size
 * @param {(error: Error | null, buffer: Buffer) => void} [callback]
 */
export function randomBytes(size, callback) {
	if (typeof size !== 'number' || Number.isNaN(size))
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "size" argument must be of type number. Received ${received(size)}`
		);
	if (size < 0 || size > 2 ** 31 - 1)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${size}`
		);
	const buffer = fill(Buffer.alloc(size));
	if (callback === undefined) return buffer;
	checkCallback(callback);
	nextTick(callback, null, buffer);
	return undefined;
}

export { randomBytes as pseudoRandomBytes, randomBytes as prng, randomBytes as rng };

// a view's bytes from offset (in bytes), size of them
const viewBytes = (buffer, offset, size) => {
	if (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer))
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView. Received ${received(buffer)}`
		);
	const all =
		buffer instanceof ArrayBuffer
			? new Uint8Array(buffer)
			: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	offset ??= 0;
	size ??= all.length - offset;
	if (offset < 0 || offset > all.length)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "offset" is out of range. It must be >= 0 && <= ${all.length}. Received ${offset}`
		);
	if (size < 0 || offset + size > all.length)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "size + offset" is out of range. It must be <= ${all.length}. Received ${offset + size}`
		);
	return all.subarray(offset, offset + size);
};

/** Fills buffer (from offset, size bytes) with random bytes, and returns it. */
export function randomFillSync(buffer, offset, size) {
	fill(viewBytes(buffer, offset, size));
	return buffer;
}

/** randomFillSync, with (error, buffer) passed to the callback (the last argument) a turn later. */
export function randomFill(buffer, offset, size, callback) {
	if (typeof offset === 'function') {
		callback = offset;
		offset = undefined;
	} else if (typeof size === 'function') {
		callback = size;
		size = undefined;
	}
	checkCallback(callback);
	randomFillSync(buffer, offset, size);
	nextTick(callback, null, buffer);
}

/** A random version 4 UUID. */
export const randomUUID = () => crypto.randomUUID();

/** Fills an integer typed array with random values (at most 65536 bytes), and returns it. */
export const getRandomValues = (array) => crypto.getRandomValues(array);

// 2^48: randomInt's range limit, as Node's
const RANGE_LIMIT = 2 ** 48;

/**
 * A random integer in [min, max) (min 0 when only max is given), uniform: draws above the
 * largest multiple of the range are drawn again. With a callback, (error, n) a turn later.
 */
export function randomInt(min, max, callback) {
	if (typeof max === 'function' || max === undefined) {
		callback = max;
		max = min;
		min = 0;
	}
	if (!Number.isSafeInteger(min))
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "min" argument must be a safe integer. Received ${received(min)}`
		);
	if (!Number.isSafeInteger(max))
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "max" argument must be a safe integer. Received ${received(max)}`
		);
	if (max <= min)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`
		);
	const range = max - min;
	if (range > RANGE_LIMIT)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "max - min" is out of range. It must be <= ${RANGE_LIMIT}. Received ${range}`
		);
	const limit = RANGE_LIMIT - (RANGE_LIMIT % range);
	const bytes = new Uint8Array(6);
	let n;
	do {
		fill(bytes);
		n = 0;
		for (let i = 0; i < 6; i++) n = n * 256 + bytes[i];
	} while (n >= limit);
	const out = min + (n % range);
	if (callback === undefined) return out;
	checkCallback(callback);
	nextTick(callback, null, out);
	return undefined;
}

// ---- hashes ----

// the hashes by Node's (OpenSSL's) names
const HASHES = {
	md5,
	sha1,
	ripemd160,
	rmd160: ripemd160,
	sha224,
	sha256,
	sha384,
	sha512,
	'sha512-224': sha512_224,
	'sha512-256': sha512_256,
	'sha3-224': sha3_224,
	'sha3-256': sha3_256,
	'sha3-384': sha3_384,
	'sha3-512': sha3_512
};

const hashFunction = (algorithm) => {
	let name = String(algorithm).toLowerCase();
	if (name.startsWith('rsa-')) name = name.slice(4);
	// the Web Crypto spellings: SHA-256
	if (/^sha-(1|224|256|384|512)$/.test(name)) name = name.replace('-', '');
	const fn = Object.prototype.hasOwnProperty.call(HASHES, name) ? HASHES[name] : undefined;
	if (fn === undefined)
		throw codeError(Error, 'ERR_OSSL_EVP_UNSUPPORTED', 'Digest method not supported');
	return fn;
};

const finalized = () => codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');

/** A running hash: update() with data, digest() once. */
export class Hash {
	constructor(algorithm, state) {
		this._state = state ?? hashFunction(algorithm).create();
		this._algorithm = algorithm;
		this._done = false;
	}

	/** Adds data (a string in inputEncoding, UTF-8 by default, or bytes). */
	update(data, inputEncoding) {
		if (this._done) throw finalized();
		this._state.update(inputBytes(data, inputEncoding));
		return this;
	}

	/** The hash: a Buffer, or a string in encoding (hex, base64, ...). */
	digest(encoding) {
		if (this._done) throw finalized();
		this._done = true;
		return output(this._state.digest(), encoding);
	}

	/** A copy of this hash as it is now, to go on with separately. */
	copy() {
		if (this._done) throw finalized();
		return new Hash(this._algorithm, this._state.clone());
	}
}

/** A hash of an algorithm (md5, sha1, sha256, sha512, sha3-256, ...). */
export const createHash = (algorithm) => new Hash(algorithm);

/** data's hash in one call: a string in outputEncoding (hex by default) or a Buffer. */
export const hash = (algorithm, data, outputEncoding = 'hex') =>
	output(hashFunction(algorithm)(inputBytes(data)), outputEncoding);

/** A running HMAC with key: update() with data, digest() once. */
export class Hmac {
	constructor(algorithm, key) {
		const keyBytes =
			key?.type === 'secret' && typeof key.export === 'function'
				? key.export()
				: inputBytes(key, undefined, 'key');
		this._state = hmac.create(hashFunction(algorithm), keyBytes);
		this._done = false;
	}

	update(data, inputEncoding) {
		if (this._done) throw finalized();
		this._state.update(inputBytes(data, inputEncoding));
		return this;
	}

	digest(encoding) {
		if (this._done) throw finalized();
		this._done = true;
		return output(this._state.digest(), encoding);
	}
}

/** An HMAC of an algorithm with a key (a string, bytes, or a secret KeyObject). */
export const createHmac = (algorithm, key) => new Hmac(algorithm, key);

/** The hash algorithms createHash knows. */
export const getHashes = () => Object.keys(HASHES).sort();
export const getCiphers = () => [];
export const getCurves = () => [];

// ---- comparison ----

/** Whether a and b (same-length bytes) are equal, in time that does not depend on where they differ. */
export function timingSafeEqual(a, b) {
	const x = inputBytes(a, undefined, 'buf1');
	const y = inputBytes(b, undefined, 'buf2');
	if (x.byteLength !== y.byteLength)
		throw codeError(
			RangeError,
			'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
			'Input buffers must have the same byte length'
		);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}

// ---- key derivation ----

/** PBKDF2 of password with salt: keylen bytes, as a Buffer. */
export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
	if (typeof digest !== 'string')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "digest" argument must be of type string. Received ${received(digest)}`
		);
	if (!Number.isInteger(iterations) || iterations < 1)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "iterations" is out of range. It must be >= 1 && <= 2147483647. Received ${iterations}`
		);
	if (!Number.isInteger(keylen) || keylen < 0)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "keylen" is out of range. It must be >= 0 && <= 2147483647. Received ${keylen}`
		);
	const key = noblePbkdf2(
		hashFunction(digest),
		inputBytes(password, undefined, 'password'),
		inputBytes(salt, undefined, 'salt'),
		{
			c: iterations,
			dkLen: keylen
		}
	);
	return output(key);
}

/** pbkdf2Sync, its key passed to callback(error, key) a turn later. */
export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
	checkCallback(callback);
	const key = pbkdf2Sync(password, salt, iterations, keylen, digest);
	nextTick(callback, null, key);
}

/** HKDF of a key with salt and info: keylen bytes, as an ArrayBuffer. */
export function hkdfSync(digest, key, salt, info, keylen) {
	const out = nobleHkdf(
		hashFunction(digest),
		inputBytes(key, undefined, 'ikm'),
		inputBytes(salt, undefined, 'salt'),
		inputBytes(info, undefined, 'info'),
		keylen
	);
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/** hkdfSync, its key passed to callback(error, arrayBuffer) a turn later. */
export function hkdf(digest, key, salt, info, keylen, callback) {
	checkCallback(callback);
	const out = hkdfSync(digest, key, salt, info, keylen);
	nextTick(callback, null, out);
}

// scrypt's defaults, as Node's: N 16384, r 8, p 1, and at most 32 MiB of memory
const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

const scryptParams = (options = {}) => {
	const pick = (a, b, name) => {
		if (options[a] !== undefined && options[b] !== undefined)
			throw codeError(
				TypeError,
				'ERR_INCOMPATIBLE_OPTION_PAIR',
				`Option "${a}" cannot be used in combination with option "${b}"`
			);
		return options[a] ?? options[b] ?? SCRYPT_DEFAULTS[name];
	};
	const N = pick('N', 'cost', 'N');
	const r = pick('r', 'blockSize', 'r');
	const p = pick('p', 'parallelization', 'p');
	const maxmem = options.maxmem ?? SCRYPT_DEFAULTS.maxmem;
	// N a power of two above 1; the work buffers (128 r (N + p) bytes) within maxmem
	const invalid = codeError(
		RangeError,
		'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
		'Invalid scrypt params: memory limit exceeded'
	);
	if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || !(r >= 1) || !(p >= 1)) {
		invalid.message = 'Invalid scrypt params';
		throw invalid;
	}
	if (128 * r * (N + p + 2) > maxmem) throw invalid;
	return { N, r, p };
};

const checkKeylen = (keylen) => {
	if (typeof keylen !== 'number')
		throw codeError(
			TypeError,
			'ERR_INVALID_ARG_TYPE',
			`The "keylen" argument must be of type number. Received ${received(keylen)}`
		);
	if (!Number.isInteger(keylen) || keylen < 0 || keylen > 2147483647)
		throw codeError(
			RangeError,
			'ERR_OUT_OF_RANGE',
			`The value of "keylen" is out of range. It must be >= 0 && <= 2147483647. Received ${keylen}`
		);
};

// a copy of the bytes: the hash may read them after the caller's next change to its own
const ownBytes = (data, name) => Uint8Array.from(inputBytes(data, undefined, name));

/** scrypt of password with salt: keylen bytes, as a Buffer (options N/cost, r/blockSize, p/parallelization, maxmem). */
export function scryptSync(password, salt, keylen, options) {
	checkKeylen(keylen);
	const { N, r, p } = scryptParams(options);
	const out = Buffer.alloc(keylen);
	if (scryptHashSync(ownBytes(password, 'password'), ownBytes(salt, 'salt'), N, r, p, out) !== 0)
		throw codeError(Error, 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', 'Invalid scrypt parameter');
	return out;
}

/**
 * scryptSync, off the loop natively (libuv's threadpool): callback(error, key) when it is done.
 */
export function scrypt(password, salt, keylen, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = undefined;
	}
	checkCallback(callback);
	checkKeylen(keylen);
	const { N, r, p } = scryptParams(options);
	const out = Buffer.alloc(keylen);
	scryptHash(ownBytes(password, 'password'), ownBytes(salt, 'salt'), N, r, p, out).then(
		(rc) =>
			rc === 0
				? callback(null, out)
				: callback(
						codeError(Error, 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER', 'Invalid scrypt parameter')
					),
		(error) => callback(error)
	);
}

// ---- what is not here ----

const unavailable = (name) => () => {
	throw codeError(
		Error,
		'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
		`crypto.${name} is not available in Porffor's runtime (use crypto.subtle)`
	);
};

export const createCipheriv = unavailable('createCipheriv');
export const createDecipheriv = unavailable('createDecipheriv');
export const createSign = unavailable('createSign');
export const createVerify = unavailable('createVerify');
export const sign = unavailable('sign');
export const verify = unavailable('verify');
export const generateKeyPair = unavailable('generateKeyPair');
export const generateKeyPairSync = unavailable('generateKeyPairSync');
export const generateKey = unavailable('generateKey');
export const generateKeySync = unavailable('generateKeySync');
export const createPublicKey = unavailable('createPublicKey');
export const createPrivateKey = unavailable('createPrivateKey');
export const createSecretKey = unavailable('createSecretKey');
export const createECDH = unavailable('createECDH');
export const createDiffieHellman = unavailable('createDiffieHellman');
export const publicEncrypt = unavailable('publicEncrypt');
export const privateDecrypt = unavailable('privateDecrypt');

/** The Web Crypto SubtleCrypto (runtime/subtle-crypto.mjs). */
export const subtle = webcrypto.subtle;

export const constants = {};

export default {
	webcrypto,
	subtle,
	randomBytes,
	pseudoRandomBytes: randomBytes,
	randomFillSync,
	randomFill,
	randomUUID,
	randomInt,
	getRandomValues,
	createHash,
	hash,
	createHmac,
	Hash,
	Hmac,
	getHashes,
	getCiphers,
	getCurves,
	timingSafeEqual,
	pbkdf2,
	pbkdf2Sync,
	hkdf,
	hkdfSync,
	scrypt,
	scryptSync,
	createCipheriv,
	createDecipheriv,
	createSign,
	createVerify,
	sign,
	verify,
	generateKeyPair,
	generateKeyPairSync,
	generateKey,
	generateKeySync,
	createPublicKey,
	createPrivateKey,
	createSecretKey,
	createECDH,
	createDiffieHellman,
	publicEncrypt,
	privateDecrypt,
	constants
};
