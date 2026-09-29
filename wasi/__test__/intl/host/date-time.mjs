// meshx:intl/date-time over the engine's Intl.
import { guarded, jsOptions, witOptions, witParts } from './shared.mjs';

const KEYS = [
	'hour12',
	'hourCycle',
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

export class DateTimeFormat {
	constructor(format) {
		this.inner = format;
	}

	static create(locales, options) {
		return guarded(() => new DateTimeFormat(new Intl.DateTimeFormat(locales, jsOptions(options))));
	}

	format(epochMs) {
		return guarded(() => this.inner.format(epochMs));
	}

	formatToParts(epochMs) {
		return guarded(() => witParts(this.inner.formatToParts(epochMs)));
	}

	formatRange(start, end) {
		return guarded(() => this.inner.formatRange(start, end));
	}

	formatRangeToParts(start, end) {
		return guarded(() => witParts(this.inner.formatRangeToParts(start, end)));
	}

	resolvedOptions() {
		const resolved = this.inner.resolvedOptions();

		return {
			locale: resolved.locale,
			calendar: resolved.calendar,
			numberingSystem: resolved.numberingSystem,
			timeZone: resolved.timeZone,
			options: witOptions(resolved, KEYS)
		};
	}
}
