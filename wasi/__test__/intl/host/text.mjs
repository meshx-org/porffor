// meshx:intl/text over the engine's Intl.
import { guarded, jsOptions, witOptions } from './shared.mjs';

const KEYS = ['usage', 'sensitivity', 'ignorePunctuation', 'numeric', 'caseFirst', 'collation'];

export const normalize = (value, form) => value.normalize(form.toUpperCase());

export const toLower = (value, tag) => guarded(() => value.toLocaleLowerCase(tag));

export const toUpper = (value, tag) => guarded(() => value.toLocaleUpperCase(tag));

export class Collator {
	constructor(collator) {
		this.inner = collator;
	}

	static create(locales, options) {
		return guarded(() => new Collator(new Intl.Collator(locales, jsOptions(options))));
	}

	compare(left, right) {
		return Math.sign(this.inner.compare(left, right));
	}

	resolvedOptions() {
		const resolved = this.inner.resolvedOptions();

		return {
			locale: resolved.locale,
			collation: resolved.collation,
			options: witOptions(resolved, KEYS)
		};
	}
}
