// Ed25519 for the Web Crypto shim (https://wicg.github.io/webcrypto-secure-curves/#ed25519),
// over @noble/curves: generateKey, importKey and exportKey ('raw', 'jwk', 'spki', 'pkcs8'),
// sign and verify. A private key's material is its 32-byte seed; a public key's, the point.

import { ed25519 } from '@noble/curves/ed25519.js';
import { CryptoKey, KEY_TOKEN } from './crypto-key.mjs';
import {
	base64url,
	checkUsages,
	dataError,
	fromBase64url,
	invalidAccess,
	notSupported,
	syntaxError,
	toBuffer,
	toBytes
} from './crypto-util.mjs';

const KEY_LENGTH = 32;
// DER framing of each form (RFC 8410): the key's bytes follow
const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const PKCS8_PREFIX = [
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
];

const makeKey = (type, material, extractable, usages) =>
	new CryptoKey(KEY_TOKEN, { type, extractable, algorithm: { name: 'Ed25519' }, usages, material });

/** The key after a DER prefix, if the bytes are exactly that framing. */
function unframe(bytes, prefix) {
	if (bytes.length !== prefix.length + KEY_LENGTH || prefix.some((byte, i) => bytes[i] !== byte))
		throw dataError('Ed25519: the key is not in this format');

	return bytes.slice(prefix.length);
}

/** generateKey: a key pair (the public key always extractable). */
export function generateEd25519Key(extractable, usages) {
	const allowed = checkUsages(usages, ['sign', 'verify']);

	if (!allowed.includes('sign')) throw syntaxError('Usages must include sign');
	const seed = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
	const point = ed25519.getPublicKey(seed);

	return {
		publicKey: makeKey(
			'public',
			point,
			true,
			allowed.filter((usage) => usage === 'verify')
		),
		privateKey: makeKey('private', seed, extractable, ['sign'])
	};
}

/** A JWK (kty OKP, crv Ed25519) as a key: private if it has d. */
function importJwk(jwk, extractable, usages) {
	if (jwk?.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw dataError("JWK: not an 'OKP' Ed25519 key");

	if (jwk.alg !== undefined && jwk.alg !== 'Ed25519' && jwk.alg !== 'EdDSA')
		throw dataError('JWK: alg does not match Ed25519');
	const point = fromBase64url(jwk.x);

	if (jwk.d === undefined)
		return makeKey('public', point, extractable, checkUsages(usages, ['verify']));
	const seed = fromBase64url(jwk.d);

	if (seed.length !== KEY_LENGTH) throw dataError('Ed25519: the private key is not 32 bytes');

	if (base64url(ed25519.getPublicKey(seed)) !== base64url(point))
		throw dataError('JWK: x does not match d');

	return makeKey('private', seed, extractable, checkUsages(usages, ['sign']));
}

/** importKey: 'raw' and 'spki' are public, 'pkcs8' private, 'jwk' either. */
export function importEd25519Key(format, keyData, extractable, usages) {
	if (format === 'jwk') return importJwk(keyData, extractable, usages);
	const bytes = toBytes(keyData);

	if (format === 'raw' || format === 'spki') {
		const point = format === 'raw' ? bytes : unframe(bytes, SPKI_PREFIX);

		if (point.length !== KEY_LENGTH) throw dataError('Ed25519: the public key is not 32 bytes');

		return makeKey('public', point, extractable, checkUsages(usages, ['verify']));
	}

	if (format === 'pkcs8')
		return makeKey(
			'private',
			unframe(bytes, PKCS8_PREFIX),
			extractable,
			checkUsages(usages, ['sign'])
		);

	throw notSupported(`Ed25519: unsupported key format '${format}'`);
}

/** exportKey: 'raw' and 'spki' for a public key, 'pkcs8' for a private one, 'jwk' for both. */
export function exportEd25519Key(format, key) {
	const isPrivate = key.type === 'private';
	const point = isPrivate ? ed25519.getPublicKey(key._material) : key._material;

	if (format === 'jwk') {
		const jwk = { key_ops: key.usages, ext: key.extractable, alg: 'Ed25519', crv: 'Ed25519' };

		if (isPrivate) jwk.d = base64url(key._material);
		jwk.x = base64url(point);
		jwk.kty = 'OKP';

		return jwk;
	}

	if (format === 'raw' && !isPrivate) return toBuffer(point);

	if (format === 'spki' && !isPrivate) return toBuffer(new Uint8Array([...SPKI_PREFIX, ...point]));

	if (format === 'pkcs8' && isPrivate)
		return toBuffer(new Uint8Array([...PKCS8_PREFIX, ...key._material]));

	if (['raw', 'spki', 'pkcs8'].includes(format))
		throw invalidAccess(`Ed25519: a ${key.type} key cannot be exported as '${format}'`);

	throw notSupported(`Ed25519: unsupported key format '${format}'`);
}

/** The signature of data under a private key. */
export const ed25519Sign = (key, data) => toBuffer(ed25519.sign(toBytes(data), key._material));

/** Whether signature is data's under a public key (false for a malformed one). */
export function ed25519Verify(key, signature, data) {
	const bytes = toBytes(signature);

	if (bytes.length !== 64) return false;

	try {
		return ed25519.verify(bytes, toBytes(data), key._material);
	} catch {
		return false;
	}
}
