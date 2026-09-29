// meshx:intl/locale over the engine's Intl.
import { guarded, jsCase, jsOptions } from './shared.mjs';

const SERVICES = {
	collator: Intl.Collator,
	'date-time-format': Intl.DateTimeFormat,
	'list-format': Intl.ListFormat,
	'number-format': Intl.NumberFormat,
	'plural-rules': Intl.PluralRules
};

export const defaultLocale = () => new Intl.DateTimeFormat().resolvedOptions().locale;

export const canonicalize = (locales) => guarded(() => Intl.getCanonicalLocales(locales));

export const build = (tag, options) =>
	guarded(() => new Intl.Locale(tag, jsOptions(options)).toString());

export const maximize = (tag) => guarded(() => new Intl.Locale(tag).maximize().toString());

export const minimize = (tag) => guarded(() => new Intl.Locale(tag).minimize().toString());

export const weekInfo = (tag) =>
	guarded(() => {
		const week = new Intl.Locale(tag).getWeekInfo();

		return {
			firstDay: week.firstDay,
			weekend: Uint8Array.from(week.weekend)
		};
	});

export const textDirection = (tag) => guarded(() => new Intl.Locale(tag).getTextInfo().direction);

export const supportedLocales = (service, locales) =>
	guarded(() => SERVICES[service].supportedLocalesOf(locales));

export const supportedValues = (key) => Intl.supportedValuesOf(jsCase(key));
