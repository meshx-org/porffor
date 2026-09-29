// Intl.ListFormat over meshx:intl/list.

import { ListFormat as HostListFormat } from 'meshx:intl/list@0.1.0';
import { supportedLocales } from 'meshx:intl/locale@0.1.0';
import {
	LOCALE_MATCHERS,
	enumOption,
	hostCall,
	jsParts,
	localeList,
	optionsObject
} from './intl-options.mjs';

/** The items of a list to format, which must all be strings. */
function stringItems(list) {
	const items = [];

	if (list === undefined) return items;

	for (const item of list) {
		if (typeof item !== 'string')
			throw new TypeError('Intl.ListFormat: every item must be a string');
		items.push(item);
	}

	return items;
}

/** `Intl.ListFormat`. */
export class ListFormat {
	/**
	 * @param {string | string[]} [locales]
	 * @param {Intl.ListFormatOptions} [options]
	 */
	constructor(locales, options) {
		const given = optionsObject(options);
		const record = {
			localeMatcher: enumOption(given, 'localeMatcher', LOCALE_MATCHERS),
			type: enumOption(given, 'type', ['conjunction', 'disjunction', 'unit']),
			style: enumOption(given, 'style', ['long', 'short', 'narrow'])
		};

		this._host = hostCall(() => HostListFormat.create(localeList(locales), record));
	}

	format(list) {
		return this._host.format(stringItems(list));
	}

	formatToParts(list) {
		return jsParts(this._host.formatToParts(stringItems(list)));
	}

	resolvedOptions() {
		const resolved = this._host.resolvedOptions();

		return { locale: resolved.locale, type: resolved.type, style: resolved.style };
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('list-format', localeList(locales)));
	}
}
