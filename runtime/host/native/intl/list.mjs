// Native Intl: porffor:intl/list, meshx:intl/list answered by ICU4X linked into the program
// (bridge.mjs). runtime/host/wasi/intl/list.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

/** meshx:intl's list-format resource: an ICU4X formatter, by handle. */
export class ListFormat {
	constructor(handle) {
		this.__h = handle;
	}

	/** A formatter for `locales` and a list-options record. */
	static create(locales, options) {
		return new ListFormat(intlCall('list-format.create', undefined, [locales, options]));
	}

	format(items) {
		return intlCall('list-format.format', this.__h, [items]);
	}

	formatToParts(items) {
		return intlCall('list-format.format-to-parts', this.__h, [items]);
	}

	resolvedOptions() {
		return intlCall('list-format.resolved-options', this.__h, []);
	}
}
