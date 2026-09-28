// ---- internal slots ----
//
// Each Temporal object's slots live here, keyed by the object: it has no own properties, as
// the spec's objects have none (brand checks read this, not the object)
const SLOTS = new WeakMap();
const slots = (value, brand, method) => {
  const s = isObject(value) ? SLOTS.get(value) : undefined;
  if (s === undefined || s.brand !== brand) typeError(`${method} called on an object that is not a Temporal.${brand}`);
  return s;
};
const brandOf = value => {
  const s = isObject(value) ? SLOTS.get(value) : undefined;
  return s === undefined ? undefined : s.brand;
};
const slotsIf = (value, brand) => {
  const s = isObject(value) ? SLOTS.get(value) : undefined;
  return s !== undefined && s.brand === brand ? s : undefined;
};

// ---- identifiers from values ----

// ToTemporalTimeZoneIdentifier
const toTimeZoneIdentifier = value => {
  const zdt = slotsIf(value, 'ZonedDateTime');
  if (zdt !== undefined) return zdt.timeZone;
  if (typeof value !== 'string') typeError('A time zone must be a string or a Temporal.ZonedDateTime');
  return normalizeTimeZoneIdentifier(parseTimeZoneString(value));
};

// the calendar of a Temporal object that has one
const temporalCalendar = value => {
  const b = brandOf(value);
  if (b === 'PlainDate' || b === 'PlainDateTime' || b === 'PlainYearMonth' || b === 'PlainMonthDay' || b === 'ZonedDateTime')
    return SLOTS.get(value).calendar;
  return undefined;
};

// ToTemporalCalendarIdentifier
const toCalendarIdentifier = value => {
  const own = temporalCalendar(value);
  if (own !== undefined) return own;
  if (typeof value !== 'string') typeError('A calendar must be a string or a Temporal object with one');
  return canonicalizeCalendar(parseCalendarString(value));
};

// GetTemporalCalendarIdentifierWithISODefault
const calendarWithISODefault = item => {
  const own = temporalCalendar(item);
  if (own !== undefined) return own;
  const calendar = item.calendar;
  if (calendar === undefined) return 'iso8601';
  return toCalendarIdentifier(calendar);
};

// ---- calendar fields ----

// the fields there are, in the order they are read (alphabetical), with their conversions
const FIELD_ORDER = [ 'day', 'hour', 'microsecond', 'millisecond', 'minute', 'month', 'monthCode', 'nanosecond', 'offset', 'second', 'timeZone', 'year' ];

// ToMonthCode: a month code's syntax (M01 .. M99, maybe L)
const toMonthCode = value => {
  const s = requireString(toPrimitiveString(value));
  if (!/^M\d\dL?$/.test(s) || s === 'M00') rangeError(`${s} is not a valid month code`);
  return s;
};

// ToOffsetString: an offset, as a string
const toOffsetString = value => {
  const s = requireString(toPrimitiveString(value));
  parseDateTimeUTCOffset(s);
  return s;
};

// ParseDateTimeUTCOffset: ±HH[:MM[:SS[.f]]] as nanoseconds (BigInt)
const parseDateTimeUTCOffset = s => {
  const m = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?$/.exec(s);
  if (m === null) rangeError(`${s} is not a valid offset`);
  const colons = (s.match(/:/g) || []).length;
  // the separators are consistent: all colons or none
  if (m[3] !== undefined && colons > 0 && ((m[4] !== undefined && colons !== 2) || (m[4] === undefined && colons !== 1))) rangeError(`${s} is not a valid offset`);
  if (m[4] !== undefined && colons === 1) rangeError(`${s} is not a valid offset`);
  const h = +m[2], mi = m[3] === undefined ? 0 : +m[3], sec = m[4] === undefined ? 0 : +m[4];
  if (h > 23 || mi > 59 || sec > 59) rangeError(`${s} is not a valid offset`);
  const frac = m[5] === undefined ? 0n : BigInt(m[5].padEnd(9, '0'));
  const total = BigInt((h * 60 + mi) * 60 + sec) * NS_PER.second + frac;
  return m[1] === '-' ? -total : total;
};

const convertField = (name, value) => {
  switch (name) {
    case 'day': case 'month': return toPositiveIntegerWithTruncation(value);
    case 'monthCode': return toMonthCode(value);
    case 'offset': return toOffsetString(value);
    case 'timeZone': return toTimeZoneIdentifier(value);
    default: return toIntegerWithTruncation(value);
  }
};

// PrepareCalendarFields: the named fields of a property bag, read in order and converted as
// read; a required one absent is a TypeError ('partial': at least one must be there)
const prepareCalendarFields = (bag, names, required) => {
  const out = {};
  let any = false;
  for (let _j = 0, _l = FIELD_ORDER; _j < _l.length; _j++) { const name = _l[_j];
    if (!names.includes(name)) continue;
    const value = bag[name];
    if (value !== undefined) {
      out[name] = convertField(name, value);
      any = true;
    } else if (required !== 'partial' && required.includes(name)) {
      typeError(`${name} is required`);
    }
  }
  if (required === 'partial' && !any) typeError('At least one field is required');
  return out;
};

const DATE_FIELD_NAMES = [ 'year', 'month', 'monthCode', 'day' ];
const TIME_FIELD_NAMES = [ 'hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond' ];
// (joined with concat: spreading an array would iterate it, which a program can observe)
const DATE_TIME_FIELD_NAMES = DATE_FIELD_NAMES.concat(TIME_FIELD_NAMES);
const ZONED_FIELD_NAMES = DATE_TIME_FIELD_NAMES.concat([ 'offset', 'timeZone' ]);
const ZONED_WITH_FIELD_NAMES = DATE_TIME_FIELD_NAMES.concat([ 'offset' ]);

// CalendarResolveFields (ISO 8601): the month from month and monthCode, the fields each type needs
const resolveFields = (fields, type) => {
  if ((type === 'date' || type === 'year-month') && fields.year === undefined) typeError('year is required');
  if ((type === 'date' || type === 'month-day') && fields.day === undefined) typeError('day is required');
  const monthCode = fields.monthCode;
  if (monthCode === undefined) {
    if (fields.month === undefined) typeError('month or monthCode is required');
    return;
  }
  const valid = /^M(0[1-9]|1[0-2])$/.exec(monthCode);
  if (valid === null) rangeError(`${monthCode} is not a month code of the ISO 8601 calendar`);
  const month = +valid[1];
  if (fields.month !== undefined && fields.month !== month) rangeError('month and monthCode disagree');
  fields.month = month;
};

// CalendarDateFromFields
const calendarDateFromFields = (fields, overflow) => {
  resolveFields(fields, 'date');
  const date = regulateISODate(fields.year, fields.month, fields.day, overflow);
  checkISODateWithinLimits(date);
  return date;
};

// CalendarYearMonthFromFields: day 1 of the month
const calendarYearMonthFromFields = (fields, overflow) => {
  resolveFields(fields, 'year-month');
  const date = regulateISODate(fields.year, fields.month, 1, overflow);
  if (!isoYearMonthWithinLimits(date.year, date.month)) rangeError('Year-month outside the representable range');
  return date;
};

// CalendarMonthDayFromFields: the reference year 1972 (a leap year), after the fields' own
// year, if any, has been checked
const calendarMonthDayFromFields = (fields, overflow) => {
  resolveFields(fields, 'month-day');
  const date = regulateISODate(fields.year === undefined ? 1972 : fields.year, fields.month, fields.day, overflow);
  return isoDate(1972, date.month, date.day);
};

// InterpretTemporalDateTimeFields
const interpretDateTimeFields = (fields, overflow) => {
  const date = calendarDateFromFields(fields, overflow);
  const time = regulateTime(fields.hour ?? 0, fields.minute ?? 0, fields.second ?? 0,
    fields.millisecond ?? 0, fields.microsecond ?? 0, fields.nanosecond ?? 0, overflow);
  return { date, time };
};

// CalendarMergeFields (ISO 8601): the additional fields win; month and monthCode go together
const mergeFields = (fields, additional) => {
  const out = {};
  for (const k in fields) {
    if (fields[k] === undefined) continue;
    if ((k === 'month' || k === 'monthCode') && (additional.month !== undefined || additional.monthCode !== undefined)) continue;
    out[k] = fields[k];
  }
  for (const k in additional) if (additional[k] !== undefined) out[k] = additional[k];
  return out;
};

// ToTemporalTimeRecord: a bag's time fields (read alphabetically), at least one
const toTimeRecordFields = (bag, partial) => {
  const out = {};
  let any = false;
  for (let _j = 0, _l = [ 'hour', 'microsecond', 'millisecond', 'minute', 'nanosecond', 'second' ]; _j < _l.length; _j++) { const name = _l[_j];
    const value = bag[name];
    if (value !== undefined) {
      out[name] = toIntegerWithTruncation(value);
      any = true;
    }
  }
  if (!any) typeError('At least one time field is required');
  if (!partial) for (let _j = 0, _l = TIME_FIELD_NAMES; _j < _l.length; _j++) { const name = _l[_j]; if (out[name] === undefined) out[name] = 0; }
  return out;
};

// ---- formatting ----

const formatISOYear = year => {
  if (year >= 0 && year <= 9999) return padNumber(year, 4);
  return `${year < 0 ? '-' : '+'}${padNumber(Math.abs(year), 6)}`;
};

const formatCalendarAnnotation = (calendar, show) => {
  if (show === 'never') return '';
  if (show === 'auto' && calendar === 'iso8601') return '';
  return `[${show === 'critical' ? '!' : ''}u-ca=${calendar}]`;
};

const formatDate = date => `${formatISOYear(date.year)}-${padNumber(date.month, 2)}-${padNumber(date.day, 2)}`;

// FormatFractionalSeconds: the nanoseconds of a second as .fff, 'auto' trimmed
const formatFraction = (subNs, precision) => {
  if (precision === 'auto') {
    if (subNs === 0) return '';
    return '.' + padNumber(subNs, 9).replace(/0+$/, '');
  }
  if (precision === 0) return '';
  return '.' + padNumber(subNs, 9).slice(0, precision);
};

// FormatTimeString
const formatTime = (time, precision) => {
  const hm = `${padNumber(time.hour, 2)}:${padNumber(time.minute, 2)}`;
  if (precision === 'minute') return hm;
  const subNs = time.millisecond * 1000000 + time.microsecond * 1000 + time.nanosecond;
  return `${hm}:${padNumber(time.second, 2)}${formatFraction(subNs, precision)}`;
};

// ToSecondsStringPrecisionRecord
const secondsStringPrecision = (smallestUnit, digits) => {
  switch (smallestUnit) {
    case 'minute': return { precision: 'minute', unit: 'minute', increment: 1 };
    case 'second': return { precision: 0, unit: 'second', increment: 1 };
    case 'millisecond': return { precision: 3, unit: 'millisecond', increment: 1 };
    case 'microsecond': return { precision: 6, unit: 'microsecond', increment: 1 };
    case 'nanosecond': return { precision: 9, unit: 'nanosecond', increment: 1 };
  }
  if (digits === 'auto') return { precision: 'auto', unit: 'nanosecond', increment: 1 };
  if (digits === 0) return { precision: 0, unit: 'second', increment: 1 };
  if (digits <= 3) return { precision: digits, unit: 'millisecond', increment: 10 ** (3 - digits) };
  if (digits <= 6) return { precision: digits, unit: 'microsecond', increment: 10 ** (6 - digits) };
  return { precision: digits, unit: 'nanosecond', increment: 10 ** (9 - digits) };
};

// the toString options of the date-time types, read in the spec's order: calendarName,
// fractionalSecondDigits, offset, roundingMode, smallestUnit, timeZoneName (the ones asked for)
const readToStringOptions = (options, which) => {
  const out = {};
  if (which.includes('calendarName')) out.showCalendar = getShowCalendarNameOption(options);
  out.digits = getFractionalSecondDigitsOption(options);
  if (which.includes('offset')) out.showOffset = getShowOffsetOption(options);
  out.roundingMode = getRoundingModeOption(options, 'trunc');
  out.smallestUnit = getUnitOption(options, 'smallestUnit', undefined);
  if (which.includes('timeZoneName')) out.showTimeZone = getShowTimeZoneNameOption(options);
  validateUnit(out.smallestUnit, 'time');
  if (out.smallestUnit === 'hour') rangeError('smallestUnit hour is not allowed here');
  out.precision = secondsStringPrecision(out.smallestUnit, out.digits);
  return out;
};
