// The URL fixture: the corpus, parsed with the URL and URLSearchParams the build injects,
// and those classes seen through globalThis (feature detection, as libraries do it).
import { runCorpus } from './corpus.mjs';

// at the top level, before anything else of the guest has run
const detected = typeof globalThis.URL;

export function run() {
	return JSON.stringify({
		lines: runCorpus(URL, URLSearchParams),
		globals: {
			detected,
			same: globalThis.URL === URL,
			viaBrackets: new globalThis['URLSearchParams']('a=1&b=2').get('b'),
			stream: typeof globalThis.ReadableStream,
			enumerable: Object.keys(globalThis).includes('URL'),
			// provided by runtime/, but never reached through the global object (globalThis.X,
			// 'X' in globalThis): not installed
			notReached: Object.getOwnPropertyNames(globalThis).includes('TransformStream')
		}
	});
}
