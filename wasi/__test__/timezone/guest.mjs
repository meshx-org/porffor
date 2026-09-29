// The timezone fixture: the host's zone as Date and Temporal.Now see it.

export function run() {
	const summer = new Date(Date.UTC(2024, 6, 1, 12));
	const winter = new Date(Date.UTC(2024, 0, 1, 12));

	return JSON.stringify({
		id: Temporal.Now.timeZoneId(),
		offsets: [summer.getTimezoneOffset(), winter.getTimezoneOffset()],
		hours: [summer.getHours(), winter.getHours()]
	});
}
