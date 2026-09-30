// What the post-quantum algorithms share (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/: ML-KEM, ML-DSA and the hybrid KEMs): a key
// pair made from a seed, and its formats. 'raw-public' and 'raw-seed', 'jwk' with kty AKP (pub,
// and priv the seed), and for those with an OID 'spki' and 'pkcs8' (the seed form: [0] seed).
// Each algorithm's module brings noble's scheme and registers through registerAkp. A private
// key's material is { seed, publicKey, secretKey } (noble's expanded keys, made once from the
// seed); a public key's, { publicKey }.

import { makeKey } from './crypto-key.mjs';
import { der, derExpect, derOid, parsePkcs8, parseSpki, pkcs8, spki } from './crypto-der.mjs';
import {
	base64url,
	checkJwk,
	checkUsages,
	constantTimeEqual,
	dataError,
	fromBase64url,
	invalidAccess,
	jwkCommon,
	notSupported
} from './crypto-util.mjs';
import { registerAlgorithm } from './subtle-crypto.mjs';

// the seed form of the private key, inside pkcs8's OCTET STRING: [0] IMPLICIT OCTET STRING
const SEED_TAG = 0x80;

/**
 * @typedef {object} AkpScheme
 * @property {string} name 'ML-KEM-768', 'ML-DSA-65', ...
 * @property {string | null} oid its algorithm identifier, for 'spki' and 'pkcs8' (null: none)
 * @property {number} seedLength the seed's bytes
 * @property {number} publicLength the public key's bytes
 * @property {(seed: Uint8Array) => { publicKey: Uint8Array, secretKey: Uint8Array }} keygen
 * @property {string[]} publicUsages
 * @property {string[]} privateUsages
 * @property {'sig' | 'enc'} use a JWK's use
 * @property {Record<string, Record<string, string>>} params the operations' parameters
 * @property {Record<string, Function>} operations
 */

/**
 * Registers a seed-based algorithm with SubtleCrypto.
 * @param {AkpScheme} scheme
 */
export function registerAkp(scheme) {
	const algorithm = { name: scheme.name };

	const publicKey = (extractable, usages, bytes) =>
		makeKey('public', extractable, algorithm, usages, { publicKey: bytes });

	/** A private key from its seed: noble's key pair, made once. */
	function privateKey(extractable, usages, seed) {
		if (seed.length !== scheme.seedLength)
			throw dataError(`${scheme.name}: the seed is not ${scheme.seedLength} bytes`);
		const pair = scheme.keygen(seed);

		return makeKey('private', extractable, algorithm, usages, { seed, ...pair });
	}

	function publicBytes(bytes) {
		if (bytes.length !== scheme.publicLength)
			throw dataError(`${scheme.name}: the public key is not ${scheme.publicLength} bytes`);

		return bytes;
	}

	function checkIdentifier(parsed) {
		if (parsed.oid !== scheme.oid || parsed.params !== undefined)
			throw dataError(`The key is not a ${scheme.name} key`);
	}

	function importJwk(jwk, extractable, usages) {
		const isPrivate = jwk.priv !== undefined;

		checkUsages(usages, isPrivate ? scheme.privateUsages : scheme.publicUsages);

		if (jwk.kty !== 'AKP') throw dataError("JWK: kty must be 'AKP'");

		if (jwk.alg !== scheme.name) throw dataError(`JWK: alg must be '${scheme.name}'`);
		checkJwk(jwk, { kty: 'AKP', use: scheme.use, usages, extractable });

		if (jwk.pub === undefined) throw dataError('JWK: pub is missing');
		const pub = publicBytes(fromBase64url(jwk.pub));

		if (!isPrivate) return publicKey(extractable, usages, pub);
		const key = privateKey(extractable, usages, fromBase64url(jwk.priv));

		if (!constantTimeEqual(key._material.publicKey, pub))
			throw dataError('JWK: pub is not the public key of priv');

		return key;
	}

	function importKey(format, keyData, _algorithm, extractable, usages) {
		if (format === 'jwk') return importJwk(keyData, extractable, usages);

		if (format === 'raw-public') {
			checkUsages(usages, scheme.publicUsages);

			return publicKey(extractable, usages, publicBytes(keyData));
		}

		if (format === 'raw-seed') {
			checkUsages(usages, scheme.privateUsages);

			return privateKey(extractable, usages, keyData);
		}

		if (format === 'spki' && scheme.oid !== null) {
			checkUsages(usages, scheme.publicUsages);
			const parsed = parseSpki(keyData);

			checkIdentifier(parsed);

			return publicKey(extractable, usages, publicBytes(parsed.key.slice()));
		}

		if (format === 'pkcs8' && scheme.oid !== null) {
			checkUsages(usages, scheme.privateUsages);
			const parsed = parsePkcs8(keyData);

			checkIdentifier(parsed);

			// (only the seed form: the expanded key alone, or with the seed, is not supported)
			if (parsed.key[0] !== SEED_TAG)
				throw notSupported(`${scheme.name}: only a seed private key can be imported`);

			return privateKey(extractable, usages, derExpect(parsed.key, SEED_TAG).slice());
		}

		throw notSupported(`${scheme.name}: unsupported key format '${format}'`);
	}

	function exportKey(format, key) {
		const isPrivate = key._type === 'private';
		const material = key._material;

		if (format === 'jwk') {
			const jwk = {
				...jwkCommon(key),
				kty: 'AKP',
				alg: scheme.name,
				pub: base64url(material.publicKey)
			};

			if (isPrivate) jwk.priv = base64url(material.seed);

			return jwk;
		}

		if (format === 'raw-public' || (format === 'spki' && scheme.oid !== null)) {
			if (isPrivate) throw invalidAccess(`A private key cannot be exported as '${format}'`);

			return (
				format === 'spki'
					? spki([derOid(scheme.oid)], material.publicKey)
					: material.publicKey.slice()
			).buffer;
		}

		if (format === 'raw-seed' || (format === 'pkcs8' && scheme.oid !== null)) {
			if (!isPrivate) throw invalidAccess(`A public key cannot be exported as '${format}'`);

			return (
				format === 'pkcs8'
					? pkcs8([derOid(scheme.oid)], der(SEED_TAG, material.seed))
					: material.seed.slice()
			).buffer;
		}

		throw notSupported(`${scheme.name}: unsupported key format '${format}'`);
	}

	function generateKey(_algorithm, extractable, usages) {
		checkUsages(usages, [...scheme.publicUsages, ...scheme.privateUsages]);
		const key = privateKey(
			extractable,
			usages.filter((usage) => scheme.privateUsages.includes(usage)),
			crypto.getRandomValues(new Uint8Array(scheme.seedLength))
		);

		return {
			publicKey: publicKey(
				true,
				usages.filter((usage) => scheme.publicUsages.includes(usage)),
				key._material.publicKey
			),
			privateKey: key
		};
	}

	registerAlgorithm({
		name: scheme.name,
		params: { generateKey: {}, importKey: {}, ...scheme.params },
		generateKey,
		importKey,
		exportKey,
		...scheme.operations,
		getPublicKey: (key, usages) =>
			publicKey(true, checkUsages(usages, scheme.publicUsages), key._material.publicKey)
	});
}
