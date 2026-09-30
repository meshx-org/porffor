// X25519 for the Web Crypto shim (https://wicg.github.io/webcrypto-secure-curves/#x25519), over
// @noble/curves; its keys and deriveBits are crypto-okp.mjs's. Loaded (runtime/globals.json)
// only into a program that names 'X25519'.

import { x25519 } from '@noble/curves/ed25519.js';
import { registerOkp } from './crypto-okp.mjs';

registerOkp({
	name: 'X25519',
	oid: '1.3.101.110',
	length: 32,
	publicKey: (secret) => x25519.getPublicKey(secret),
	sharedSecret: (secret, point) => x25519.getSharedSecret(secret, point)
});
