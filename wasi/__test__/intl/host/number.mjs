// meshx:intl/number over the engine's Intl.
import { guarded, jsOptions, numberValue, witOptions, witParts } from './shared.mjs';

const KEYS = [
	'style',
	'currency',
	'currencyDisplay',
	'currencySign',
	'unit',
	'unitDisplay',
	'minimumIntegerDigits',
	'minimumFractionDigits',
	'maximumFractionDigits',
	'minimumSignificantDigits',
	'maximumSignificantDigits',
	'roundingIncrement',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay',
	'notation',
	'compactDisplay',
	'useGrouping',
	'signDisplay'
];

export class NumberFormat {
	constructor(format) {
		this.inner = format;
	}

	static create(locales, options) {
		return guarded(() => new NumberFormat(new Intl.NumberFormat(locales, jsOptions(options))));
	}

	format(value) {
		return guarded(() => this.inner.format(numberValue(value)));
	}

	formatToParts(value) {
		return guarded(() => witParts(this.inner.formatToParts(numberValue(value))));
	}

	formatRange(start, end) {
		return guarded(() => this.inner.formatRange(numberValue(start), numberValue(end)));
	}

	formatRangeToParts(start, end) {
		return guarded(() =>
			witParts(this.inner.formatRangeToParts(numberValue(start), numberValue(end)))
		);
	}

	resolvedOptions() {
		const resolved = this.inner.resolvedOptions();

		return {
			locale: resolved.locale,
			numberingSystem: resolved.numberingSystem,
			options: witOptions(resolved, KEYS)
		};
	}
}
