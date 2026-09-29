// meshx:intl/plural over the engine's Intl.
import { guarded, jsOptions, witOptions } from './shared.mjs';

const KEYS = [
	'type',
	'notation',
	'roundingIncrement',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay',
	'minimumIntegerDigits',
	'minimumFractionDigits',
	'maximumFractionDigits',
	'minimumSignificantDigits',
	'maximumSignificantDigits'
];

export class PluralRules {
	constructor(rules) {
		this.inner = rules;
	}

	static create(locales, options) {
		return guarded(() => new PluralRules(new Intl.PluralRules(locales, jsOptions(options))));
	}

	select(count) {
		return this.inner.select(count);
	}

	selectRange(start, end) {
		return guarded(() => this.inner.selectRange(start, end));
	}

	resolvedOptions() {
		const resolved = this.inner.resolvedOptions();

		return {
			locale: resolved.locale,
			pluralCategories: resolved.pluralCategories,
			options: witOptions(resolved, KEYS)
		};
	}
}
