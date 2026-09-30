// ECDSA and ECDH for the Web Crypto shim (https://w3c.github.io/webcrypto/#ecdsa, #ecdh) on
// P-256, P-384 and P-521, over @noble/curves: generateKey, importKey and exportKey ('raw',
// 'raw-public', 'spki', 'pkcs8', 'jwk' kty EC), sign and verify, deriveBits. Loaded
// (runtime/globals.json) only into a program that names 'ECDSA' or 'ECDH'.
//
// A key's material is { curve, secret, point }: the secret scalar's bytes (null for a public
// key) and the uncompressed point. ECDSA hashes with the algorithm's hash, whatever the curve,
// so noble signs and verifies the digest (prehash off), and verification accepts high S.

import { p256, p384, p521 } from '@noble/curves/nist.js';
import { makeKey } from './crypto-key.mjs';
import {
	BIT_STRING,
	INTEGER,
	OCTET_STRING,
	OID,
	SEQUENCE,
	der,
	derExpect,
	derOid,
	derSequence,
	bitStringBytes,
	oidText,
	parsePkcs8,
	parseSpki,
	pkcs8,
	spki
} from './crypto-der.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	concatBytes,
	dataError,
	fromBase64url,
	invalidAccess,
	jwkCommon,
	notSupported,
	operationError,
	truncateBits
} from './crypto-util.mjs';
import { hashFunction, registerAlgorithm } from './subtle-crypto.mjs';

const EC_PUBLIC_KEY = '1.2.840.10045.2.1';

/** The curves, by name: noble's, the OID, the bytes of a coordinate, ECDSA's JWK alg. */
const CURVES = {
	'P-256': { noble: p256, oid: '1.2.840.10045.3.1.7', length: 32, alg: 'ES256' },
	'P-384': { noble: p384, oid: '1.3.132.0.34', length: 48, alg: 'ES384' },
	'P-521': { noble: p521, oid: '1.3.132.0.35', length: 66, alg: 'ES512' }
};

/** The curve of that name: NotSupportedError for any other. */
function curveNamed(name) {
	if (!Object.hasOwn(CURVES, name)) throw notSupported(`Unsupported curve '${name}'`);

	return CURVES[name];
}

/** The curve name an OID is, or a DataError. */
function curveOfOid(oid) {
	const name = Object.keys(CURVES).find((curve) => CURVES[curve].oid === oid);

	if (name === undefined) throw dataError('The key is on an unsupported curve');

	return name;
}

/** A point's bytes, validated and uncompressed: a DataError if it is not on the curve. */
function pointBytes(curve, bytes) {
	try {
		return curve.noble.Point.fromBytes(bytes).toBytes(false);
	} catch {
		throw dataError('The public key is not a point on the curve');
	}
}

/** A secret scalar's bytes, validated. */
function secretBytes(curve, bytes) {
	if (bytes.length !== curve.length || !curve.noble.utils.isValidSecretKey(bytes))
		throw dataError('The private key is not valid for the curve');

	return bytes;
}

/** The public point of a secret, uncompressed. */
const publicPoint = (curve, secret) => curve.noble.getPublicKey(secret, false);

/**
 * Registers ECDSA or ECDH.
 * @param {'ECDSA' | 'ECDH'} name
 */
function registerEc(name) {
	const signs = name === 'ECDSA';
	const publicUsages = signs ? ['verify'] : [];
	const privateUsages = signs ? ['sign'] : ['deriveKey', 'deriveBits'];

	const ecKey = (type, namedCurve, extractable, usages, secret, point) =>
		makeKey(type, extractable, { name, namedCurve }, usages, {
			curve: CURVES[namedCurve],
			secret,
			point
		});

	function generateKey(algorithm, extractable, usages) {
		checkUsages(usages, [...publicUsages, ...privateUsages]);
		const curve = curveNamed(algorithm.namedCurve);
		const secret = curve.noble.utils.randomSecretKey();
		const point = publicPoint(curve, secret);

		return {
			publicKey: ecKey(
				'public',
				algorithm.namedCurve,
				true,
				usages.filter((usage) => publicUsages.includes(usage)),
				null,
				point
			),
			privateKey: ecKey(
				'private',
				algorithm.namedCurve,
				extractable,
				usages.filter((usage) => privateUsages.includes(usage)),
				secret,
				point
			)
		};
	}

	/** The curve an algorithm identifier's parameters name: the one asked for, or a DataError. */
	function identifierCurve(parsed, namedCurve) {
		if (parsed.oid !== EC_PUBLIC_KEY) throw dataError('The key is not an EC key');

		if (parsed.params === undefined || parsed.params.tag !== OID)
			throw dataError('The key does not name its curve');

		if (curveOfOid(oidText(parsed.params.content)) !== namedCurve)
			throw dataError('The key is on another curve');

		return CURVES[namedCurve];
	}

	/** An ECPrivateKey (RFC 5915): its secret, and its point when it has one. */
	function parsePrivate(bytes, curve, namedCurve) {
		const found = derSequence(bytes, [INTEGER, OCTET_STRING]);

		if (found.length < 2 || found[0].content.length !== 1 || found[0].content[0] !== 1)
			throw dataError('pkcs8: not an ECPrivateKey');
		const secret = secretBytes(curve, found[1].content.slice());
		let point = null;

		for (const field of found.slice(2)) {
			// [0] the curve (as the outer one), [1] the public key
			if (field.tag === 0xa0) {
				if (curveOfOid(oidText(derExpect(field.content, OID))) !== namedCurve)
					throw dataError('pkcs8: the curves differ');
			} else if (field.tag === 0xa1)
				point = pointBytes(curve, bitStringBytes(derExpect(field.content, BIT_STRING)));
			else throw dataError('pkcs8: unexpected element');
		}

		const derived = publicPoint(curve, secret);

		if (point !== null && base64url(point) !== base64url(derived))
			throw dataError('pkcs8: the public key is not the private key');

		return { secret, point: derived };
	}

	function importJwk(jwk, algorithm, extractable, usages) {
		const isPrivate = jwk.d !== undefined;

		checkUsages(usages, isPrivate ? privateUsages : publicUsages);

		if (jwk.kty !== 'EC') throw dataError("JWK: kty must be 'EC'");

		if (jwk.crv !== algorithm.namedCurve) throw dataError('JWK: crv is not the curve asked for');
		const curve = CURVES[algorithm.namedCurve];

		if (signs && jwk.alg !== undefined && jwk.alg !== curve.alg)
			throw dataError(`JWK: alg must be ${curve.alg}`);
		checkJwk(jwk, { kty: 'EC', use: signs ? 'sig' : 'enc', usages, extractable });

		if (jwk.x === undefined || jwk.y === undefined) throw dataError('JWK: x or y is missing');
		const x = fromBase64url(jwk.x);
		const y = fromBase64url(jwk.y);

		if (x.length !== curve.length || y.length !== curve.length)
			throw dataError('JWK: x or y is not the size of the curve');
		const point = pointBytes(curve, concatBytes(new Uint8Array([4]), x, y));

		if (!isPrivate) return ecKey('public', algorithm.namedCurve, extractable, usages, null, point);
		const secret = secretBytes(curve, fromBase64url(jwk.d));

		if (base64url(publicPoint(curve, secret)) !== base64url(point))
			throw dataError('JWK: x and y are not the public key of d');

		return ecKey('private', algorithm.namedCurve, extractable, usages, secret, point);
	}

	function importKey(format, keyData, algorithm, extractable, usages) {
		const { namedCurve } = algorithm;
		const curve = curveNamed(namedCurve);

		if (format === 'jwk') return importJwk(keyData, algorithm, extractable, usages);

		if (format === 'raw' || format === 'raw-public') {
			checkUsages(usages, publicUsages);

			return ecKey('public', namedCurve, extractable, usages, null, pointBytes(curve, keyData));
		}

		if (format === 'spki') {
			checkUsages(usages, publicUsages);
			const parsed = parseSpki(keyData);

			identifierCurve(parsed, namedCurve);

			return ecKey('public', namedCurve, extractable, usages, null, pointBytes(curve, parsed.key));
		}

		if (format === 'pkcs8') {
			checkUsages(usages, privateUsages);
			const parsed = parsePkcs8(keyData);

			identifierCurve(parsed, namedCurve);
			const { secret, point } = parsePrivate(parsed.key, curve, namedCurve);

			return ecKey('private', namedCurve, extractable, usages, secret, point);
		}

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	function exportKey(format, key) {
		const { curve, secret, point } = key._material;
		const isPrivate = key._type === 'private';
		const identifier = [derOid(EC_PUBLIC_KEY), derOid(curve.oid)];

		if (format === 'jwk') {
			const jwk = { ...jwkCommon(key), kty: 'EC', crv: key._algorithm.namedCurve };

			jwk.x = base64url(point.subarray(1, 1 + curve.length));
			jwk.y = base64url(point.subarray(1 + curve.length));

			if (isPrivate) jwk.d = base64url(secret);

			return jwk;
		}

		if (format === 'raw' || format === 'raw-public' || format === 'spki') {
			if (isPrivate) throw invalidAccess(`A private key cannot be exported as '${format}'`);

			return (format === 'spki' ? spki(identifier, point) : point.slice()).buffer;
		}

		if (format === 'pkcs8') {
			if (!isPrivate) throw invalidAccess("A public key cannot be exported as 'pkcs8'");
			const inner = der(
				SEQUENCE,
				der(INTEGER, new Uint8Array([1])),
				der(OCTET_STRING, secret),
				der(0xa1, der(BIT_STRING, new Uint8Array([0]), point))
			);

			return pkcs8(identifier, inner).buffer;
		}

		throw notSupported(`${name}: unsupported key format '${format}'`);
	}

	const operations = signs
		? {
				sign(algorithm, key, data) {
					if (key._type !== 'private') throw invalidAccess('ECDSA: sign needs a private key');
					const { curve, secret } = key._material;
					const digest = hashFunction(algorithm.hash)(data);

					return curve.noble.sign(digest, secret, { prehash: false, lowS: false });
				},
				verify(algorithm, key, signature, data) {
					if (key._type !== 'public') throw invalidAccess('ECDSA: verify needs a public key');
					const { curve, point } = key._material;

					if (signature.length !== curve.length * 2) return false;
					const digest = hashFunction(algorithm.hash)(data);

					try {
						return curve.noble.verify(signature, digest, point, { prehash: false, lowS: false });
					} catch {
						return false;
					}
				}
			}
		: {
				/** deriveBits' public key and length, checked (supports): an ECDH public key, a length its curve has. */
				checkDerive(algorithm, length) {
					const other = algorithm.public;

					if (other._type !== 'public' || other._algorithm.name !== 'ECDH')
						throw invalidAccess('ECDH: the public key is not an ECDH public key');

					if (length !== null && length > other._material.curve.length * 8)
						throw operationError('ECDH: the length is more than the secret has');
				},
				deriveBits(algorithm, key, length) {
					if (key._type !== 'private') throw invalidAccess('ECDH: the base key is not private');
					const other = algorithm.public;

					if (other._type !== 'public') throw invalidAccess('ECDH: the public key is not public');

					if (other._algorithm.name !== 'ECDH')
						throw invalidAccess('ECDH: the public key is not an ECDH key');

					if (other._algorithm.namedCurve !== key._algorithm.namedCurve)
						throw invalidAccess('ECDH: the keys are on different curves');
					const { curve, secret } = key._material;
					let shared;

					try {
						shared = curve.noble.getSharedSecret(secret, other._material.point, true).slice(1);
					} catch {
						throw operationError('ECDH: no shared secret');
					}

					return truncateBits(shared, length);
				}
			};

	const curveParams = { namedCurve: 'string!' };
	const signParams = { hash: 'hash!' };

	registerAlgorithm({
		name,
		params: {
			generateKey: curveParams,
			importKey: curveParams,
			...(signs ? { sign: signParams, verify: signParams } : { deriveBits: { public: 'key!' } })
		},
		generateKey,
		checkGenerateKey: (algorithm) => curveNamed(algorithm.namedCurve),
		checkImport: (algorithm) => curveNamed(algorithm.namedCurve),
		importKey,
		exportKey,
		...operations,
		getPublicKey: (key, usages) =>
			ecKey(
				'public',
				key._algorithm.namedCurve,
				true,
				checkUsages(usages, publicUsages),
				null,
				key._material.point
			)
	});
}

registerEc('ECDSA');
registerEc('ECDH');
