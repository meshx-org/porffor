// What the Octet Key Pair algorithms share (https://wicg.github.io/webcrypto-secure-curves/:
// Ed25519, Ed448, X25519, X448): key generation, the key formats ('raw', 'raw-public', 'spki',
// 'pkcs8', 'jwk' kty OKP) and the ECDH-style deriveBits of X25519 and X448. Each curve's own
// module (crypto-ed25519.mjs, crypto-x25519.mjs, crypto-ed448.mjs) brings its math and
// registers through registerOkp. A private key's material is its secret bytes (the seed); a
// public key's, the encoded point.

import { makeKey } from './crypto-key.mjs';
import {
	OCTET_STRING,
	der,
	derExpect,
	derOid,
	parsePkcs8,
	parseSpki,
	pkcs8,
	spki
} from './crypto-der.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	constantTimeEqual,
	dataError,
	fromBase64url,
	invalidAccess,
	jwkCommon,
	notSupported,
	operationError,
	truncateBits
} from './crypto-util.mjs';
import { registerAlgorithm } from './subtle-crypto.mjs';

/**
 * @typedef {object} OkpCurve
 * @property {string} name 'Ed25519', 'X25519', ...
 * @property {string} oid its algorithm identifier (RFC 8410)
 * @property {number} length the bytes of a key (public and private alike)
 * @property {(secret: Uint8Array) => Uint8Array} publicKey the public key of a secret
 * @property {Record<string, (...args: unknown[]) => unknown>} [operations] sign and verify, for a signature curve
 * @property {(secret: Uint8Array, point: Uint8Array) => Uint8Array} [sharedSecret] for a key agreement curve
 * @property {Record<string, Record<string, string>>} [params] the parameters of sign and verify
 */

/**
 * Registers an OKP algorithm with SubtleCrypto.
 * @param {OkpCurve} curve
 */
export function registerOkp(curve) {
	const signs = curve.sharedSecret === undefined;
	// what each kind of key may be used for
	const publicUsages = signs ? ['verify'] : [];
	const privateUsages = signs ? ['sign'] : ['deriveKey', 'deriveBits'];
	const algorithm = { name: curve.name };

	const okpKey = (type, extractable, usages, material) =>
		makeKey(type, extractable, algorithm, usages, material);

	/** A public key's bytes, checked. */
	function publicBytes(bytes) {
		if (bytes.length !== curve.length)
			throw dataError(`${curve.name}: the public key is not ${curve.length} bytes`);

		return bytes;
	}

	/** A private key's bytes, checked. */
	function privateBytes(bytes) {
		if (bytes.length !== curve.length)
			throw dataError(`${curve.name}: the private key is not ${curve.length} bytes`);

		return bytes;
	}

	/** The algorithm identifier of spki and pkcs8 must be this curve's, with no parameters. */
	function checkIdentifier(parsed) {
		if (parsed.oid !== curve.oid || parsed.params !== undefined)
			throw dataError(`The key is not a ${curve.name} key`);
	}

	function importJwk(jwk, extractable, usages) {
		const isPrivate = jwk.d !== undefined;

		checkUsages(usages, isPrivate ? privateUsages : publicUsages);

		if (jwk.kty !== 'OKP') throw dataError("JWK: kty must be 'OKP'");

		if (jwk.crv !== curve.name) throw dataError(`JWK: crv must be '${curve.name}'`);

		// (X25519 and X448 ignore alg; the signature curves take their name, or EdDSA)
		if (signs && jwk.alg !== undefined && jwk.alg !== curve.name && jwk.alg !== 'EdDSA')
			throw dataError(`JWK: alg does not match ${curve.name}`);
		checkJwk(jwk, { kty: 'OKP', use: signs ? 'sig' : 'enc', usages, extractable });

		if (jwk.x === undefined) throw dataError('JWK: x is missing');
		const point = publicBytes(fromBase64url(jwk.x));

		if (!isPrivate) return okpKey('public', extractable, usages, point);
		const secret = privateBytes(fromBase64url(jwk.d));

		if (!constantTimeEqual(curve.publicKey(secret), point))
			throw dataError('JWK: x is not the public key of d');

		return okpKey('private', extractable, usages, secret);
	}

	function importKey(format, keyData, _algorithm, extractable, usages) {
		if (format === 'jwk') return importJwk(keyData, extractable, usages);

		if (format === 'raw' || format === 'raw-public') {
			checkUsages(usages, publicUsages);

			return okpKey('public', extractable, usages, publicBytes(keyData));
		}

		if (format === 'spki') {
			checkUsages(usages, publicUsages);
			const parsed = parseSpki(keyData);

			checkIdentifier(parsed);

			return okpKey('public', extractable, usages, publicBytes(parsed.key.slice()));
		}

		if (format === 'pkcs8') {
			checkUsages(usages, privateUsages);
			const parsed = parsePkcs8(keyData);

			checkIdentifier(parsed);
			// the private key is a CurvePrivateKey: an OCTET STRING of its own
			const secret = privateBytes(derExpect(parsed.key, OCTET_STRING).slice());

			return okpKey('private', extractable, usages, secret);
		}

		throw notSupported(`${curve.name}: unsupported key format '${format}'`);
	}

	function exportKey(format, key) {
		const isPrivate = key._type === 'private';
		const point = isPrivate ? curve.publicKey(key._material) : key._material;

		if (format === 'jwk') {
			// (members in Node's order: alg, for a signature curve, before crv)
			const jwk = jwkCommon(key);

			if (signs) jwk.alg = curve.name;
			jwk.crv = curve.name;

			if (isPrivate) jwk.d = base64url(key._material);
			jwk.x = base64url(point);
			jwk.kty = 'OKP';

			return jwk;
		}

		if (format === 'raw' || format === 'raw-public' || format === 'spki') {
			if (isPrivate) throw invalidAccess(`A private key cannot be exported as '${format}'`);

			return (format === 'spki' ? spki([derOid(curve.oid)], point) : point.slice()).buffer;
		}

		if (format === 'pkcs8') {
			if (!isPrivate) throw invalidAccess("A public key cannot be exported as 'pkcs8'");

			return pkcs8([derOid(curve.oid)], der(OCTET_STRING, key._material)).buffer;
		}

		throw notSupported(`${curve.name}: unsupported key format '${format}'`);
	}

	function generateKey(_algorithm, extractable, usages) {
		checkUsages(usages, [...publicUsages, ...privateUsages]);
		const secret = crypto.getRandomValues(new Uint8Array(curve.length));

		return {
			publicKey: okpKey(
				'public',
				true,
				usages.filter((usage) => publicUsages.includes(usage)),
				curve.publicKey(secret)
			),
			privateKey: okpKey(
				'private',
				extractable,
				usages.filter((usage) => privateUsages.includes(usage)),
				secret
			)
		};
	}

	/** deriveBits' public key and length, checked (supports): a public key of this curve, a length it has. */
	function checkDerive(params, length) {
		if (params.public._type !== 'public' || params.public._algorithm.name !== curve.name)
			throw invalidAccess(`The public key is not a ${curve.name} public key`);

		if (length !== null && length > curve.length * 8)
			throw operationError('The length is more than the secret has');
	}

	/** The shared secret with the public key, truncated to length bits (all of it for null). */
	function deriveBits(params, key, length) {
		if (key._type !== 'private') throw invalidAccess('The base key is not a private key');
		const other = params.public;

		if (other._type !== 'public') throw invalidAccess('The public key is not a public key');

		if (other._algorithm.name !== curve.name)
			throw invalidAccess(`The public key is not a ${curve.name} key`);
		let secret;

		// an all-zero secret (noble refuses to make one): the public key was of small order
		try {
			secret = curve.sharedSecret(key._material, other._material);
		} catch {
			throw operationError('The shared secret is zero');
		}

		if (secret.every((byte) => byte === 0)) throw operationError('The shared secret is zero');

		return truncateBits(secret, length);
	}

	registerAlgorithm({
		name: curve.name,
		params: signs
			? { generateKey: {}, importKey: {}, ...curve.params }
			: { generateKey: {}, importKey: {}, deriveBits: { public: 'key!' } },
		generateKey,
		importKey,
		exportKey,
		...(signs ? curve.operations : { deriveBits, checkDerive }),
		getPublicKey: (key, usages) =>
			okpKey('public', true, checkUsages(usages, publicUsages), curve.publicKey(key._material))
	});
}
