// Formats a fixed date and numbers with every Intl class; the test compares the result
// with Node's own Intl on the same inputs.
const WHEN = Date.UTC(2026, 8, 26, 14, 5, 9, 250);

export function run() {
	const date = new Intl.DateTimeFormat('en-US', {
		timeZone: 'UTC',
		dateStyle: 'full',
		timeStyle: 'long'
	});
	const parts = new Intl.DateTimeFormat('de-DE', {
		timeZone: 'Europe/Berlin',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
	const compact = new Intl.NumberFormat('en', { notation: 'compact', signDisplay: 'exceptZero' });
	const plural = new Intl.PluralRules('en-US', { type: 'ordinal' });
	const list = new Intl.ListFormat('en', { type: 'disjunction' });
	const locale = new Intl.Locale('en', { region: 'GB', calendar: 'gregory', numeric: true });
	const collator = new Intl.Collator('sv');

	return JSON.stringify({
		date: date.format(WHEN),
		dateOptions: date.resolvedOptions(),
		parts: parts.formatToParts(new Date(WHEN)),
		range: date.formatRange(WHEN, WHEN + 86400000),
		money: money.format(1234567.891),
		// exact decimals, past what a float holds
		decimal: money.format('12345678901234567890.125'),
		bigint: money.format(12345678901234567890n * 1000n + 1n),
		compact: [compact.format(0), compact.format(1234), compact.format(-98765432)],
		compactOptions: compact.resolvedOptions(),
		ordinals: [1, 2, 3, 4, 11, 22].map((count) => plural.select(count)),
		pluralOptions: plural.resolvedOptions(),
		list: list.format(['red', 'green', 'blue']),
		locale: {
			tag: locale.toString(),
			baseName: locale.baseName,
			region: locale.region,
			calendar: locale.calendar,
			numeric: locale.numeric,
			maximized: new Intl.Locale('zh-TW').maximize().toString(),
			week: new Intl.Locale('en-US').getWeekInfo(),
			text: new Intl.Locale('ar').getTextInfo()
		},
		sorted: ['z', 'ä', 'a', 'ö'].sort(collator.compare),
		canonical: Intl.getCanonicalLocales(['EN-us', 'zh-hant-tw']),
		zones: Intl.supportedValuesOf('timeZone').includes('Europe/Berlin')
	});
}
