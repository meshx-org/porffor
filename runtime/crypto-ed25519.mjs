// Ed25519 for the Web Crypto shim (https://wicg.github.io/webcrypto-secure-curves/#ed25519),
// over @noble/curves; its keys are crypto-okp.mjs's. Loaded (runtime/globals.json) only into a
// program that names 'Ed25519'.
//
// Verification is RFC 8032's, strictly, as the WPT expects of browsers: canonical encodings, S
// below the group order, no small-order public key or R, and the cofactorless equation
// [S]B = R + [k]A (noble's own verify is cofactored).

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { registerOkp } from './crypto-okp.mjs';
import { concatBytes } from './crypto-util.mjs';

const { Point } = ed25519;

/** Whether the signature is data's under the public key (false for anything malformed). */
function verify(_algorithm, key, signature, data) {
	if (signature.length !== 64) return false;
	let publicPoint;
	let r;

	try {
		publicPoint = Point.fromBytes(key._material, false);
		r = Point.fromBytes(signature.subarray(0, 32), false);
	} catch {
		return false;
	}

	if (publicPoint.isSmallOrder() || r.isSmallOrder()) return false;
	const order = Point.Fn.ORDER;
	const s = bytesToNumberLE(signature.subarray(32));

	if (s >= order) return false;
	const k =
		bytesToNumberLE(sha512(concatBytes(signature.subarray(0, 32), key._material, data))) % order;

	return Point.BASE.multiplyUnsafe(s).equals(r.add(publicPoint.multiplyUnsafe(k)));
}

registerOkp({
	name: 'Ed25519',
	oid: '1.3.101.112',
	length: 32,
	publicKey: (secret) => ed25519.getPublicKey(secret),
	params: { sign: {}, verify: {} },
	operations: {
		sign: (_algorithm, key, data) => ed25519.sign(data, key._material),
		verify
	}
});
