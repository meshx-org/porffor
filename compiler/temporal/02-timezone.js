// ---- time zones ----
//
// Known here: UTC and the names that mean it, fixed offsets (+01:00), and the host's own zone
// (its IANA name, with offsets from the host at any instant). Other IANA names need zone data
// this runtime does not carry: they are not available time zones (a RangeError).

const UTC_NAMES = [
  'UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu', 'Etc/UCT', 'UCT',
  'Etc/Greenwich', 'Greenwich', 'Etc/GMT0', 'GMT0', 'Etc/GMT+0', 'GMT+0', 'Etc/GMT-0', 'GMT-0'
];

const hostTimeZone = () => __Porffor_tz_id();

// an offset time zone identifier (±HH, ±HHMM, ±HH:MM) as minutes, or null
const parseOffsetIdentifier = s => {
  const sign = s.charCodeAt(0);
  if (sign !== 43 && sign !== 45) return null;
  const digit = k => { const c = s.charCodeAt(k); return c >= 48 && c <= 57 ? c - 48 : -1; };
  if (s.length < 3 || digit(1) < 0 || digit(2) < 0) return null;
  const hours = digit(1) * 10 + digit(2);
  let minutes = 0;
  if (s.length > 3) {
    let k = 3;
    if (s.charCodeAt(k) === 58) k++;
    if (s.length !== k + 2 || digit(k) < 0 || digit(k + 1) < 0) return null;
    minutes = digit(k) * 10 + digit(k + 1);
  }
  if (hours > 23 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return sign === 45 ? -total : total;
};

// FormatOffsetTimeZoneIdentifier
const formatOffsetIdentifier = minutes => {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${padNumber(Math.floor(abs / 60), 2)}:${padNumber(abs % 60, 2)}`;
};

// GetAvailableNamedTimeZoneIdentifier: the available name matching s (ASCII case-insensitively)
const availableNamedTimeZone = s => {
  const lower = s.toLowerCase();
  for (let _j = 0, _l = UTC_NAMES; _j < _l.length; _j++) { const name = _l[_j]; if (name.toLowerCase() === lower) return name; }
  const host = hostTimeZone();
  if (host.toLowerCase() === lower && parseOffsetIdentifier(host) === null) return host;
  return null;
};

// a time zone identifier (offset or name) normalized, or a RangeError
const normalizeTimeZoneIdentifier = s => {
  const minutes = parseOffsetIdentifier(s);
  if (minutes !== null) return formatOffsetIdentifier(minutes);
  const c0 = s.charCodeAt(0);
  if (c0 === 43 || c0 === 45) rangeError(`${s} is not a valid time zone`);
  const named = availableNamedTimeZone(s);
  if (named === null) rangeError(`${s} is not an available time zone`);
  return named;
};

const isUTCZone = tz => UTC_NAMES.includes(tz);

// the offset of a time zone at an instant (BigInt ns)
const offsetNsFor = (tz, epochNs) => {
  if (isUTCZone(tz)) return 0n;
  const minutes = parseOffsetIdentifier(tz);
  if (minutes !== null) return BigInt(minutes) * NS_PER.minute;
  const ms = Number(floorDiv(epochNs, 1000000n));
  return BigInt(__Porffor_tz_offsetMs(ms)) * 1000000n;
};

const isFixedOffsetZone = tz => isUTCZone(tz) || parseOffsetIdentifier(tz) !== null;

// the local date-time of an instant in a time zone
const isoDateTimeFor = (tz, epochNs) => isoDateTimeFromEpochNs(epochNs, offsetNsFor(tz, epochNs));

// GetPossibleEpochNanoseconds: the instants whose local time in tz is the date-time (none in
// a gap, two in a repeat)
const possibleEpochNs = (tz, date, time) => {
  const local = utcEpochNs(date, time);
  let out;
  if (isFixedOffsetZone(tz)) {
    const ns = local - offsetNsFor(tz, local);
    checkISODaysRange(isoDateTimeFromEpochNs(ns).date);
    out = [ ns ];
  }
  else {
    const before = offsetNsFor(tz, local - NS_PER_DAY);
    const after = offsetNsFor(tz, local + NS_PER_DAY);
    const candidates = before === after ? [ local - before ] : [ local - before, local - after ];
    out = [];
    for (let _j = 0, _l = candidates; _j < _l.length; _j++) { const c = _l[_j];
      if (offsetNsFor(tz, c) === local - c && !out.includes(c)) out.push(c);
    }
    out.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }
  for (let _j = 0, _l = out; _j < _l.length; _j++) { const ns = _l[_j]; checkEpochNs(ns); }
  return out;
};

// DisambiguatePossibleEpochNanoseconds / GetEpochNanosecondsFor
const epochNsFor = (tz, date, time, disambiguation) => {
  checkISODateTimeWithinLimits(date, time);
  const possible = possibleEpochNs(tz, date, time);
  if (possible.length === 1) return possible[0];
  if (possible.length > 1) {
    if (disambiguation === 'reject') rangeError('The date-time is ambiguous in its time zone');
    return disambiguation === 'later' ? possible[possible.length - 1] : possible[0];
  }
  if (disambiguation === 'reject') rangeError('The date-time does not exist in its time zone');
  const local = utcEpochNs(date, time);
  const offsetBefore = offsetNsFor(tz, local - NS_PER_DAY);
  const offsetAfter = offsetNsFor(tz, local + NS_PER_DAY);
  const gap = offsetAfter - offsetBefore;
  if (disambiguation === 'earlier') {
    const shifted = isoDateTimeFromEpochNs(local - gap);
    return possibleEpochNs(tz, shifted.date, shifted.time)[0];
  }
  const shifted = isoDateTimeFromEpochNs(local + gap);
  const after = possibleEpochNs(tz, shifted.date, shifted.time);
  return after[after.length - 1];
};

// GetStartOfDay: the first instant of a date in a time zone
const startOfDay = (tz, date) => {
  const possible = possibleEpochNs(tz, date, MIDNIGHT);
  if (possible.length > 0) return possible[0];
  // midnight is skipped: the day starts where the gap ends
  const local = utcEpochNs(date, MIDNIGHT);
  const out = local - offsetNsFor(tz, local + NS_PER_DAY);
  checkEpochNs(out);
  return out;
};

// InterpretISODateTimeOffset: the instant of a date-time with an offset, as the offset option says
const interpretISODateTimeOffset = (date, time, offsetBehaviour, offsetNs, tz, disambiguation, offsetOption, matchMinutes) => {
  if (time === 'start-of-day') return startOfDay(tz, date);
  if (offsetBehaviour === 'wall' || (offsetBehaviour === 'option' && offsetOption === 'ignore'))
    return epochNsFor(tz, date, time, disambiguation);
  if (offsetBehaviour === 'exact' || (offsetBehaviour === 'option' && offsetOption === 'use')) {
    const ns = utcEpochNs(date, time) - offsetNs;
    checkISODaysRange(isoDateTimeFromEpochNs(ns).date);
    checkEpochNs(ns);
    return ns;
  }
  checkISODaysRange(date);
  const possible = possibleEpochNs(tz, date, time);
  const local = utcEpochNs(date, time);
  for (let _j = 0, _l = possible; _j < _l.length; _j++) { const candidate = _l[_j];
    const candidateOffset = local - candidate;
    const rounded = roundBigIntToIncrement(candidateOffset, NS_PER.minute, 'halfExpand');
    if (candidateOffset === offsetNs || (matchMinutes && rounded === offsetNs)) return candidate;
  }
  if (offsetOption === 'reject') rangeError('The offset does not agree with the time zone');
  return epochNsFor(tz, date, time, disambiguation);
};

// FormatUTCOffsetNanoseconds: ±HH:MM, with :SS and a fraction only when there are any
const formatOffsetNs = offsetNs => {
  const sign = offsetNs < 0n ? '-' : '+';
  const abs = bigAbs(offsetNs);
  const hours = abs / NS_PER.hour;
  const minutes = (abs / NS_PER.minute) % 60n;
  const seconds = (abs / NS_PER.second) % 60n;
  const sub = abs % NS_PER.second;
  let out = `${sign}${padNumber(hours, 2)}:${padNumber(minutes, 2)}`;
  if (seconds !== 0n || sub !== 0n) {
    out += `:${padNumber(seconds, 2)}`;
    if (sub !== 0n) out += `.${padNumber(sub, 9).replace(/0+$/, '')}`;
  }
  return out;
};

// FormatDateTimeUTCOffsetRounded: to the minute
const formatOffsetRounded = offsetNs => {
  const minutes = Number(roundBigIntToIncrement(offsetNs, NS_PER.minute, 'halfExpand') / NS_PER.minute);
  return formatOffsetIdentifier(minutes);
};

// the next or previous change of a time zone's offset after an instant (null for none)
const timeZoneTransition = (tz, epochNs, direction) => {
  if (isFixedOffsetZone(tz)) return null;
  // the host's zone: look a week at a time, up to 50 years, then narrow to the millisecond
  const step = 7n * NS_PER_DAY * (direction === 'next' ? 1n : -1n);
  const start = offsetNsFor(tz, epochNs);
  let a = epochNs;
  for (let i = 0; i < 2600; i++) {
    const b = a + step;
    if (!isValidEpochNs(b)) return null;
    if (offsetNsFor(tz, b) !== start) {
      let lo = direction === 'next' ? a : b, hi = direction === 'next' ? b : a;
      const loOffset = offsetNsFor(tz, lo);
      while (hi - lo > 1000000n) {
        const mid = floorDiv(lo + hi, 2n);
        if (offsetNsFor(tz, mid) === loOffset) lo = mid;
        else hi = mid;
      }
      return floorDiv(hi + 999999n, 1000000n) * 1000000n;
    }
    a = b;
  }
  return null;
};
