// Native Intl: porffor:intl/text, meshx:intl/text answered by ICU4X linked into the program
// (bridge.mjs). runtime/host/wasi/intl/text.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

/** `String.prototype.normalize` in a form ('nfc', 'nfd', 'nfkc', 'nfkd'). */
export function normalize(s, form) {
	return intlCall('text.normalize', undefined, [s, form]);
}

/** `toLocaleLowerCase`. */
export function toLower(s, locale) {
	return intlCall('text.to-lower', undefined, [s, locale]);
}

/** `toLocaleUpperCase`. */
export function toUpper(s, locale) {
	return intlCall('text.to-upper', undefined, [s, locale]);
}

/** meshx:intl's collator resource: an ICU4X collator, by handle. */
export class Collator {
	constructor(handle) {
		this.__h = handle;
	}

	/** A collator for `locales` and a collator-options record. */
	static create(locales, options) {
		return new Collator(intlCall('collator.create', undefined, [locales, options]));
	}

	/** -1, 0 or 1. */
	compare(a, b) {
		return intlCall('collator.compare', this.__h, [a, b]);
	}

	resolvedOptions() {
		return intlCall('collator.resolved-options', this.__h, []);
	}
}
