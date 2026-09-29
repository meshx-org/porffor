// meshx:intl/list over the engine's Intl.
import { guarded, jsOptions, witParts } from './shared.mjs';

export class ListFormat {
	constructor(format) {
		this.inner = format;
	}

	static create(locales, options) {
		return guarded(() => new ListFormat(new Intl.ListFormat(locales, jsOptions(options))));
	}

	format(items) {
		return this.inner.format(items);
	}

	formatToParts(items) {
		return witParts(this.inner.formatToParts(items));
	}

	resolvedOptions() {
		return this.inner.resolvedOptions();
	}
}
