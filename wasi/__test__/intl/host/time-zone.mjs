// meshx:intl/time-zone over the engine's Intl.
import { guarded } from './shared.mjs';

const MINUTES_PER_HOUR = 60;

export const defaultTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export function canonicalize(id) {
	try {
		return new Intl.DateTimeFormat('en', { timeZone: id }).resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

export const offsetAt = (id, epochMs) =>
	guarded(() => {
		const name = new Intl.DateTimeFormat('en', { timeZone: id, timeZoneName: 'longOffset' })
			.formatToParts(epochMs)
			.find((part) => part.type === 'timeZoneName').value;
		const match = /GMT(?<sign>[+-])(?<hours>\d\d):(?<minutes>\d\d)/u.exec(name);

		if (match === null) return 0;
		const minutes = Number(match.groups.hours) * MINUTES_PER_HOUR + Number(match.groups.minutes);

		return match.groups.sign === '-' ? -minutes : minutes;
	});
