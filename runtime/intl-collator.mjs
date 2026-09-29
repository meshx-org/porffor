// Intl.Collator over meshx:intl/text.

import { supportedLocales } from 'meshx:intl/locale@0.1.0';
import { Collator as HostCollator } from 'meshx:intl/text@0.1.0';
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
		const out = resolvedFields({ locale: resolved.locale }, resolved.options, RESOLVED_ORDER, [
			'usage',
			'sensitivity',
			'caseFirst'
		]);

		out.collation = resolved.collation;

		return out;
	}

	static supportedLocalesOf(locales) {
		return hostCall(() => supportedLocales('collator', localeList(locales)));
	}
}
