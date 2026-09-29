// The Blob fixture: the corpus, run with the Blob, File and Response the build injects.
import { runCorpus } from './corpus.mjs';

export async function run() {
	return JSON.stringify({
		lines: await runCorpus(Blob, File, Response),
		detected: typeof globalThis.Blob
	});
}
