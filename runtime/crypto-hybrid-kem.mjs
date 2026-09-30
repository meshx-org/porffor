// The hybrid KEMs for the Web Crypto shim (the Modern Algorithms in WebCrypto draft, after
// draft-irtf-cfrg-concrete-hybrid-kems): MLKEM768-P256, MLKEM768-X25519 and MLKEM1024-P384, over
// @noble/post-quantum, keys crypto-akp.mjs's ('raw-public', 'raw-seed', 'jwk'; no OID) and
// operations crypto-kem.mjs's. Loaded (runtime/globals.json) only into a program that names one.

import { ml_kem1024_p384, ml_kem768_p256, ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js';
import { registerKem } from './crypto-kem.mjs';

registerKem('MLKEM768-P256', null, ml_kem768_p256);
registerKem('MLKEM768-X25519', null, ml_kem768_x25519);
registerKem('MLKEM1024-P384', null, ml_kem1024_p384);
