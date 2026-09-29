// The Web Crypto fixture: the corpus, run with the crypto and CryptoKey the build injects,
// and crypto.subtle found through globalThis, as libraries look for it.
import { runCorpus } from './corpus.mjs';

export async function run() {
	const found = globalThis.crypto;

	return JSON.stringify({
		lines: await runCorpus(crypto, CryptoKey),
		globals: { subtle: typeof found?.subtle, same: found === crypto }
	});
}
