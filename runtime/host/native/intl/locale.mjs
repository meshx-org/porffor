// Native Intl: porffor:intl/locale, meshx:intl/locale answered by ICU4X linked into the program
// (bridge.mjs). runtime/host/wasi/intl/locale.mjs is the same from the world's import.
import { intlCall } from './bridge.mjs';

/** The process's locale (LC_ALL, LC_MESSAGES, LANG), en-US when it names none. */
export function defaultLocale() {
	return intlCall('locale.default-locale', undefined, []);
}

/** `Intl.getCanonicalLocales`: each tag canonicalized, duplicates dropped. */
export function canonicalize(locales) {
	return intlCall('locale.canonicalize', undefined, [locales]);
}

/** `new Intl.Locale(tag, options).toString()`. */
export function build(tag, options) {
	return intlCall('locale.build', undefined, [tag, options]);
}

/** `Intl.Locale#maximize`: likely subtags added. */
export function maximize(tag) {
	return intlCall('locale.maximize', undefined, [tag]);
}

/** `Intl.Locale#minimize`: likely subtags removed. */
export function minimize(tag) {
	return intlCall('locale.minimize', undefined, [tag]);
}

/** The first day of the week and the weekend (1 = Monday ... 7 = Sunday). */
export function weekInfo(tag) {
	return intlCall('locale.week-info', undefined, [tag]);
}

/** 'ltr' or 'rtl'. */
export function textDirection(tag) {
	return intlCall('locale.text-direction', undefined, [tag]);
}

/** `supportedLocalesOf` of a service ('number-format', ...). */
export function supportedLocales(service, locales) {
	return intlCall('locale.supported-locales', undefined, [service, locales]);
}

/** `Intl.supportedValuesOf` for a key ('time-zone', ...). */
export function supportedValues(key) {
	return intlCall('locale.supported-values', undefined, [key]);
}
