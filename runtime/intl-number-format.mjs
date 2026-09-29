// Intl.NumberFormat over meshx:intl/number.

import { supportedLocales } from 'meshx:intl/locale@0.1.0';
import { NumberFormat as HostNumberFormat } from 'meshx:intl/number@0.1.0';
import {
	LOCALE_MATCHERS,
	ROUNDING_ENUMS,
	enumOption,
	hostCall,
	jsParts,
	localeList,
	optionsObject,
	resolvedFields,
	roundingOptions,
	textOption
} from './intl-options.mjs';

const RESOLVED_ORDER = [
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
	'useGrouping',
	'notation',
	'compactDisplay',
	'signDisplay',
	'roundingIncrement',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay'
];
const RESOLVED_ENUMS = [
	...ROUNDING_ENUMS,
	'style',
	'currencyDisplay',
	'currencySign',
	'unitDisplay',
	'compactDisplay',
	'signDisplay'
];

/** ECMA-402's useGrouping (true, false or a strategy) as the WIT enum. */
function useGroupingOption(options) {
	const value = options.useGrouping;

	if (value === undefined) return undefined;

	if (value === true) return 'always';

	if (!value) return 'off';

	return enumOption(options, 'useGrouping', ['always', 'auto', 'min2']);
}

/** The number-options record for `options`. */
function numberOptions(options) {
	return Object.assign(roundingOptions(options), {
		localeMatcher: enumOption(options, 'localeMatcher', LOCALE_MATCHERS),
		numberingSystem: textOption(options, 'numberingSystem'),
		style: enumOption(options, 'style', ['decimal', 'percent', 'currency', 'unit']),
		currency: textOption(options, 'currency'),
		currencyDisplay: enumOption(options, 'currencyDisplay', [
			'code',
			'symbol',
			'narrowSymbol',
			'name'
		]),
		currencySign: enumOption(options, 'currencySign', ['standard', 'accounting']),
		unit: textOption(options, 'unit'),
		unitDisplay: enumOption(options, 'unitDisplay', ['short', 'narrow', 'long']),
		compactDisplay: enumOption(options, 'compactDisplay', ['short', 'long']),
		useGrouping: useGroupingOption(options),
		signDisplay: enumOption(options, 'signDisplay', [
			'auto',
			'never',
			'always',
			'exceptZero',
			'negative'
		])
	});
}

/**
 * A value to format: a BigInt or a string exactly, as a decimal (ECMA-402 does not round
 * them through a float), anything else as a number.
 */
function numberValue(value) {
	if (typeof value === 'bigint') return { tag: 'decimal', val: value.toString() };

	if (typeof value === 'string') return { tag: 'decimal', val: value };

	return { tag: 'float', val: Number(value) };
}

/** Both ends of a range, which formatRange requires. */
function rangeValues(start, end) {
	if (start === undefined || end === undefined)
		throw new TypeError('Intl.NumberFormat: formatRange needs a start and an end');

	return [numberValue(start), numberValue(end)];
}

/** `Intl.NumberFormat`. */
export class NumberFormat {
	/**
	 * @param {string | string[]} [locales]
	 * @param {Intl.NumberFormatOptions} [options]
	 */
	constructor(locales, options) {
		const record = numberOptions(optionsObject(options));

		this._host = hostCall(() => HostNumberFormat.create(localeList(locales), record));
		this._format = undefined;
	}

	/** `format`, bound to this formatter as ECMA-402 has it. */
	get format() {
		if (this._format === undefined) this._format = (value) => this.formatNumber(value);

		return this._format;
	}

	/** The formatted number; `format` without the binding. */
	formatNumber(value) {
		const number = numberValue(value);

		return hostCall(() => this._host.format(number));
	}

	formatToParts(value) {
		const number = numberValue(value);

		return jsParts(hostCall(() => this._host.formatToParts(number)));
	}

	formatRange(start, end) {
		const [from, to] = rangeValues(start, end);

		return hostCall(() => this._host.formatRange(from, to));
	}

	formatRangeToParts(start, end) {
		const [from, to] = rangeValues(start, end);

		return jsParts(hostCall(() => this._host.formatRangeToParts(from, to)));
	}

	resolvedOptions() {
		const resolved = this._host.resolvedOptions();
		const out = resolvedFields(
			{ locale: resolved.locale, numberingSystem: resolved.numberingSystem },
			resolved.options,
			RESOLVED_ORDER,
			RESOLVED_ENUMS
		);

		// useGrouping resolves to a strategy or false
		if (out.useGrouping !== undefined)
			out.useGrouping = out.useGrouping === 'off' ? false : out.useGrouping;

		return out;
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('number-format', localeList(locales)));
	}
}
