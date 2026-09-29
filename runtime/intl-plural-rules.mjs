// Intl.PluralRules over meshx:intl/plural.

import { supportedLocales } from 'meshx:intl/locale@0.1.0';
import { PluralRules as HostPluralRules } from 'meshx:intl/plural@0.1.0';
import {
	LOCALE_MATCHERS,
	ROUNDING_ENUMS,
	enumOption,
	hostCall,
	localeList,
	optionsObject,
	resolvedFields,
	roundingOptions
} from './intl-options.mjs';

// resolvedOptions(): these, then pluralCategories, then the rounding ones
const DIGITS_ORDER = [
	'type',
	'notation',
	'minimumIntegerDigits',
	'minimumFractionDigits',
	'maximumFractionDigits',
	'minimumSignificantDigits',
	'maximumSignificantDigits'
];
const ROUNDING_ORDER = [
	'roundingIncrement',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay'
];
const RESOLVED_ENUMS = [...ROUNDING_ENUMS, 'type'];

/** `Intl.PluralRules`. */
export class PluralRules {
	/**
	 * @param {string | string[]} [locales]
	 * @param {Intl.PluralRulesOptions} [options]
	 */
	constructor(locales, options) {
		const given = optionsObject(options);
		const record = roundingOptions(given);

		record.localeMatcher = enumOption(given, 'localeMatcher', LOCALE_MATCHERS);
		record.type = enumOption(given, 'type', ['cardinal', 'ordinal']);

		this._host = hostCall(() => HostPluralRules.create(localeList(locales), record));
	}

	/** The plural category of `count`: 'zero', 'one', 'two', 'few', 'many' or 'other'. */
	select(count) {
		return this._host.select(Number(count));
	}

	selectRange(start, end) {
		if (start === undefined || end === undefined)
			throw new TypeError('Intl.PluralRules: selectRange needs a start and an end');

		return hostCall(() => this._host.selectRange(Number(start), Number(end)));
	}

	resolvedOptions() {
		const resolved = this._host.resolvedOptions();
		const out = resolvedFields(
			{ locale: resolved.locale },
			resolved.options,
			DIGITS_ORDER,
			RESOLVED_ENUMS
		);

		out.pluralCategories = Array.from(resolved.pluralCategories);

		return resolvedFields(out, resolved.options, ROUNDING_ORDER, RESOLVED_ENUMS);
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('plural-rules', localeList(locales)));
	}
}
