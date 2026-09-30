// AES-OCB for the Web Crypto shim (the Modern Algorithms in WebCrypto draft,
// https://wicg.github.io/webcrypto-modern-algos/#aes-ocb): OCB3 (RFC 7253) over @noble/ciphers'
// AES block cipher, which has no OCB of its own. Its keys are crypto-aes.mjs's, imported and
// exported as 'raw-secret' and 'jwk' (A128OCB, ...). Loaded (runtime/globals.json) only into a
// program that names 'AES-OCB'.

import { unsafe } from '@noble/ciphers/aes.js';
import { registerMode } from './crypto-aes.mjs';
import { constantTimeEqual, operationError } from './crypto-util.mjs';

const TAG_LENGTHS = [64, 96, 128];

/** A block doubled in GF(2^128) (RFC 7253's double). */
function double(block) {
	const out = new Uint8Array(16);

	for (let i = 0; i < 15; i++) out[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 255;
	out[15] = ((block[15] << 1) & 255) ^ (block[0] & 0x80 ? 0x87 : 0);

	return out;
}

/** a ^ b, a new block. */
function xor(a, b) {
	const out = new Uint8Array(16);

	for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];

	return out;
}

/** The number of trailing zero bits of i (i > 0). */
function trailingZeros(i) {
	let n = 0;

	for (let rest = i; (rest & 1) === 0; rest >>>= 1) n++;

	return n;
}

/** AES-OCB's parameters: a tag length it has, a 1 to 15-byte iv: the tag length. */
function check(algorithm) {
	const tagBits = algorithm.tagLength ?? 128;

	if (!TAG_LENGTHS.includes(tagBits)) throw operationError('AES-OCB: unsupported tag length');

	if (algorithm.iv.length === 0 || algorithm.iv.length > 15)
		throw operationError('AES-OCB: the iv must be 1 to 15 bytes');

	return tagBits;
}

/** OCB3's state for a key and nonce: the cipher, the L table, the first offset. */
function setup(key, algorithm) {
	const tagBits = check(algorithm);
	const nonce = algorithm.iv;

	const encryptKey = unsafe.expandKeyLE(key._material);
	// (a fresh aligned block per call: noble ciphers it in place, as 32-bit words)
	const cipher = (block) => unsafe.encryptBlock(encryptKey, block.slice());
	const lStar = cipher(new Uint8Array(16));
	const lDollar = double(lStar);
	const table = [double(lDollar)];
	// L_i for the i-th block, as many as the data needs
	const l = (i) => {
		while (table.length <= i) table.push(double(table[table.length - 1]));

		return table[i];
	};
	// Nonce = num2str(TAGLEN mod 128, 7) || zeros || 1 || N
	const full = new Uint8Array(16);

	full[0] = ((tagBits % 128) << 1) & 255;
	full[15 - nonce.length] |= 1;
	full.set(nonce, 16 - nonce.length);
	const bottom = full[15] & 63;

	full[15] &= 0xc0;
	const top = cipher(full);
	const stretch = new Uint8Array(24);

	stretch.set(top);

	for (let i = 0; i < 8; i++) stretch[16 + i] = top[i] ^ top[i + 1];
	// Offset_0: stretch's bits from `bottom`, 128 of them
	const offset = new Uint8Array(16);
	const shift = bottom % 8;

	for (let i = 0; i < 16; i++) {
		const at = Math.floor(bottom / 8) + i;

		offset[i] = ((stretch[at] << shift) | (shift ? stretch[at + 1] >> (8 - shift) : 0)) & 255;
	}

	return { cipher, tagBytes: tagBits / 8, lStar, lDollar, l, offset, decryptKey: null, key };
}

/** A partial block padded: its bytes, a 1 bit, zeros. */
function padded(bytes) {
	const out = new Uint8Array(16);

	out.set(bytes);
	out[bytes.length] = 0x80;

	return out;
}

/** HASH(K, A): the associated data's sum. */
function hashData(state, data) {
	let sum = new Uint8Array(16);
	let offset = new Uint8Array(16);
	const whole = Math.floor(data.length / 16);

	for (let i = 1; i <= whole; i++) {
		offset = xor(offset, state.l(trailingZeros(i)));
		sum = xor(sum, state.cipher(xor(data.subarray((i - 1) * 16, i * 16), offset)));
	}

	if (data.length % 16) {
		offset = xor(offset, state.lStar);
		sum = xor(sum, state.cipher(xor(padded(data.subarray(whole * 16)), offset)));
	}

	return sum;
}

/** OCB3 over the data: the other side's bytes and the full tag. */
function run(state, data, additionalData, decrypting) {
	const whole = Math.floor(data.length / 16);
	const out = new Uint8Array(data.length);
	let offset = state.offset;
	let checksum = new Uint8Array(16);
	let decryptKey = null;

	for (let i = 1; i <= whole; i++) {
		offset = xor(offset, state.l(trailingZeros(i)));
		const input = xor(data.subarray((i - 1) * 16, i * 16), offset);
		let block;

		if (decrypting) {
			decryptKey ??= unsafe.expandKeyDecLE(state.key._material);
			block = xor(unsafe.decryptBlock(decryptKey, input), offset);
			checksum = xor(checksum, block);
		} else {
			block = xor(state.cipher(input), offset);
			checksum = xor(checksum, data.subarray((i - 1) * 16, i * 16));
		}
		out.set(block, (i - 1) * 16);
	}
	const rest = data.length % 16;

	if (rest) {
		offset = xor(offset, state.lStar);
		const pad = state.cipher(offset);
		const tail = new Uint8Array(rest);

		for (let i = 0; i < rest; i++) tail[i] = data[whole * 16 + i] ^ pad[i];
		out.set(tail, whole * 16);
		checksum = xor(checksum, padded(decrypting ? tail : data.subarray(whole * 16)));
	}
	const tag = xor(
		state.cipher(xor(xor(checksum, offset), state.lDollar)),
		hashData(state, additionalData ?? new Uint8Array(0))
	);

	return { out, tag };
}

function encrypt(algorithm, key, data) {
	const state = setup(key, algorithm);
	const { out, tag } = run(state, data, algorithm.additionalData, false);
	const sealed = new Uint8Array(out.length + state.tagBytes);

	sealed.set(out);
	sealed.set(tag.subarray(0, state.tagBytes), out.length);

	return sealed;
}

function decrypt(algorithm, key, data) {
	const state = setup(key, algorithm);

	if (data.length < state.tagBytes)
		throw operationError('AES-OCB: the data is shorter than the tag');
	const body = data.subarray(0, data.length - state.tagBytes);
	const { out, tag } = run(state, body, algorithm.additionalData, true);

	if (!constantTimeEqual(tag.subarray(0, state.tagBytes), data.subarray(body.length)))
		throw operationError('AES-OCB: the tag does not match');

	return out;
}

const OCB_PARAMS = { additionalData: 'buffer', iv: 'buffer!', tagLength: 'octet' };

registerMode(
	'AES-OCB',
	['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
	{ encrypt, decrypt, checkParams: (operation, algorithm) => check(algorithm) },
	{ encrypt: OCB_PARAMS, decrypt: OCB_PARAMS },
	['raw-secret']
);
