// Native Intl: porffor:intl/plural, meshx:intl/plural answered by ICU4X linked into the program
// (bridge.mjs). runtime/host/wasi/intl/plural.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

/** meshx:intl's plural-rules resource: ICU4X's rules, by handle. */
export class PluralRules {
	constructor(handle) {
		this.__h = handle;
	}

	/** The rules for `locales` and a plural-options record. */
	static create(locales, options) {
		return new PluralRules(intlCall('plural-rules.create', undefined, [locales, options]));
	}

	// NaN and the infinities go as null (JSON has neither), which selects 'other' as they do
	select(n) {
		return intlCall('plural-rules.select', this.__h, [n]);
	}

	selectRange(start, end) {
		return intlCall('plural-rules.select-range', this.__h, [start, end]);
	}

	resolvedOptions() {
		return intlCall('plural-rules.resolved-options', this.__h, []);
	}
}
