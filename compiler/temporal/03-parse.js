// ---- ISO 8601 strings ----

const asciiLowercase = s => {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[k];
  }
  return out;
};

// The grammar of the spec's Temporal strings, in one pass. kind:
//   'datetime'      TemporalDateTimeString[~Zoned]: a date, maybe a time and an offset; no Z
//   'zoned'         TemporalDateTimeString[+Zoned]: a time zone annotation required, Z allowed
//   'instant'       TemporalInstantString: a date, a time and an offset or Z
//   'yearmonth'     TemporalYearMonthString: YYYY-MM (YYYYMM, ±YYYYYY-MM) or a date-time
//   'monthday'      TemporalMonthDayString: --MM-DD (--MMDD, MM-DD, MMDD) or a date-time
//   'time'          TemporalTimeString: [T]HH[:MM[:SS[.f]]] or a date-time with its time
//   'any'           any of them (a calendar or time zone given as a string)
// Gives { year, month, day, time (or null), z, offsetNs (or null), offsetSubMinute,
// timeZone (the annotation, raw), calendar (raw, or undefined) }.
const parseISOString = (value, kind) => {
  if (kind === 'any') {
    for (let _j = 0, _l = [ 'zoned', 'datetime', 'instant', 'time', 'yearmonth', 'monthday' ]; _j < _l.length; _j++) { const k = _l[_j];
      try {
        return parseISOString(value, k);
      } catch (e) {}
    }
    rangeError(`Invalid ISO 8601 string: ${value}`);
  }
  if (kind === 'time') {
    const c0 = value.charCodeAt(0);
    if (c0 !== 84 && c0 !== 116) {
      try {
        return parseISOString(value, 'datetime-time');
      } catch (e) {}
    }
    return parseISOString(value, 'time-only');
  }

  const s = value;
  const n = s.length;
  let i = 0;
  const bad = () => rangeError(`Invalid ISO 8601 string: ${s}`);
  const code = k => k < n ? s.charCodeAt(k) : -1;
  const isDigit = k => { const c = code(k); return c >= 48 && c <= 57; };
  const digits = count => {
    let v = 0;
    for (let k = 0; k < count; k++) {
      if (!isDigit(i)) bad();
      v = v * 10 + code(i) - 48;
      i++;
    }
    return v;
  };
  // HH[:MM[:SS[.f]]] or HH[MM[SS[.f]]]: the fraction as nanoseconds
  const clock = (maxSecond, allowSeconds) => {
    const hour = digits(2);
    let minute = 0, second = 0, fraction = 0, hasSeconds = false;
    if (hour > 23) bad();
    const colon = code(i) === 58;
    if (colon || isDigit(i)) {
      if (colon) i++;
      minute = digits(2);
      if (minute > 59) bad();
      if ((colon && code(i) === 58) || (!colon && isDigit(i))) {
        if (!allowSeconds) bad();
        if (colon) i++;
        second = digits(2);
        hasSeconds = true;
        if (second > maxSecond) bad();
        if (code(i) === 46 || code(i) === 44) {
          i++;
          let count = 0;
          while (isDigit(i)) {
            if (++count > 9) bad();
            fraction = fraction * 10 + code(i) - 48;
            i++;
          }
          if (count === 0) bad();
          for (let k = count; k < 9; k++) fraction *= 10;
        }
      } else if (!colon && code(i) === 58) bad();
    }
    return { hour, minute, second, fraction, hasSeconds };
  };

  const timeOnly = kind === 'time-only';
  const bracket = s.indexOf('[');
  const bare = bracket < 0 ? s : s.slice(0, bracket);
  let year = 1970, month = 1, day = 1;
  let shortForm = false;

  if (kind === 'yearmonth' && /^([+-]\d{6}|\d{4})-?\d{2}$/.test(bare)) {
    const signed = code(0) === 43 || code(0) === 45;
    i = signed ? 1 : 0;
    year = digits(signed ? 6 : 4);
    if (code(0) === 45) {
      if (year === 0) bad();
      year = -year;
    }
    if (code(i) === 45) i++;
    month = digits(2);
    if (month < 1 || month > 12) bad();
    shortForm = true;
  } else if (kind === 'monthday' && /^(--)?\d{2}-?\d{2}$/.test(bare)) {
    i = code(0) === 45 ? 2 : 0;
    month = digits(2);
    if (code(i) === 45) i++;
    day = digits(2);
    year = 1972;
    if (!isValidISODate(year, month, day)) bad();
    shortForm = true;
  } else if (timeOnly) {
    const c0 = code(0);
    if (c0 === 84 || c0 === 116) i = 1;
    else {
      // without the T, not what also reads as a year-month or a month-day
      const ym = /^(?:[+-]\d{6}|\d{4})-?(\d{2})$/.exec(bare);
      const md = /^(?:--)?(\d{2})-?(\d{2})$/.exec(bare);
      if (ym && +ym[1] >= 1 && +ym[1] <= 12) bad();
      if (md && isValidISODate(1972, +md[1], +md[2])) bad();
    }
  } else {
    const first = code(0);
    if (first === 43 || first === 45) {
      i = 1;
      year = digits(6);
      if (first === 45) {
        if (year === 0) bad();
        year = -year;
      }
    } else year = digits(4);
    const extended = code(i) === 45;
    if (extended) i++;
    month = digits(2);
    if (extended) {
      if (code(i) !== 45) bad();
      i++;
    }
    day = digits(2);
    if (!isValidISODate(year, month, day)) bad();
  }

  // the time and its offset
  let time = null;
  let z = false;
  let offsetNs = null;
  let offsetSubMinute = false;
  const sep = shortForm ? -1 : timeOnly ? 84 : code(i);
  if (sep === 84 || sep === 116 || sep === 32) {
    if (!timeOnly) i++;
    const t = clock(60, true);
    const f = t.fraction;
    time = timeRecord(t.hour, t.minute, t.second === 60 ? 59 : t.second,
      Math.floor(f / 1000000), Math.floor(f / 1000) % 1000, f % 1000);
    const oc = code(i);
    if (oc === 90 || oc === 122) {
      z = true;
      i++;
    } else if (oc === 43 || oc === 45) {
      i++;
      const o = clock(59, true);
      offsetSubMinute = o.hasSeconds;
      const total = BigInt(((o.hour * 60 + o.minute) * 60 + o.second)) * NS_PER.second + BigInt(o.fraction);
      offsetNs = oc === 45 ? -total : total;
    }
  }

  // annotations: a time zone first, then key=value ones
  let timeZone;
  let calendar;
  let calendarCritical = false;
  let calendars = 0;
  let annotations = 0;
  while (code(i) === 91) {
    const end = s.indexOf(']', i);
    if (end < 0) bad();
    let tag = s.slice(i + 1, end);
    i = end + 1;
    let critical = false;
    if (tag.charCodeAt(0) === 33) {
      critical = true;
      tag = tag.slice(1);
    }
    const eq = tag.indexOf('=');
    if (eq < 0) {
      // a time zone: only first, an offset (no seconds) or a name
      if (annotations > 0 || tag.length === 0) bad();
      if (!isTimeZoneIdentifierSyntax(tag)) bad();
      timeZone = tag;
    } else {
      const key = tag.slice(0, eq);
      const val = tag.slice(eq + 1);
      if (key.length === 0) bad();
      for (let k = 0; k < key.length; k++) {
        const c = key.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95 || (k > 0 && ((c >= 48 && c <= 57) || c === 45)))) bad();
      }
      if (!isAnnotationValueSyntax(val)) bad();
      if (key === 'u-ca') {
        // the first calendar is the one; more than one is an error when any is critical
        if (calendars === 0) calendar = val;
        if (critical) calendarCritical = true;
        calendars++;
        if (calendars > 1 && calendarCritical) bad();
      } else if (critical) bad();
    }
    annotations++;
  }
  if (i !== n) bad();

  if ((kind === 'datetime' || kind === 'yearmonth' || kind === 'monthday' || kind === 'time-only') && z) bad();
  if (kind === 'datetime-time' && (time === null || z)) bad();
  if (kind === 'instant' && (time === null || (!z && offsetNs === null))) bad();
  if (kind === 'zoned' && timeZone === undefined) bad();

  return { year, month, day, time, z, offsetNs, offsetSubMinute, timeZone, calendar, shortForm };
};

// an annotation value: alphanumeric components joined by -
const isAnnotationValueSyntax = val => {
  if (val.length === 0 || val.charCodeAt(0) === 45 || val.charCodeAt(val.length - 1) === 45) return false;
  for (let k = 0; k < val.length; k++) {
    const c = val.charCodeAt(k);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!alnum && !(c === 45 && val.charCodeAt(k - 1) !== 45)) return false;
  }
  return true;
};

// TimeZoneIdentifier: an offset to the minute, or an IANA name's syntax
const isTimeZoneIdentifierSyntax = s => {
  const c0 = s.charCodeAt(0);
  if (c0 === 43 || c0 === 45) return parseOffsetIdentifier(s) !== null;
  return /^[A-Za-z._][A-Za-z0-9._+-]*(\/[A-Za-z._][A-Za-z0-9._+-]*)*$/.test(s) &&
    !s.split('/').some(part => part === '.' || part === '..');
};

// ParseTemporalTimeZoneString: an identifier, or a Temporal string's time zone (its annotation,
// Z, or its offset to the minute)
const parseTimeZoneString = s => {
  if (isTimeZoneIdentifierSyntax(s)) return s;
  let parsed;
  try {
    parsed = parseISOString(s, 'any');
  } catch (e) {
    rangeError(`${s} is not a valid time zone`);
  }
  if (parsed.timeZone !== undefined) return parsed.timeZone;
  if (parsed.z) return 'UTC';
  if (parsed.offsetNs !== null) {
    if (parsed.offsetSubMinute) rangeError(`${s} has a sub-minute offset, which is not a time zone`);
    return formatOffsetIdentifier(Number(parsed.offsetNs / NS_PER.minute));
  }
  return rangeError(`${s} names no time zone`);
};

// CanonicalizeCalendar: iso8601 is the one calendar here (ASCII case-insensitively)
const canonicalizeCalendar = id => {
  const lower = asciiLowercase(id);
  if (lower !== 'iso8601') rangeError(`${id} is not a supported calendar`);
  return lower;
};

// ParseTemporalCalendarString: a Temporal string's calendar annotation (or iso8601), else a
// calendar identifier
const parseCalendarString = s => {
  let parsed = null;
  try {
    parsed = parseISOString(s, 'any');
  } catch (e) {}
  if (parsed !== null) return parsed.calendar === undefined ? 'iso8601' : parsed.calendar;
  if (s.length === 0 || !isAnnotationValueSyntax(s)) rangeError(`${s} is not a valid calendar`);
  return s;
};

// ---- durations ----

// ParseTemporalDurationString: [±]P[nY][nM][nW][nD][T[nH][nM][nS]], the last given unit maybe
// with a fraction (of up to 9 digits), which fills the smaller time units
const parseDurationString = s => {
  const bad = () => rangeError(`Invalid duration string: ${s}`);
  let i = 0;
  const n = s.length;
  let sign = 1;
  if (s.charCodeAt(0) === 43 || s.charCodeAt(0) === 45) {
    if (s.charCodeAt(0) === 45) sign = -1;
    i = 1;
  }
  const P = s.charCodeAt(i);
  if (P !== 80 && P !== 112) bad();
  i++;
  const fields = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0, microseconds: 0, nanoseconds: 0 };
  const dateUnits = [ [ 'Y', 'years' ], [ 'M', 'months' ], [ 'W', 'weeks' ], [ 'D', 'days' ] ];
  const timeUnits = [ [ 'H', 'hours' ], [ 'M', 'minutes' ], [ 'S', 'seconds' ] ];
  let inTime = false;
  let any = false;
  let order = 0;
  let fractionSeen = false;
  let timeComponents = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 84 || c === 116) {
      if (inTime) bad();
      inTime = true;
      order = 0;
      i++;
      continue;
    }
    if (fractionSeen) bad();
    // digits, maybe a fraction
    let whole = '';
    while (i < n && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) whole += s[i++];
    if (whole.length === 0) bad();
    let fraction = null;
    if (i < n && (s.charCodeAt(i) === 46 || s.charCodeAt(i) === 44)) {
      i++;
      fraction = '';
      while (i < n && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) fraction += s[i++];
      if (fraction.length === 0 || fraction.length > 9) bad();
    }
    if (i >= n) bad();
    const designator = s[i++].toUpperCase();
    const units = inTime ? timeUnits : dateUnits;
    let k = order;
    while (k < units.length && units[k][0] !== designator) k++;
    if (k >= units.length) bad();
    order = k + 1;
    if (fraction !== null && !inTime) bad();
    const field = units[k][1];
    fields[field] = Number(whole);
    if (inTime) timeComponents++;
    any = true;
    if (fraction !== null) {
      fractionSeen = true;
      // the fraction of this unit, in nanoseconds (floored), spread over the smaller units
      const unitNs = field === 'hours' ? NS_PER.hour : field === 'minutes' ? NS_PER.minute : NS_PER.second;
      const scaled = BigInt(fraction.padEnd(9, '0')) * unitNs / 1000000000n;
      let rest = scaled;
      if (field === 'hours') {
        fields.minutes = Number(rest / NS_PER.minute);
        rest %= NS_PER.minute;
      }
      if (field === 'hours' || field === 'minutes') {
        fields.seconds = Number(rest / NS_PER.second);
        rest %= NS_PER.second;
      }
      fields.milliseconds = Number(rest / 1000000n);
      fields.microseconds = Number((rest / 1000n) % 1000n);
      fields.nanoseconds = Number(rest % 1000n);
    }
  }
  if (!any || (inTime && timeComponents === 0)) bad();
  if (sign === -1) for (const k in fields) fields[k] = fields[k] === 0 ? 0 : -fields[k];
  return fields;
};
