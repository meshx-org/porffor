// HKDF for the Web Crypto shim (https://w3c.github.io/webcrypto/#hkdf), over @noble/hashes.
// Loaded (runtime/globals.json) only into a program that names 'HKDF'.

import { hkdf } from '@noble/hashes/hkdf.js';
import { registerKdf } from './crypto-kdf.mjs';
import { operationError } from './crypto-util.mjs';
import { hashFunction } from './subtle-crypto.mjs';

registerKdf(
	'HKDF',
	{ hash: 'hash!', info: 'buffer!', salt: 'buffer!' },
	(algorithm, secret, bytes) =>
		hkdf(hashFunction(algorithm.hash), secret, algorithm.salt, algorithm.info, bytes),
	(algorithm, bytes) => {
		if (bytes > 255 * hashFunction(algorithm.hash).outputLen)
			throw operationError('HKDF: the length is too long for the hash');
	}
);
