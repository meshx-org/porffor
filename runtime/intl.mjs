// The Intl namespace (ECMA-402) over meshx:intl, the platform's locale interface: the host
// has the locale data (a browser's or Node's own Intl, ICU4X natively), the guest carries
// none. Injected into guests whose world includes meshx:intl/imports. Its interfaces are
// porffor:intl/* (the world's imports on WASI, runtime/host/wasi/intl; natively ICU4X linked
// into the program, runtime/host/native/intl over runtime/intl's C ABI).
//
// Not here yet: Intl.RelativeTimeFormat, DisplayNames, Segmenter, DurationFormat; and
// the prototype methods that reach Intl (toLocaleString, localeCompare, normalize),
// which are Porffor's builtins.

import { canonicalize, supportedValues } from 'porffor:intl/locale';
import { Collator } from './intl-collator.mjs';
import { DateTimeFormat } from './intl-date-time-format.mjs';
import { ListFormat } from './intl-list-format.mjs';
import { Locale } from './intl-locale.mjs';
import { NumberFormat } from './intl-number-format.mjs';
import { hostCall, localeList, textOption, witCase } from './intl-options.mjs';
import { PluralRules } from './intl-plural-rules.mjs';

const SUPPORTED_KEYS = ['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone', 'unit'];

/** `Intl`. */
export const Intl = /* @__PURE__ */ Object.freeze({
	Collator,
	DateTimeFormat,
	ListFormat,
	Locale,
	NumberFormat,
	PluralRules,

	/** Each tag canonicalized, duplicates dropped. */
	getCanonicalLocales(locales) {
		return hostCall(() => canonicalize(localeList(locales)));
	},

	/** The values the host supports for `key`: its calendars, currencies, time zones, ... */
	supportedValuesOf(key) {
		const name = textOption({ key }, 'key', SUPPORTED_KEYS);

		return Array.from(supportedValues(witCase(name)));
	}
});
