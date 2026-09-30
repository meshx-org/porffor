// Intl.DateTimeFormat over meshx:intl/date-time: the options read and checked here, the
// formatting (patterns, names, time zones) done by the host.

import { DateTimeFormat as HostDateTimeFormat } from 'porffor:intl/date-time';
import { supportedLocales } from 'porffor:intl/locale';
import {
	LOCALE_MATCHERS,
	boolOption,
	digitsOption,
	enumOption,
	hostCall,
	jsParts,
	localeList,
	optionsObject,
	resolvedFields,
	textOption
} from './intl-options.mjs';

const TEXT_WIDTHS = ['narrow', 'short', 'long'];
const NUMERIC_WIDTHS = ['numeric', '2-digit'];
const MONTH_WIDTHS = ['numeric', '2-digit', 'narrow', 'short', 'long'];
const STYLES = ['full', 'long', 'medium', 'short'];

/** resolvedOptions()'s fields after locale / calendar / numberingSystem / timeZone. */
const RESOLVED_ORDER = [
	'hourCycle',
	'hour12',
	'weekday',
	'era',
	'year',
	'month',
	'day',
	'dayPeriod',
	'hour',
	'minute',
	'second',
	'fractionalSecondDigits',
	'timeZoneName',
	'dateStyle',
	'timeStyle'
];
const RESOLVED_ENUMS = RESOLVED_ORDER.filter(
	(key) => key !== 'hour12' && key !== 'fractionalSecondDigits'
);

/** The date-time-options record for `options`. */
function dateTimeOptions(options) {
	return {
		localeMatcher: enumOption(options, 'localeMatcher', LOCALE_MATCHERS),
		calendar: textOption(options, 'calendar'),
		numberingSystem: textOption(options, 'numberingSystem'),
		hour12: boolOption(options, 'hour12'),
		hourCycle: enumOption(options, 'hourCycle', ['h11', 'h12', 'h23', 'h24']),
		timeZone: textOption(options, 'timeZone'),
		weekday: enumOption(options, 'weekday', TEXT_WIDTHS),
		era: enumOption(options, 'era', TEXT_WIDTHS),
		year: enumOption(options, 'year', NUMERIC_WIDTHS),
		month: enumOption(options, 'month', MONTH_WIDTHS),
		day: enumOption(options, 'day', NUMERIC_WIDTHS),
		dayPeriod: enumOption(options, 'dayPeriod', TEXT_WIDTHS),
		hour: enumOption(options, 'hour', NUMERIC_WIDTHS),
		minute: enumOption(options, 'minute', NUMERIC_WIDTHS),
		second: enumOption(options, 'second', NUMERIC_WIDTHS),
		fractionalSecondDigits: digitsOption(options, 'fractionalSecondDigits', 1, 3),
		timeZoneName: enumOption(options, 'timeZoneName', [
			'short',
			'long',
			'shortOffset',
			'longOffset',
			'shortGeneric',
			'longGeneric'
		]),
		formatMatcher: enumOption(options, 'formatMatcher', ['basic', 'best fit']),
		dateStyle: enumOption(options, 'dateStyle', STYLES),
		timeStyle: enumOption(options, 'timeStyle', STYLES)
	};
}

/** A Date, a time value or nothing (now) as milliseconds since the epoch. */
function timeValue(date) {
	const time =
		date === undefined ? Date.now() : date instanceof Date ? date.getTime() : Number(date);

	if (!Number.isFinite(time)) throw new RangeError('Invalid time value');

	return time;
}

/** Both ends of a range, which formatRange requires. */
function rangeValues(start, end) {
	if (start === undefined || end === undefined)
		throw new TypeError('Intl.DateTimeFormat: formatRange needs a start and an end');

	return [timeValue(start), timeValue(end)];
}

/** `Intl.DateTimeFormat`. */
export class DateTimeFormat {
	/**
	 * @param {string | string[]} [locales]
	 * @param {Intl.DateTimeFormatOptions} [options]
	 */
	constructor(locales, options) {
		const record = dateTimeOptions(optionsObject(options));

		this._host = hostCall(() => HostDateTimeFormat.create(localeList(locales), record));
		this._format = undefined;
	}

	/** `format`, bound to this formatter as ECMA-402 has it (so it can be passed around). */
	get format() {
		if (this._format === undefined) this._format = (date) => this.formatTime(date);

		return this._format;
	}

	/** The formatted time; `format` without the binding. */
	formatTime(date) {
		const time = timeValue(date);

		return hostCall(() => this._host.format(time));
	}

	formatToParts(date) {
		const time = timeValue(date);

		return jsParts(hostCall(() => this._host.formatToParts(time)));
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

		return resolvedFields(
			{
				locale: resolved.locale,
				calendar: resolved.calendar,
				numberingSystem: resolved.numberingSystem,
				timeZone: resolved.timeZone
			},
			resolved.options,
			RESOLVED_ORDER,
			RESOLVED_ENUMS
		);
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('date-time-format', localeList(locales)));
	}
}
