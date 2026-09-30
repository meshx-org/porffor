// SubtleCrypto (https://w3c.github.io/webcrypto/#subtlecrypto-interface), in JavaScript over
// @noble. Each method follows the spec's steps: WebIDL conversion of its arguments, "normalize an
// algorithm" against the registered algorithms, then the checks on the key and the operation.
// Every method returns a promise, and a failure is a rejection, never a throw.
//
// Pay for use: only the SHA digests live here. Every other algorithm is a module of its own
// (crypto-aes.mjs, crypto-ec.mjs, ...) that registers itself (registerAlgorithm) when loaded,
// and runtime/globals.json loads it only into a program whose text names it ('AES-GCM'), so a
// program that only digests carries no cipher, curve or RSA code. An algorithm whose module is
// not loaded is unknown: NotSupportedError, as for any unknown name.

import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { CryptoKey } from './crypto-key.mjs';
import {
	asciiUpper,
	dataError,
	enforceRange,
	idlJwk,
	idlString,
	idlUsages,
	invalidAccess,
	isBufferSource,
	notSupported,
	syntaxError,
	toBuffer,
	toBytes
} from './crypto-util.mjs';

// (see blob.mjs's TAG)
const TAG = 'SubtleCrypto';

/**
 * The registered algorithms, by their name in upper case. A function's property, not a module
 * constant: the WASI build injects each algorithm module (esbuild `inject`), and esbuild runs a
 * side-effect-only injected module before the modules it imports, so an algorithm may register
 * before this module's own top level has run; a hoisted function is already there.
 * @returns {Map<string, object>}
 */
function algorithms() {
	algorithms.map ??= new Map();

	return algorithms.map;
}

/**
 * Registers an algorithm: its name, the parameters each operation it supports takes, and the
 * operations themselves (generateKey, importKey, exportKey, encrypt, decrypt, sign, verify,
 * digest, deriveBits, getKeyLength, wrapKey, unwrapKey, getPublicKey).
 *
 * `params[operation]` is the dictionary the operation's algorithm converts to: member names
 * to their WebIDL type ('octet', 'ushort', 'ulong', 'buffer', 'hash', 'string', 'bigint',
 * 'key'), with a trailing '!' for a required member. {} is plain Algorithm.
 * @param {{ name: string, params: Record<string, Record<string, string>> }} definition
 */
export function registerAlgorithm(definition) {
	algorithms().set(asciiUpper(definition.name), definition);
}

/** The registered algorithm of a name (any case), or undefined. */
const registered = (name) => algorithms().get(asciiUpper(name));

/** The registered algorithm of a key (it was made by one, so it is loaded). */
const keyAlgorithm = (key) => registered(key._algorithm.name);

/** A dictionary member converted to its WebIDL type. */
function convertMember(value, type, member) {
	switch (type) {
		case 'octet':
			return enforceRange(value, 255, member);
		case 'ushort':
			return enforceRange(value, 65535, member);
		case 'ulong':
			return enforceRange(value, 4294967295, member);
		case 'string':
			return idlString(value);
		case 'buffer':
			if (!isBufferSource(value)) throw new TypeError(`${member} is not a BufferSource`);

			return value;
		case 'bigint':
			if (!(value instanceof Uint8Array)) throw new TypeError(`${member} is not a Uint8Array`);

			return value;
		case 'key':
			if (!(value instanceof CryptoKey)) throw new TypeError(`${member} is not a CryptoKey`);

			return value;
		default:
			// 'hash' (a HashAlgorithmIdentifier: an object, or else a string), normalized after
			return typeof value === 'object' || typeof value === 'function' ? value : idlString(value);
	}
}

/**
 * "Normalize an algorithm" (https://w3c.github.io/webcrypto/#algorithm-normalization-normalize-an-algorithm):
 * the registered algorithm for the operation, its parameters converted, BufferSources copied
 * and hashes normalized. NotSupportedError for an unknown name, TypeError for bad parameters.
 * @param {unknown} algorithm an AlgorithmIdentifier
 * @param {string} operation
 * @returns {{ name: string }}
 */
export function normalizeAlgorithm(algorithm, operation) {
	// (object or DOMString): anything but an object is a name
	const given =
		algorithm !== null && (typeof algorithm === 'object' || typeof algorithm === 'function')
			? algorithm
			: { name: idlString(algorithm) };
	const rawName = given.name;

	if (rawName === undefined) throw new TypeError('Algorithm: name is missing');
	const definition = registered(idlString(rawName));
	const params = definition?.params[operation];

	if (params === undefined) throw notSupported(`${operation}: unsupported algorithm`);
	const normalized = { name: definition.name };
	// the dictionary's members in lexicographic order, after Algorithm's name (read once, as
	// browsers do: a getter on it runs once)
	const members = Object.keys(params).sort();

	for (const member of members) {
		const type = params[member];
		const value = given[member];

		if (value === undefined) {
			if (type.endsWith('!')) throw new TypeError(`Algorithm: ${member} is missing`);
			continue;
		}
		normalized[member] = convertMember(value, type.replace('!', ''), member);
	}

	for (const member of members) {
		if (!(member in normalized)) continue;
		const type = params[member].replace('!', '');

		if (type === 'buffer') normalized[member] = toBytes(normalized[member]);
		else if (type === 'hash') normalized[member] = normalizeAlgorithm(normalized[member], 'digest');
	}

	return normalized;
}

/** Throws unless the key is of the algorithm and allows the usage. */
function checkKey(key, name, usage) {
	if (key._algorithm.name !== name)
		throw invalidAccess(`The key is not for ${name} (it is for ${key._algorithm.name})`);

	if (!key._usages.includes(usage)) throw invalidAccess(`The key does not allow ${usage}`);
}

/** Throws a TypeError unless the value is a CryptoKey. */
function requireKey(value, what = 'key') {
	if (!(value instanceof CryptoKey)) throw new TypeError(`${what} is not a CryptoKey`);

	return value;
}

/** Throws a TypeError unless the value is a BufferSource. */
function requireBuffer(value, what = 'data') {
	if (!isBufferSource(value)) throw new TypeError(`${what} is not a BufferSource`);

	return value;
}

/** The key formats (KeyFormat): a TypeError for any other. */
const FORMATS = [
	'raw',
	'spki',
	'pkcs8',
	'jwk',
	'raw-public',
	'raw-private',
	'raw-seed',
	'raw-secret'
];

function idlFormat(value) {
	const format = idlString(value);

	if (!FORMATS.includes(format)) throw new TypeError(`'${format}' is not a KeyFormat`);

	return format;
}

/** A new key or key pair must be usable: a secret or private key with no usages is a SyntaxError. */
function checkUsable(result) {
	const key = result instanceof CryptoKey ? result : result.privateKey;

	if ((key._type === 'secret' || key._type === 'private') && key._usages.length === 0)
		throw syntaxError('Usages cannot be empty');

	return result;
}

/** The operation of the registered algorithm, or a NotSupportedError. */
function operation(definition, name) {
	const run = definition?.[name];

	if (typeof run !== 'function') throw notSupported(`${name} is not supported for this key`);

	return run;
}

/** importKey after its arguments are converted and its algorithm normalized. */
function importNormalized(format, keyData, normalized, extractable, usages) {
	const definition = registered(normalized.name);

	return checkUsable(
		operation(definition, 'importKey')(format, keyData, normalized, extractable, usages)
	);
}

/** exportKey's checks and the export: NotSupportedError before InvalidAccessError. */
function exportChecked(format, key) {
	const run = operation(keyAlgorithm(key), 'exportKey');

	if (!key._extractable) throw invalidAccess('The key is not extractable');

	return run(format, key);
}

/** A JWK's bytes, as wrapKey wraps it: its JSON in UTF-8. */
const jwkBytes = (jwk) => new TextEncoder().encode(JSON.stringify(jwk));

/** Unwrapped bytes as a JWK: a DataError unless they are JSON of one. */
function parseJwk(bytes) {
	let parsed;

	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw dataError('The unwrapped key is not JSON');
	}

	return idlJwk(parsed);
}

/** The algorithm normalized for the first operation it supports (wrapKey, else encrypt). */
function normalizeEither(algorithm, first, second) {
	try {
		return { normalized: normalizeAlgorithm(algorithm, first), operation: first };
	} catch (error) {
		if (error?.name !== 'NotSupportedError') throw error;

		return { normalized: normalizeAlgorithm(algorithm, second), operation: second };
	}
}

/** Cryptographic primitives: hashing, keys, signatures, encryption, key derivation. */
export class SubtleCrypto {
	/**
	 * The digest of data.
	 * @param {AlgorithmIdentifier} algorithm 'SHA-1', 'SHA-256', 'SHA-384' or 'SHA-512'
	 * @param {BufferSource} data
	 * @returns {Promise<ArrayBuffer>}
	 */
	async digest(algorithm, data) {
		requireBuffer(data);
		const normalized = normalizeAlgorithm(algorithm, 'digest');
		const bytes = toBytes(data);

		return toBuffer(registered(normalized.name).digest(normalized, bytes));
	}

	/**
	 * Data encrypted under a key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async encrypt(algorithm, key, data) {
		requireKey(key);
		requireBuffer(data);
		const normalized = normalizeAlgorithm(algorithm, 'encrypt');
		// copied after normalizing: a getter on the algorithm may change the bytes until then
		const bytes = toBytes(data);

		checkKey(key, normalized.name, 'encrypt');

		return toBuffer(registered(normalized.name).encrypt(normalized, key, bytes));
	}

	/**
	 * Data decrypted under a key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async decrypt(algorithm, key, data) {
		requireKey(key);
		requireBuffer(data);
		const normalized = normalizeAlgorithm(algorithm, 'decrypt');
		// copied after normalizing: a getter on the algorithm may change the bytes until then
		const bytes = toBytes(data);

		checkKey(key, normalized.name, 'decrypt');

		return toBuffer(registered(normalized.name).decrypt(normalized, key, bytes));
	}

	/**
	 * The signature (HMAC: the MAC) of data under the key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async sign(algorithm, key, data) {
		requireKey(key);
		requireBuffer(data);
		const normalized = normalizeAlgorithm(algorithm, 'sign');
		// copied after normalizing: a getter on the algorithm may change the bytes until then
		const bytes = toBytes(data);

		checkKey(key, normalized.name, 'sign');

		return toBuffer(registered(normalized.name).sign(normalized, key, bytes));
	}

	/**
	 * Whether signature is data's under the key.
	 * @returns {Promise<boolean>}
	 */
	async verify(algorithm, key, signature, data) {
		requireKey(key);
		requireBuffer(signature, 'signature');
		requireBuffer(data);
		const normalized = normalizeAlgorithm(algorithm, 'verify');
		const signatureBytes = toBytes(signature);
		const bytes = toBytes(data);

		checkKey(key, normalized.name, 'verify');

		return registered(normalized.name).verify(normalized, key, signatureBytes, bytes);
	}

	/**
	 * A new key, or key pair.
	 * @returns {Promise<CryptoKey | { publicKey: CryptoKey, privateKey: CryptoKey }>}
	 */
	async generateKey(algorithm, extractable, keyUsages) {
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const normalized = normalizeAlgorithm(algorithm, 'generateKey');

		return checkUsable(registered(normalized.name).generateKey(normalized, exportable, usages));
	}

	/**
	 * Bits derived from a base key.
	 * @param {number | null} [length] in bits
	 * @returns {Promise<ArrayBuffer>}
	 */
	async deriveBits(algorithm, baseKey, length = null) {
		requireKey(baseKey, 'baseKey');
		const bits =
			length === null || length === undefined ? null : enforceRange(length, 4294967295, 'length');
		const normalized = normalizeAlgorithm(algorithm, 'deriveBits');

		checkKey(baseKey, normalized.name, 'deriveBits');

		return toBuffer(registered(normalized.name).deriveBits(normalized, baseKey, bits));
	}

	/**
	 * A key derived from a base key, for the algorithm derivedKeyType names.
	 * @returns {Promise<CryptoKey>}
	 */
	async deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages) {
		requireKey(baseKey, 'baseKey');
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const normalized = normalizeAlgorithm(algorithm, 'deriveBits');
		const importAlgorithm = normalizeAlgorithm(derivedKeyType, 'importKey');
		const lengthAlgorithm = normalizeAlgorithm(derivedKeyType, 'getKeyLength');

		checkKey(baseKey, normalized.name, 'deriveKey');
		const length = registered(lengthAlgorithm.name).getKeyLength(lengthAlgorithm);
		const secret = registered(normalized.name).deriveBits(normalized, baseKey, length);

		return importNormalized('raw-secret', secret, importAlgorithm, exportable, usages);
	}

	/**
	 * A key from its bytes or a JWK.
	 * @param {KeyFormat} format
	 * @returns {Promise<CryptoKey>}
	 */
	async importKey(format, keyData, algorithm, extractable, keyUsages) {
		const keyFormat = idlFormat(format);
		// (BufferSource or JsonWebKey): a buffer as it is, anything else a JsonWebKey
		const data = isBufferSource(keyData) ? keyData : idlJwk(keyData);
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const normalized = normalizeAlgorithm(algorithm, 'importKey');
		let material;

		if (keyFormat === 'jwk') {
			if (isBufferSource(data)) throw new TypeError('A JWK import takes a JsonWebKey');
			material = data;
		} else {
			if (!isBufferSource(data))
				throw new TypeError(`A '${keyFormat}' import takes a BufferSource`);
			// copied after normalizing: a getter on the algorithm may change the bytes until then
			material = toBytes(data);
		}

		return importNormalized(keyFormat, material, normalized, exportable, usages);
	}

	/**
	 * An extractable key's bytes (an ArrayBuffer) or JWK (an object).
	 * @param {KeyFormat} format
	 * @param {CryptoKey} key
	 */
	async exportKey(format, key) {
		const keyFormat = idlFormat(format);

		requireKey(key);

		return exportChecked(keyFormat, key);
	}

	/**
	 * A key exported and encrypted under a wrapping key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
		const keyFormat = idlFormat(format);

		requireKey(key);
		requireKey(wrappingKey, 'wrappingKey');
		const { normalized, operation: op } = normalizeEither(wrapAlgorithm, 'wrapKey', 'encrypt');

		checkKey(wrappingKey, normalized.name, 'wrapKey');
		const exported = exportChecked(keyFormat, key);
		const bytes = keyFormat === 'jwk' ? jwkBytes(exported) : new Uint8Array(exported);

		return toBuffer(registered(normalized.name)[op](normalized, wrappingKey, bytes));
	}

	/**
	 * A key decrypted with an unwrapping key and imported.
	 * @returns {Promise<CryptoKey>}
	 */
	async unwrapKey(
		format,
		wrappedKey,
		unwrappingKey,
		unwrapAlgorithm,
		unwrappedKeyAlgorithm,
		extractable,
		keyUsages
	) {
		const keyFormat = idlFormat(format);

		requireBuffer(wrappedKey, 'wrappedKey');
		requireKey(unwrappingKey, 'unwrappingKey');
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const { normalized, operation: op } = normalizeEither(unwrapAlgorithm, 'unwrapKey', 'decrypt');
		const importAlgorithm = normalizeAlgorithm(unwrappedKeyAlgorithm, 'importKey');
		const bytes = toBytes(wrappedKey);

		checkKey(unwrappingKey, normalized.name, 'unwrapKey');
		const unwrapper = registered(normalized.name);
		const unwrapped = unwrapper[op](normalized, unwrappingKey, bytes);
		const material = keyFormat === 'jwk' ? parseJwk(unwrapped) : unwrapped;

		return importNormalized(keyFormat, material, importAlgorithm, exportable, usages);
	}

	/**
	 * A shared secret and its ciphertext, for an encapsulation (public) key (the Modern
	 * Algorithms draft's KEMs).
	 * @returns {Promise<{ sharedKey: ArrayBuffer, ciphertext: ArrayBuffer }>}
	 */
	async encapsulateBits(algorithm, encapsulationKey) {
		requireKey(encapsulationKey, 'encapsulationKey');
		const normalized = normalizeAlgorithm(algorithm, 'encapsulate');

		checkKey(encapsulationKey, normalized.name, 'encapsulateBits');
		const result = registered(normalized.name).encapsulate(normalized, encapsulationKey);

		return { sharedKey: toBuffer(result.sharedKey), ciphertext: toBuffer(result.ciphertext) };
	}

	/**
	 * A shared key, imported for sharedKeyAlgorithm, and its ciphertext.
	 * @returns {Promise<{ sharedKey: CryptoKey, ciphertext: ArrayBuffer }>}
	 */
	async encapsulateKey(algorithm, encapsulationKey, sharedKeyAlgorithm, extractable, keyUsages) {
		requireKey(encapsulationKey, 'encapsulationKey');
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const normalized = normalizeAlgorithm(algorithm, 'encapsulate');
		const importAlgorithm = normalizeAlgorithm(sharedKeyAlgorithm, 'importKey');

		checkKey(encapsulationKey, normalized.name, 'encapsulateKey');
		const result = registered(normalized.name).encapsulate(normalized, encapsulationKey);
		const sharedKey = importNormalized(
			'raw-secret',
			result.sharedKey,
			importAlgorithm,
			exportable,
			usages
		);

		return { sharedKey, ciphertext: toBuffer(result.ciphertext) };
	}

	/**
	 * The shared secret a ciphertext carries, with a decapsulation (private) key.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async decapsulateBits(algorithm, decapsulationKey, ciphertext) {
		requireKey(decapsulationKey, 'decapsulationKey');
		requireBuffer(ciphertext, 'ciphertext');
		const normalized = normalizeAlgorithm(algorithm, 'decapsulate');
		const bytes = toBytes(ciphertext);

		checkKey(decapsulationKey, normalized.name, 'decapsulateBits');

		return toBuffer(registered(normalized.name).decapsulate(normalized, decapsulationKey, bytes));
	}

	/**
	 * The shared key a ciphertext carries, imported for sharedKeyAlgorithm.
	 * @returns {Promise<CryptoKey>}
	 */
	async decapsulateKey(
		algorithm,
		decapsulationKey,
		ciphertext,
		sharedKeyAlgorithm,
		extractable,
		keyUsages
	) {
		requireKey(decapsulationKey, 'decapsulationKey');
		requireBuffer(ciphertext, 'ciphertext');
		const exportable = Boolean(extractable);
		const usages = idlUsages(keyUsages);
		const normalized = normalizeAlgorithm(algorithm, 'decapsulate');
		const importAlgorithm = normalizeAlgorithm(sharedKeyAlgorithm, 'importKey');
		const bytes = toBytes(ciphertext);

		checkKey(decapsulationKey, normalized.name, 'decapsulateKey');
		const secret = registered(normalized.name).decapsulate(normalized, decapsulationKey, bytes);

		return importNormalized('raw-secret', secret, importAlgorithm, exportable, usages);
	}

	/**
	 * The public key of a private key (Modern Algorithms in WebCrypto's getPublicKey).
	 * @param {CryptoKey} key
	 * @param {KeyUsage[]} keyUsages
	 * @returns {Promise<CryptoKey>}
	 */
	async getPublicKey(key, keyUsages) {
		requireKey(key);
		const usages = idlUsages(keyUsages);
		const run = operation(keyAlgorithm(key), 'getPublicKey');

		if (key._type !== 'private') throw invalidAccess('The key is not a private key');

		return run(key, usages);
	}

	/**
	 * Whether this runtime supports the operation with the algorithm (the Modern Algorithms
	 * draft's static supports): the algorithm normalizes for it, and its parameters are ones
	 * the operation takes. An algorithm whose module the program did not load is not supported.
	 * @param {string} operation
	 * @param {AlgorithmIdentifier} algorithm
	 * @param {number | AlgorithmIdentifier | null} [lengthOrAdditionalAlgorithm]
	 * @returns {boolean}
	 */
	static supports(operation, algorithm, lengthOrAdditionalAlgorithm = null) {
		try {
			return checkSupport(idlString(operation), algorithm, lengthOrAdditionalAlgorithm);
		} catch {
			return false;
		}
	}

	get [Symbol.toStringTag]() {
		return TAG;
	}
}

const OPERATIONS = [
	'encrypt',
	'decrypt',
	'sign',
	'verify',
	'digest',
	'generateKey',
	'deriveKey',
	'deriveBits',
	'importKey',
	'exportKey',
	'wrapKey',
	'unwrapKey',
	'getPublicKey',
	'encapsulateKey',
	'encapsulateBits',
	'decapsulateKey',
	'decapsulateBits'
];

/** An algorithm's own check for supports, if it has that one: throws for what it would refuse. */
function runCheck(definition, check, ...args) {
	if (typeof definition[check] === 'function') definition[check](...args);
}

/** supports' check: throws, or returns false, for anything unsupported. */
function checkSupport(name, algorithm, extra) {
	if (!OPERATIONS.includes(name)) return false;

	if (name === 'exportKey' || name === 'getPublicKey') {
		const given = typeof algorithm === 'string' ? algorithm : algorithm?.name;
		const definition = registered(idlString(given));

		return typeof definition?.[name] === 'function';
	}

	if (name === 'deriveKey') {
		const normalized = normalizeAlgorithm(algorithm, 'deriveBits');
		const importAlgorithm = normalizeAlgorithm(extra, 'importKey');
		const lengthAlgorithm = normalizeAlgorithm(extra, 'getKeyLength');
		const length = registered(lengthAlgorithm.name).getKeyLength(lengthAlgorithm);

		runCheck(registered(normalized.name), 'checkDerive', normalized, length);
		runCheck(registered(importAlgorithm.name), 'checkImport', importAlgorithm);

		return true;
	}

	if (name === 'wrapKey' || name === 'unwrapKey') {
		normalizeEither(algorithm, name, name === 'wrapKey' ? 'encrypt' : 'decrypt');

		return true;
	}
	if (name.startsWith('encapsulate') || name.startsWith('decapsulate')) {
		normalizeAlgorithm(algorithm, name.slice(0, 11));

		// the shared key: an algorithm that imports 'raw-secret' bytes of a KEM's 256 bits
		if (name.endsWith('Key')) {
			const importAlgorithm = normalizeAlgorithm(extra, 'importKey');
			const check = registered(importAlgorithm.name).checkSecret;

			if (typeof check !== 'function') return false;
			check(importAlgorithm, 256);
		}

		return true;
	}
	const normalized = normalizeAlgorithm(algorithm, name);
	const definition = registered(normalized.name);

	// the parameters the operation would refuse (a key length, a curve, an iv, a derived length),
	// checked without a key: each algorithm's own checks, those it has
	if (name === 'generateKey') runCheck(definition, 'checkGenerateKey', normalized);
	else if (name === 'importKey') runCheck(definition, 'checkImport', normalized);
	else if (name === 'deriveBits')
		runCheck(definition, 'checkDerive', normalized, typeof extra === 'number' ? extra : null);
	else runCheck(definition, 'checkParams', name, normalized);

	return true;
}

// The SHA digests: here, since any program using SubtleCrypto may digest (and the algorithms
// with a hash parameter need them)
const DIGESTS = { 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 };

for (const name of Object.keys(DIGESTS))
	registerAlgorithm({
		name,
		params: { digest: {} },
		digest: (algorithm, data) => DIGESTS[name](data)
	});

/** The hash function a normalized hash algorithm names (the SHA digests registered here). */
export const hashFunction = (hash) => DIGESTS[hash.name];
