// ML-KEM (FIPS 203) for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#ml-kem): ML-KEM-512, -768 and -1024 over
// @noble/post-quantum, keys crypto-akp.mjs's and operations crypto-kem.mjs's. Loaded
// (runtime/globals.json) only into a program that names one of them.

import { ml_kem512, ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { registerKem } from './crypto-kem.mjs';

registerKem('ML-KEM-512', '2.16.840.1.101.3.4.4.1', ml_kem512);
registerKem('ML-KEM-768', '2.16.840.1.101.3.4.4.2', ml_kem768);
registerKem('ML-KEM-1024', '2.16.840.1.101.3.4.4.3', ml_kem1024);
