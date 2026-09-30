// Native Intl: porffor:intl/time-zone, meshx:intl/time-zone answered by ICU4X linked into the
// program (bridge.mjs; jiff's IANA database). runtime/host/wasi/intl/time-zone.mjs is the same
// from the world's import.
import { intlCall } from './bridge.mjs';

/** The system's time zone (TZ, or the zone it is set to), UTC when it has no IANA name. */
export function defaultTimeZone() {
	return intlCall('time-zone.default-time-zone', undefined, []);
}

/** The canonical IANA id for `id`, or undefined when it names no zone. */
export function canonicalize(id) {
	return intlCall('time-zone.canonicalize', undefined, [id]);
}

/** The zone's offset from UTC at an instant (milliseconds since the epoch), in minutes. */
export function offsetAt(id, epochMs) {
	return intlCall('time-zone.offset-at', undefined, [id, epochMs]);
}
