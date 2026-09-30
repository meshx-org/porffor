// Argon2 (RFC 9106) for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#argon2): Argon2d, Argon2i and Argon2id over
// @noble/hashes, their keys crypto-kdf.mjs's. Loaded (runtime/globals.json) only into a program
// that names one of them.

import { argon2d, argon2i, argon2id } from '@noble/hashes/argon2.js';
import { registerKdf } from './crypto-kdf.mjs';
import { operationError } from './crypto-util.mjs';

const PARAMS = {
	associatedData: 'buffer',
	memory: 'ulong!',
	nonce: 'buffer!',
	parallelism: 'ulong!',
	passes: 'ulong!',
	secretValue: 'buffer',
	version: 'octet'
};

/** The parameters RFC 9106 allows: version 0x13, a lane at least, 8 KiB a lane, a pass. */
function check(algorithm) {
	const { memory, parallelism, passes, version } = algorithm;

	if (version !== undefined && version !== 0x13)
		throw operationError('Argon2: the version must be 0x13');

	if (parallelism < 1 || parallelism > 0xffffff || passes < 1 || memory < 8 * parallelism)
		throw operationError('Argon2: invalid memory, passes or parallelism');

	if (algorithm.nonce.length < 8) throw operationError('Argon2: the nonce must be 8 bytes or more');
}

for (const [name, argon2] of [
	['Argon2d', argon2d],
	['Argon2i', argon2i],
	['Argon2id', argon2id]
])
	registerKdf(
		name,
		PARAMS,
		(algorithm, secret, bytes) => {
			try {
				return argon2(secret, algorithm.nonce, {
					t: algorithm.passes,
					m: algorithm.memory,
					p: algorithm.parallelism,
					dkLen: bytes,
					key: algorithm.secretValue,
					personalization: algorithm.associatedData
				});
			} catch {
				throw operationError(`${name}: the derivation failed`);
			}
		},
		(algorithm, bytes) => {
			check(algorithm);

			if (bytes < 4) throw operationError(`${name}: the length must be 32 bits or more`);
		}
	);
