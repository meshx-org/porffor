// What every Intl class shares: reading ECMA-402 options into meshx:intl records, the
// spelling of their values on each side, and the host's errors thrown as JavaScript's.
//
// ECMA-402 spells option values in camel case ('exceptZero', '2-digit', 'best fit');
// WIT enum cases are kebab case ('except-zero', 'two-digit', 'best-fit').

export const LOCALE_MATCHERS = ['lookup', 'best fit'];

/**
 * The locales argument as a list of tags: none, one tag (a string or an Intl.Locale), or
 * a list of them. Validating and canonicalizing the tags is the host's.
 * @param {unknown} locales
 * @returns {string[]}
 */
export function localeList(locales) {
	if (locales === undefined) return [];

	if (typeof locales === 'string' || isLocale(locales)) return [String(locales)];

	if (locales === null || typeof locales !== 'object')
		throw new TypeError('Intl: locales must be a string or a list of them');
	const list = [];

	for (const tag of locales) {
		if (typeof tag !== 'string' && (tag === null || typeof tag !== 'object'))
			throw new TypeError('Intl: a locale must be a string or an Intl.Locale');
		list.push(String(tag));
	}

	return list;
}

/** Whether `value` is an Intl.Locale (without importing the class, which imports this). */
function isLocale(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof value.maximize === 'function' &&
		typeof value.baseName === 'string'
	);
}

/** The options argument: undefined is no options, anything else must be an object. */
export function optionsObject(options) {
	if (options === undefined) return {};

	if (options === null) throw new TypeError('Intl: options must be an object');

	return options;
}

/**
 * A string option, or undefined when it is not set; one of `allowed` when given.
 * @param {Record<string, unknown>} options
 * @param {string} name
 * @param {string[]} [allowed]
 */
export function textOption(options, name, allowed) {
	const value = options[name];

	if (value === undefined) return undefined;
	const text = String(value);

	if (allowed !== undefined && !allowed.includes(text))
		throw new RangeError(`Intl: ${text} is not a valid value for ${name}`);

	return text;
}

/** A string option as its WIT enum case (see `textOption`). */
export function enumOption(options, name, allowed) {
	const text = textOption(options, name, allowed);

	return text === undefined ? undefined : witCase(text);
}

/** A boolean option, or undefined when it is not set. */
export function boolOption(options, name) {
	const value = options[name];

	return value === undefined ? undefined : Boolean(value);
}

/** An integer option in [min, max], or undefined when it is not set. */
export function digitsOption(options, name, min, max) {
	const value = options[name];

	if (value === undefined) return undefined;
	const digits = Number(value);

	if (!Number.isFinite(digits) || digits < min || digits > max)
		throw new RangeError(`Intl: ${name} must be between ${min} and ${max}`);

	return Math.floor(digits);
}

const MAX_FRACTION_DIGITS = 100;
const MAX_SIGNIFICANT_DIGITS = 21;
const MAX_ROUNDING_INCREMENT = 5000;

/**
 * The digit and rounding options NumberFormat and PluralRules share, as the WIT
 * records name them.
 */
export function roundingOptions(options) {
	return {
		notation: enumOption(options, 'notation', ['standard', 'scientific', 'engineering', 'compact']),
		minimumIntegerDigits: digitsOption(options, 'minimumIntegerDigits', 1, MAX_SIGNIFICANT_DIGITS),
		minimumFractionDigits: digitsOption(options, 'minimumFractionDigits', 0, MAX_FRACTION_DIGITS),
		maximumFractionDigits: digitsOption(options, 'maximumFractionDigits', 0, MAX_FRACTION_DIGITS),
		minimumSignificantDigits: digitsOption(
			options,
			'minimumSignificantDigits',
			1,
			MAX_SIGNIFICANT_DIGITS
		),
		maximumSignificantDigits: digitsOption(
			options,
			'maximumSignificantDigits',
			1,
			MAX_SIGNIFICANT_DIGITS
		),
		roundingIncrement: digitsOption(options, 'roundingIncrement', 1, MAX_ROUNDING_INCREMENT),
		roundingMode: enumOption(options, 'roundingMode', [
			'ceil',
			'floor',
			'expand',
			'trunc',
			'halfCeil',
			'halfFloor',
			'halfExpand',
			'halfTrunc',
			'halfEven'
		]),
		roundingPriority: enumOption(options, 'roundingPriority', [
			'auto',
			'morePrecision',
			'lessPrecision'
		]),
		trailingZeroDisplay: enumOption(options, 'trailingZeroDisplay', ['auto', 'stripIfInteger'])
	};
}

/** The rounding options' enum fields, for `resolvedFields`. */
export const ROUNDING_ENUMS = [
	'notation',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay'
];

/** An ECMA-402 option value as its WIT enum case: 'exceptZero' -> 'except-zero'. */
export function witCase(value) {
	if (value === '2-digit') return 'two-digit';

	if (value === 'best fit') return 'best-fit';
	let out = '';

	for (const ch of value) out += ch >= 'A' && ch <= 'Z' ? `-${ch.toLowerCase()}` : ch;

	return out;
}

/** A WIT enum case as its ECMA-402 option value: 'except-zero' -> 'exceptZero'. */
export function jsCase(value) {
	if (value === 'two-digit') return '2-digit';

	if (value === 'best-fit') return 'best fit';
	let out = '';
	let upper = false;

	for (const ch of value) {
		if (ch === '-') upper = true;
		else {
			out += upper ? ch.toUpperCase() : ch;
			upper = false;
		}
	}

	return out;
}

/** A meshx:intl error (a result's error, thrown by the glue) as JavaScript's own. */
export function hostError(error) {
	if (error !== null && typeof error === 'object') {
		if (error.tag === 'range') return new RangeError(error.val);

		if (error.tag === 'invalid') return new TypeError(error.val);
	}

	return error;
}

/** Calls the host, throwing its error as JavaScript's. */
export function hostCall(call) {
	try {
		return call();
	} catch (error) {
		throw hostError(error);
	}
}

/**
 * Copies a resolved record's set fields onto `target` in ECMA-402's order, the enum
 * fields (`enums`) in their JavaScript spelling.
 */
export function resolvedFields(target, record, order, enums) {
	for (const key of order) {
		const value = record[key];

		if (value === undefined) continue;
		target[key] = enums.includes(key) ? jsCase(value) : value;
	}

	return target;
}

/** Formatted parts as ECMA-402 gives them: `{ type, value }`, plus `source` for ranges. */
export function jsParts(parts) {
	const out = [];

	for (const part of parts)
		out.push(
			part.source === undefined
				? { type: part.kind, value: part.value }
				: { type: part.kind, value: part.value, source: part.source }
		);

	return out;
}
