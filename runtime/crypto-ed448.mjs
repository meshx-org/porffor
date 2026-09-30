// Ed448 and X448 for the Web Crypto shim (https://wicg.github.io/webcrypto-secure-curves/), over
// @noble/curves; their keys and X448's deriveBits are crypto-okp.mjs's. Loaded
// (runtime/globals.json) only into a program that names 'Ed448' or 'X448'.

import { ed448, x448 } from '@noble/curves/ed448.js';
import { registerOkp } from './crypto-okp.mjs';
import { operationError } from './crypto-util.mjs';

const { Point } = ed448;

/** Ed448Params' context: at most 255 bytes. */
function context(algorithm) {
	const bytes = algorithm.context ?? new Uint8Array(0);

	if (bytes.length > 255) throw operationError('Ed448: the context is longer than 255 bytes');

	return bytes;
}

/** Whether the signature is data's (false for anything malformed or of small order). */
function verify(algorithm, key, signature, data) {
	const ctx = context(algorithm);

	if (signature.length !== 114) return false;

	try {
		if (
			Point.fromBytes(key._material, false).isSmallOrder() ||
			Point.fromBytes(signature.subarray(0, 57), false).isSmallOrder()
		)
			return false;

		return ed448.verify(signature, data, key._material, { context: ctx, zip215: false });
	} catch {
		return false;
	}
}

const ED448_PARAMS = { context: 'buffer' };

registerOkp({
	name: 'Ed448',
	oid: '1.3.101.113',
	length: 57,
	publicKey: (secret) => ed448.getPublicKey(secret),
	params: { sign: ED448_PARAMS, verify: ED448_PARAMS },
	operations: {
		sign: (algorithm, key, data) =>
			ed448.sign(data, key._material, { context: context(algorithm) }),
		verify
	}
});

registerOkp({
	name: 'X448',
	oid: '1.3.101.111',
	length: 56,
	publicKey: (secret) => x448.getPublicKey(secret),
	sharedSecret: (secret, point) => x448.getSharedSecret(secret, point)
});
