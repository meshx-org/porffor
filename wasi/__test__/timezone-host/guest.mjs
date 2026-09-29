// The time zone the timezone fixture runs in: Europe/Budapest, whose 2024 summer time ran
// from 31 March to 27 October (01:00 UTC each).

const SUMMER_START = Date.UTC(2024, 2, 31, 1) / 1000;
const SUMMER_END = Date.UTC(2024, 9, 27, 1) / 1000;

export const timezone = {
	ianaId: () => 'Europe/Budapest',
	utcOffset(when) {
		const seconds = Number(when.seconds);
		const summer = seconds >= SUMMER_START && seconds < SUMMER_END;

		return (summer ? 7200 : 3600) * 1e9;
	},
	toDebugString: () => 'Europe/Budapest'
};
