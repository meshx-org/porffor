// AbortController and AbortSignal for a Porffor-compiled guest, with the DOMException
// their reasons are. The build injects this module (esbuild `inject`) into every guest,
// so the global names resolve here; Porffor has none of them.

import { AbortSignal, abortSignal } from './abort-signal.mjs';
import { DOMException } from './dom-exception.mjs';
import { defineInterface } from './webidl.mjs';

export { AbortSignal, DOMException };

/** Owns a signal and aborts it. */
export class AbortController {
	constructor() {
		this.signal = new AbortSignal();
	}

	/** Aborts the signal with `reason` (an AbortError DOMException when undefined). */
	abort(reason = undefined) {
		abortSignal(this.signal, reason);
	}
}

defineInterface(AbortController, 'AbortController');
