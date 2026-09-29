// meshx:intl answered by the JavaScript engine's own Intl: what a browser or Node host
// provides, and here what the test maps the fixture's imports to (jco transpile --map,
// one module per interface). Values pass straight through; only enum spellings change
// (WIT kebab case, ECMA-402 camel case) and errors become the interface's `error`.

const ENUM_FIELDS = new Set([
	'localeMatcher',
	'hourCycle',
	'weekday',
	'era',
	'year',
	'month',
	'day',
	'dayPeriod',
	'hour',
	'minute',
	'second',
	'timeZoneName',
	'formatMatcher',
	'dateStyle',
	'timeStyle',
	'style',
	'currencyDisplay',
	'currencySign',
	'unitDisplay',
	'notation',
	'compactDisplay',
	'signDisplay',
	'roundingMode',
	'roundingPriority',
	'trailingZeroDisplay',
	'type',
	'usage',
	'sensitivity',
	'caseFirst'
]);

/** A WIT enum case in ECMA-402's spelling: 'except-zero' -> 'exceptZero'. */
export function jsCase(value) {
	if (value === 'two-digit') return '2-digit';

	if (value === 'best-fit') return 'best fit';

	return value.replace(/-(?<ch>[a-z0-9])/gu, (match) => match[1].toUpperCase());
}

/** An ECMA-402 value as its WIT enum case: 'exceptZero' -> 'except-zero'. */
export function witCase(value) {
	if (value === '2-digit') return 'two-digit';

	if (value === 'best fit') return 'best-fit';

	return value.replace(/[A-Z]/gu, (ch) => `-${ch.toLowerCase()}`);
}

/** A WIT options record as Intl options. */
export function jsOptions(record) {
	const out = {};

	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;

		if (key === 'useGrouping') out.useGrouping = value === 'off' ? false : value;
		else out[key] = ENUM_FIELDS.has(key) ? jsCase(value) : value;
	}

	return out;
}

/** Intl's resolved options as a WIT options record (the fields `keys` names). */
export function witOptions(resolved, keys) {
	const out = {};

	for (const key of keys) {
		const value = resolved[key];

		if (value === undefined) continue;

		if (key === 'useGrouping') out.useGrouping = value === false ? 'off' : value;
		else out[key] = ENUM_FIELDS.has(key) && typeof value === 'string' ? witCase(value) : value;
	}

	return out;
}

/** Runs `call`, throwing Intl's errors as the interface's (jco lowers `payload` as err). */
export function guarded(call) {
	try {
		return call();
	} catch (error) {
		const tag = error instanceof TypeError ? 'invalid' : 'range';

		throw Object.assign(new Error(error.message), {
			payload: { tag, val: String(error.message) }
		});
	}
}

/** Intl's parts as the interface's. */
export const witParts = (list) =>
	list.map((part) => ({ kind: part.type, value: part.value, source: part.source }));

/** A number-value as what Intl.NumberFormat takes: a number, or an exact decimal string. */
export const numberValue = (value) => value.val;
