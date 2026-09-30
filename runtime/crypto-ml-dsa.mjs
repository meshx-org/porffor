// ML-DSA (FIPS 204) for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#ml-dsa): ML-DSA-44, -65 and -87 over
// @noble/post-quantum, keys crypto-akp.mjs's, sign and verify with an optional context (at most
// 255 bytes). Loaded (runtime/globals.json) only into a program that names one of them.

import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { registerAkp } from './crypto-akp.mjs';
import { invalidAccess, operationError } from './crypto-util.mjs';

/** ContextParams' context: at most 255 bytes. */
function context(algorithm) {
	const bytes = algorithm.context ?? new Uint8Array(0);

	if (bytes.length > 255) throw operationError('ML-DSA: the context is longer than 255 bytes');

	return bytes;
}

const CONTEXT_PARAMS = { context: 'buffer' };

for (const [name, oid, dsa] of [
	['ML-DSA-44', '2.16.840.1.101.3.4.3.17', ml_dsa44],
	['ML-DSA-65', '2.16.840.1.101.3.4.3.18', ml_dsa65],
	['ML-DSA-87', '2.16.840.1.101.3.4.3.19', ml_dsa87]
])
	registerAkp({
		name,
		oid,
		seedLength: dsa.lengths.seed,
		publicLength: dsa.lengths.publicKey,
		keygen: (seed) => dsa.keygen(seed),
		publicUsages: ['verify'],
		privateUsages: ['sign'],
		use: 'sig',
		params: { sign: CONTEXT_PARAMS, verify: CONTEXT_PARAMS },
		operations: {
			checkParams: (operation, algorithm) => context(algorithm),
			sign(algorithm, key, data) {
				if (key._type !== 'private') throw invalidAccess(`${name}: sign needs a private key`);

				return dsa.sign(data, key._material.secretKey, { context: context(algorithm) });
			},
			verify(algorithm, key, signature, data) {
				if (key._type !== 'public') throw invalidAccess(`${name}: verify needs a public key`);
				const ctx = context(algorithm);

				try {
					return dsa.verify(signature, data, key._material.publicKey, { context: ctx });
				} catch {
					return false;
				}
			}
		}
	});
