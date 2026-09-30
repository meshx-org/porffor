// Intl.Locale over meshx:intl/locale. The host canonicalizes the tag (and applies the
// options); the getters read the canonical tag, so they need no locale data.

import { build, maximize, minimize, textDirection, weekInfo } from 'porffor:intl/locale';
import { boolOption, hostCall, optionsObject, textOption } from './intl-options.mjs';

/** The Unicode extension keys Intl.Locale has getters for, by key. */
const EXTENSION_KEYS = {
	ca: 'calendar',
	co: 'collation',
	hc: 'hourCycle',
	kf: 'caseFirst',
	kn: 'numeric',
	nu: 'numberingSystem'
};

const isDigit = (ch) => ch >= '0' && ch <= '9';

/** Whether `subtag` is a variant: 5 to 8 characters, or 4 starting with a digit. */
function isVariant(subtag) {
	return subtag.length >= 5 || (subtag.length === 4 && isDigit(subtag[0]));
}

/** Whether `subtag` is a region: 2 letters or 3 digits. */
function isRegion(subtag) {
	return subtag.length === 2 ? !isDigit(subtag[0]) : subtag.length === 3 && isDigit(subtag[0]);
}

/** The `-u-` extension of a canonical tag, from `start` (the subtag after `u`). */
function readExtension(subtags, start, out) {
	let at = start;
	let key;

	for (; at < subtags.length && subtags[at].length !== 1; at++) {
		const subtag = subtags[at];

		if (subtag.length === 2) {
			key = EXTENSION_KEYS[subtag];

			// a key with no value is true
			if (key !== undefined) out[key] = 'true';
		} else if (key !== undefined) out[key] = out[key] === 'true' ? subtag : `${out[key]}-${subtag}`;
	}

	return at;
}

/** A canonical tag's parts: language, script, region, the base name and extension keys. */
function parseTag(tag) {
	const subtags = tag.split('-');
	const out = { language: subtags[0] };
	let at = 1;

	if (at < subtags.length && subtags[at].length === 4 && !isDigit(subtags[at][0]))
		out.script = subtags[at++];

	if (at < subtags.length && isRegion(subtags[at])) out.region = subtags[at++];

	while (at < subtags.length && isVariant(subtags[at])) at++;
	out.baseName = subtags.slice(0, at).join('-');

	while (at < subtags.length) {
		const singleton = subtags[at++];

		// private use runs to the end
		if (singleton === 'x') break;

		if (singleton === 'u') at = readExtension(subtags, at, out);
		else while (at < subtags.length && subtags[at].length !== 1) at++;
	}

	return out;
}

/** `Intl.Locale`. */
export class Locale {
	/**
	 * @param {string | Locale} tag
	 * @param {Intl.LocaleOptions} [options]
	 */
	constructor(tag, options) {
		if (typeof tag !== 'string' && !(tag instanceof Locale))
			throw new TypeError('Intl.Locale: the tag must be a string or an Intl.Locale');
		const given = optionsObject(options);
		const record = {
			language: textOption(given, 'language'),
			script: textOption(given, 'script'),
			region: textOption(given, 'region'),
			calendar: textOption(given, 'calendar'),
			collation: textOption(given, 'collation'),
			hourCycle: textOption(given, 'hourCycle', ['h11', 'h12', 'h23', 'h24']),
			caseFirst: textOption(given, 'caseFirst', ['upper', 'lower', 'false']),
			numeric: boolOption(given, 'numeric'),
			numberingSystem: textOption(given, 'numberingSystem')
		};

		this._tag = hostCall(() => build(String(tag), record));
		this._parts = parseTag(this._tag);
	}

	get baseName() {
		return this._parts.baseName;
	}

	get language() {
		return this._parts.language;
	}

	get script() {
		return this._parts.script;
	}

	get region() {
		return this._parts.region;
	}

	get calendar() {
		return this._parts.calendar;
	}

	get collation() {
		return this._parts.collation;
	}

	get hourCycle() {
		return this._parts.hourCycle;
	}

	get caseFirst() {
		return this._parts.caseFirst;
	}

	get numeric() {
		return this._parts.numeric === 'true';
	}

	get numberingSystem() {
		return this._parts.numberingSystem;
	}

	/** The locale with its likely subtags added: 'en' -> 'en-Latn-US'. */
	maximize() {
		return new Locale(hostCall(() => maximize(this._tag)));
	}

	/** The locale with the subtags `maximize` would add removed. */
	minimize() {
		return new Locale(hostCall(() => minimize(this._tag)));
	}

	/** The first day of the week (1 = Monday) and the weekend days. */
	getWeekInfo() {
		const week = hostCall(() => weekInfo(this._tag));

		return { firstDay: week.firstDay, weekend: Array.from(week.weekend) };
	}

	/** The direction text runs in: 'ltr' or 'rtl'. */
	getTextInfo() {
		return { direction: hostCall(() => textDirection(this._tag)) };
	}

	toString() {
		return this._tag;
	}
}
