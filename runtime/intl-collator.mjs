// Intl.Collator over meshx:intl/text.

import { supportedLocales } from 'porffor:intl/locale';
import { Collator as HostCollator } from 'porffor:intl/text';
import {
	LOCALE_MATCHERS,
	boolOption,
	enumOption,
	hostCall,
	localeList,
	optionsObject,
	resolvedFields,
	textOption
} from './intl-options.mjs';

const RESOLVED_ORDER = [
	'usage',
	'sensitivity',
	'ignorePunctuation',
	'collation',
	'numeric',
	'caseFirst'
];

/** `Intl.Collator`. */
export class Collator {
	/**
	 * @param {string | string[]} [locales]
	 * @param {Intl.CollatorOptions} [options]
	 */
	constructor(locales, options) {
		const given = optionsObject(options);
		const record = {
			localeMatcher: enumOption(given, 'localeMatcher', LOCALE_MATCHERS),
			usage: enumOption(given, 'usage', ['sort', 'search']),
			sensitivity: enumOption(given, 'sensitivity', ['base', 'accent', 'case', 'variant']),
			ignorePunctuation: boolOption(given, 'ignorePunctuation'),
			numeric: boolOption(given, 'numeric'),
			caseFirst: enumOption(given, 'caseFirst', ['upper', 'lower', 'false']),
			collation: textOption(given, 'collation')
		};

		this._host = hostCall(() => HostCollator.create(localeList(locales), record));
		this._compare = undefined;
	}

	/** `compare`, bound to this collator as ECMA-402 has it (so `list.sort(c.compare)` works). */
	get compare() {
		if (this._compare === undefined)
			this._compare = (left, right) => this.compareStrings(left, right);

		return this._compare;
	}

	/** -1, 0 or 1; `compare` without the binding. */
	compareStrings(left, right) {
		return this._host.compare(String(left), String(right));
	}

	resolvedOptions() {
		const resolved = this._host.resolvedOptions();
		// the collation in its place among the options, as ECMA-402 orders them
		const options = Object.assign({}, resolved.options, { collation: resolved.collation });

		return resolvedFields({ locale: resolved.locale }, options, RESOLVED_ORDER, [
			'usage',
			'sensitivity',
			'caseFirst'
		]);
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('collator', localeList(locales)));
	}
}
