// Native Intl: porffor:intl/number, meshx:intl/number answered by ICU4X linked into the program
// (bridge.mjs). runtime/host/wasi/intl/number.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

// A number-value as JSON carries it: JSON has no NaN, infinities or -0 (JSON.stringify writes
// null and 0), so those go as the decimal strings ICU4X reads them from
const numberValue = (value) => {
	if (value.tag !== 'float') return value;

	const n = value.val;

	if (n !== n || n === Infinity || n === -Infinity) return { tag: 'decimal', val: String(n) };

	if (n === 0 && 1 / n < 0) return { tag: 'decimal', val: '-0' };

	return value;
};

/** meshx:intl's number-format resource: an ICU4X formatter, by handle. */
export class NumberFormat {
	constructor(handle) {
		this.__h = handle;
	}

	/** A formatter for `locales` and a number-options record. */
	static create(locales, options) {
		return new NumberFormat(intlCall('number-format.create', undefined, [locales, options]));
	}

	format(value) {
		return intlCall('number-format.format', this.__h, [numberValue(value)]);
	}

	formatToParts(value) {
		return intlCall('number-format.format-to-parts', this.__h, [numberValue(value)]);
	}

	formatRange(start, end) {
		return intlCall('number-format.format-range', this.__h, [numberValue(start), numberValue(end)]);
	}

	formatRangeToParts(start, end) {
		return intlCall('number-format.format-range-to-parts', this.__h, [
			numberValue(start),
			numberValue(end)
		]);
	}

	resolvedOptions() {
		return intlCall('number-format.resolved-options', this.__h, []);
	}
}
