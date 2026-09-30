// Native Intl: porffor:intl/date-time, meshx:intl/date-time answered by ICU4X linked into the
// program (bridge.mjs). runtime/host/wasi/intl/date-time.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

/** meshx:intl's date-time-format resource: an ICU4X formatter, by handle. */
export class DateTimeFormat {
	constructor(handle) {
		this.__h = handle;
	}

	/** A formatter for `locales` and a date-time-options record. */
	static create(locales, options) {
		return new DateTimeFormat(intlCall('date-time-format.create', undefined, [locales, options]));
	}

	format(epochMs) {
		return intlCall('date-time-format.format', this.__h, [epochMs]);
	}

	formatToParts(epochMs) {
		return intlCall('date-time-format.format-to-parts', this.__h, [epochMs]);
	}

	formatRange(startMs, endMs) {
		return intlCall('date-time-format.format-range', this.__h, [startMs, endMs]);
	}

	formatRangeToParts(startMs, endMs) {
		return intlCall('date-time-format.format-range-to-parts', this.__h, [startMs, endMs]);
	}

	resolvedOptions() {
		return intlCall('date-time-format.resolved-options', this.__h, []);
	}
}
