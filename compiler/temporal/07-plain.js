// ---- creating the plain types ----

const createPlainDate = (date, calendar, target) => {
  checkISODateWithinLimits(date);
  const obj = target === undefined ? Object.create(PlainDate.prototype) : target;
  SLOTS.set(obj, { brand: 'PlainDate', date, calendar });
  return obj;
};

const createPlainTime = (time, target) => {
  const obj = target === undefined ? Object.create(PlainTime.prototype) : target;
  SLOTS.set(obj, { brand: 'PlainTime', time });
  return obj;
};

const createPlainDateTime = (date, time, calendar, target) => {
  checkISODateTimeWithinLimits(date, time);
  const obj = target === undefined ? Object.create(PlainDateTime.prototype) : target;
  SLOTS.set(obj, { brand: 'PlainDateTime', date, time, calendar });
  return obj;
};

// a calendar argument of a constructor: a calendar identifier (no ISO string)
const constructorCalendar = calendar => {
  if (calendar === undefined) return 'iso8601';
  if (typeof calendar !== 'string') typeError('calendar must be a string');
  return canonicalizeCalendar(calendar);
};

// IsPartialTemporalObject, as a TypeError when not
const requirePartialTemporalObject = value => {
  if (!isObject(value)) typeError('A property bag is required');
  if (brandOf(value) !== undefined) typeError('A Temporal object is not a property bag');
  if (value.calendar !== undefined) typeError('calendar is not allowed in a property bag here');
  if (value.timeZone !== undefined) typeError('timeZone is not allowed in a property bag here');
};

const dateToFields = date => ({ year: date.year, month: date.month, monthCode: `M${padNumber(date.month, 2)}`, day: date.day });
const timeToFields = time => ({ hour: time.hour, minute: time.minute, second: time.second, millisecond: time.millisecond, microsecond: time.microsecond, nanosecond: time.nanosecond });

// ---- conversions ----

// ToTemporalDate: { date, calendar }
const toPlainDateRecord = (item, options) => {
  if (isObject(item)) {
    const b = brandOf(item);
    if (b === 'PlainDate' || b === 'PlainDateTime') {
      getOverflowOption(getOptionsObject(options));
      const s = SLOTS.get(item);
      return { date: s.date, calendar: s.calendar };
    }
    if (b === 'ZonedDateTime') {
      const s = SLOTS.get(item);
      const dt = isoDateTimeFor(s.timeZone, s.epochNs);
      getOverflowOption(getOptionsObject(options));
      return { date: dt.date, calendar: s.calendar };
    }
    const calendar = calendarWithISODefault(item);
    const fields = prepareCalendarFields(item, DATE_FIELD_NAMES, []);
    const overflow = getOverflowOption(getOptionsObject(options));
    return { date: calendarDateFromFields(fields, overflow), calendar };
  }
  if (typeof item !== 'string') typeError('A date must be a string or an object');
  const parsed = parseISOString(item, 'datetime');
  const calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
  getOverflowOption(getOptionsObject(options));
  const date = isoDate(parsed.year, parsed.month, parsed.day);
  checkISODateWithinLimits(date);
  return { date, calendar };
};

// ToTemporalTime: a time record
const toPlainTimeRecord = (item, options) => {
  if (isObject(item)) {
    const b = brandOf(item);
    if (b === 'PlainTime' || b === 'PlainDateTime') {
      getOverflowOption(getOptionsObject(options));
      return SLOTS.get(item).time;
    }
    if (b === 'ZonedDateTime') {
      const s = SLOTS.get(item);
      const dt = isoDateTimeFor(s.timeZone, s.epochNs);
      getOverflowOption(getOptionsObject(options));
      return dt.time;
    }
    const f = toTimeRecordFields(item, false);
    const overflow = getOverflowOption(getOptionsObject(options));
    return regulateTime(f.hour, f.minute, f.second, f.millisecond, f.microsecond, f.nanosecond, overflow);
  }
  if (typeof item !== 'string') typeError('A time must be a string or an object');
  const parsed = parseISOString(item, 'time');
  getOverflowOption(getOptionsObject(options));
  return parsed.time;
};

// ToTimeRecordOrMidnight
const toTimeOrMidnight = item => item === undefined ? MIDNIGHT : toPlainTimeRecord(item);

// ToTemporalDateTime: { date, time, calendar }
const toPlainDateTimeRecord = (item, options) => {
  if (isObject(item)) {
    const b = brandOf(item);
    if (b === 'PlainDateTime') {
      getOverflowOption(getOptionsObject(options));
      const s = SLOTS.get(item);
      return { date: s.date, time: s.time, calendar: s.calendar };
    }
    if (b === 'ZonedDateTime') {
      const s = SLOTS.get(item);
      const dt = isoDateTimeFor(s.timeZone, s.epochNs);
      getOverflowOption(getOptionsObject(options));
      return { date: dt.date, time: dt.time, calendar: s.calendar };
    }
    if (b === 'PlainDate') {
      getOverflowOption(getOptionsObject(options));
      const s = SLOTS.get(item);
      return { date: s.date, time: MIDNIGHT, calendar: s.calendar };
    }
    const calendar = calendarWithISODefault(item);
    const fields = prepareCalendarFields(item, DATE_TIME_FIELD_NAMES, []);
    const overflow = getOverflowOption(getOptionsObject(options));
    const result = interpretDateTimeFields(fields, overflow);
    checkISODateTimeWithinLimits(result.date, result.time);
    return { date: result.date, time: result.time, calendar };
  }
  if (typeof item !== 'string') typeError('A date-time must be a string or an object');
  const parsed = parseISOString(item, 'datetime');
  const calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
  getOverflowOption(getOptionsObject(options));
  const date = isoDate(parsed.year, parsed.month, parsed.day);
  const time = parsed.time === null ? MIDNIGHT : parsed.time;
  checkISODateTimeWithinLimits(date, time);
  return { date, time, calendar };
};

// ToDateDurationRecordWithoutTime: the time part as whole days (truncated)
const toDateDurationWithoutTime = d => {
  const internal = toInternalDurationWith24HourDays(d);
  const days = Number(internal.time / NS_PER_DAY);
  const out = dateDuration(internal.date.years, internal.date.months, internal.date.weeks, days === 0 ? 0 : days);
  checkValidDuration(durationRecord(out.years, out.months, out.weeks, out.days, 0, 0, 0, 0, 0, 0));
  return out;
};

const calendarDateGetters = (cls, brand) => {
  const date = self => {
    const s = slots(self, brand, 'getter');
    return brand === 'ZonedDateTime' ? isoDateTimeFor(s.timeZone, s.epochNs).date : s.date;
  };
  const define = (name, get) => {
    const getter = function () { slots(this, brand, name); return get(this); };
    Object.defineProperty(getter, 'name', { value: 'get ' + name, configurable: true });
    Object.defineProperty(cls.prototype, name, { get: getter, configurable: true, enumerable: false });
  };
  define('calendarId', self => SLOTS.get(self).calendar);
  define('era', () => undefined);
  define('eraYear', () => undefined);
  define('year', self => date(self).year);
  define('month', self => date(self).month);
  define('monthCode', self => `M${padNumber(date(self).month, 2)}`);
  if (brand !== 'PlainYearMonth') define('day', self => date(self).day);
  if (brand !== 'PlainYearMonth') {
    define('dayOfWeek', self => dayOfWeek(date(self)));
    define('dayOfYear', self => dayOfYear(date(self)));
    define('weekOfYear', self => weekOfYear(date(self)).week);
    define('yearOfWeek', self => weekOfYear(date(self)).year);
    define('daysInWeek', () => 7);
  }
  define('daysInMonth', self => daysInMonth(date(self).year, date(self).month));
  define('daysInYear', self => daysInYear(date(self).year));
  define('monthsInYear', () => 12);
  define('inLeapYear', self => isLeapYear(date(self).year));
};

const timeGetters = (cls, brand) => {
  for (let _j = 0, _l = TIME_FIELD_NAMES; _j < _l.length; _j++) { const name = _l[_j];
    const getter = function () {
      const s = slots(this, brand, name);
      return (brand === 'ZonedDateTime' ? isoDateTimeFor(s.timeZone, s.epochNs).time : s.time)[name];
    };
    Object.defineProperty(getter, 'name', { value: 'get ' + name, configurable: true });
    Object.defineProperty(cls.prototype, name, { get: getter, configurable: true, enumerable: false });
  }
};

// ---- Temporal.PlainDate ----

class PlainDate {
  constructor(isoYear, isoMonth, isoDay, calendar = 'iso8601') {
    if (new.target === undefined) typeError('Temporal.PlainDate must be called with new');
    const y = toIntegerWithTruncation(isoYear);
    const m = toIntegerWithTruncation(isoMonth);
    const d = toIntegerWithTruncation(isoDay);
    const cal = constructorCalendar(calendar);
    if (!isValidISODate(y, m, d)) rangeError('Invalid ISO date');
    createPlainDate(isoDate(y, m, d), cal, this);
  }

  static from(item, options = undefined) {
    const r = toPlainDateRecord(item, options);
    return createPlainDate(r.date, r.calendar);
  }

  static compare(one, two) {
    return compareISODate(toPlainDateRecord(one).date, toPlainDateRecord(two).date);
  }

  with(temporalDateLike, options = undefined) {
    const s = slots(this, 'PlainDate', 'with');
    requirePartialTemporalObject(temporalDateLike);
    const partial = prepareCalendarFields(temporalDateLike, DATE_FIELD_NAMES, 'partial');
    const fields = mergeFields(dateToFields(s.date), partial);
    const overflow = getOverflowOption(getOptionsObject(options));
    return createPlainDate(calendarDateFromFields(fields, overflow), s.calendar);
  }

  withCalendar(calendarLike) {
    const s = slots(this, 'PlainDate', 'withCalendar');
    return createPlainDate(s.date, toCalendarIdentifier(calendarLike));
  }

  add(temporalDurationLike, options = undefined) {
    return addDurationToPlainDate(slots(this, 'PlainDate', 'add'), temporalDurationLike, options, 1);
  }

  subtract(temporalDurationLike, options = undefined) {
    return addDurationToPlainDate(slots(this, 'PlainDate', 'subtract'), temporalDurationLike, options, -1);
  }

  until(other, options = undefined) {
    return differencePlainDates('until', slots(this, 'PlainDate', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differencePlainDates('since', slots(this, 'PlainDate', 'since'), other, options);
  }

  equals(other) {
    const s = slots(this, 'PlainDate', 'equals');
    const o = toPlainDateRecord(other);
    return compareISODate(s.date, o.date) === 0 && s.calendar === o.calendar;
  }

  toPlainYearMonth() {
    const s = slots(this, 'PlainDate', 'toPlainYearMonth');
    return createPlainYearMonth(calendarYearMonthFromFields(dateToFields(s.date), 'constrain'), s.calendar);
  }

  toPlainMonthDay() {
    const s = slots(this, 'PlainDate', 'toPlainMonthDay');
    return createPlainMonthDay(calendarMonthDayFromFields(dateToFields(s.date), 'constrain'), s.calendar);
  }

  toPlainDateTime(temporalTime = undefined) {
    const s = slots(this, 'PlainDate', 'toPlainDateTime');
    return createPlainDateTime(s.date, toTimeOrMidnight(temporalTime), s.calendar);
  }

  toZonedDateTime(item) {
    const s = slots(this, 'PlainDate', 'toZonedDateTime');
    let timeZone, temporalTime;
    if (isObject(item)) {
      const timeZoneLike = item.timeZone;
      if (timeZoneLike === undefined) timeZone = toTimeZoneIdentifier(item);
      else {
        timeZone = toTimeZoneIdentifier(timeZoneLike);
        temporalTime = item.plainTime;
      }
    } else timeZone = toTimeZoneIdentifier(item);
    let epochNs;
    if (temporalTime === undefined) epochNs = startOfDay(timeZone, s.date);
    else {
      const time = toPlainTimeRecord(temporalTime);
      checkISODateTimeWithinLimits(s.date, time);
      epochNs = epochNsFor(timeZone, s.date, time, 'compatible');
    }
    return createZonedDateTime(epochNs, timeZone, s.calendar);
  }

  toString(options = undefined) {
    const s = slots(this, 'PlainDate', 'toString');
    const show = getShowCalendarNameOption(getOptionsObject(options));
    return formatDate(s.date) + formatCalendarAnnotation(s.calendar, show);
  }

  toJSON() {
    const s = slots(this, 'PlainDate', 'toJSON');
    return formatDate(s.date) + formatCalendarAnnotation(s.calendar, 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    const s = slots(this, 'PlainDate', 'toLocaleString');
    return formatDate(s.date) + formatCalendarAnnotation(s.calendar, 'auto');
  }

  valueOf() {
    typeError('Temporal.PlainDate cannot be converted to a primitive; use compare');
  }
}
calendarDateGetters(PlainDate, 'PlainDate');

// AddDurationToDate
const addDurationToPlainDate = (s, like, options, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  const dd = toDateDurationWithoutTime(d);
  const overflow = getOverflowOption(getOptionsObject(options));
  return createPlainDate(calendarDateAdd(s.date, dd, overflow), s.calendar);
};

// DifferenceTemporalPlainDate
const differencePlainDates = (operation, s, other, options) => {
  const o = toPlainDateRecord(other);
  if (o.calendar !== s.calendar) rangeError('The dates have different calendars');
  const settings = getDifferenceSettings(operation, getOptionsObject(options), 'date', [], 'day', 'day');
  if (compareISODate(s.date, o.date) === 0) return createDuration(ZERO_DURATION);
  let duration = internalDuration(calendarDateUntil(s.date, o.date, settings.largestUnit), 0n);
  if (settings.smallestUnit !== 'day' || settings.increment !== 1) {
    duration = roundRelativeDuration(duration, utcEpochNs(s.date, MIDNIGHT), utcEpochNs(o.date, MIDNIGHT), isoDateTime(s.date, MIDNIGHT), undefined,
      settings.largestUnit, settings.increment, settings.smallestUnit, settings.roundingMode);
  }
  let result = durationFromInternal(duration, 'day');
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};

// ---- Temporal.PlainTime ----

class PlainTime {
  constructor(hour = 0, minute = 0, second = 0, millisecond = 0, microsecond = 0, nanosecond = 0) {
    if (new.target === undefined) typeError('Temporal.PlainTime must be called with new');
    const h = toIntegerWithTruncation(hour), mi = toIntegerWithTruncation(minute), sec = toIntegerWithTruncation(second);
    const ms = toIntegerWithTruncation(millisecond), us = toIntegerWithTruncation(microsecond), ns = toIntegerWithTruncation(nanosecond);
    if (!isValidTime(h, mi, sec, ms, us, ns)) rangeError('Invalid time');
    createPlainTime(timeRecord(h, mi, sec, ms, us, ns), this);
  }

  static from(item, options = undefined) {
    return createPlainTime(toPlainTimeRecord(item, options));
  }

  static compare(one, two) {
    return compareTimeRecord(toPlainTimeRecord(one), toPlainTimeRecord(two));
  }

  with(temporalTimeLike, options = undefined) {
    const s = slots(this, 'PlainTime', 'with');
    requirePartialTemporalObject(temporalTimeLike);
    const partial = toTimeRecordFields(temporalTimeLike, true);
    const f = timeToFields(s.time);
    for (let _j = 0, _l = TIME_FIELD_NAMES; _j < _l.length; _j++) { const k = _l[_j]; if (partial[k] !== undefined) f[k] = partial[k]; }
    const overflow = getOverflowOption(getOptionsObject(options));
    return createPlainTime(regulateTime(f.hour, f.minute, f.second, f.millisecond, f.microsecond, f.nanosecond, overflow));
  }

  add(temporalDurationLike) {
    return addDurationToPlainTime(slots(this, 'PlainTime', 'add'), temporalDurationLike, 1);
  }

  subtract(temporalDurationLike) {
    return addDurationToPlainTime(slots(this, 'PlainTime', 'subtract'), temporalDurationLike, -1);
  }

  until(other, options = undefined) {
    return differencePlainTimes('until', slots(this, 'PlainTime', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differencePlainTimes('since', slots(this, 'PlainTime', 'since'), other, options);
  }

  round(roundTo) {
    const s = slots(this, 'PlainTime', 'round');
    if (roundTo === undefined) typeError('round requires options');
    if (typeof roundTo === 'string') {
      const str = roundTo;
      roundTo = Object.create(null);
      roundTo.smallestUnit = str;
    } else roundTo = getOptionsObject(roundTo);
    const increment = getRoundingIncrementOption(roundTo);
    const roundingMode = getRoundingModeOption(roundTo, 'halfExpand');
    const smallestUnit = getUnitOption(roundTo, 'smallestUnit', undefined);
    if (smallestUnit === undefined) rangeError('smallestUnit is required');
    validateUnit(smallestUnit, 'time');
    validateRoundingIncrement(increment, maximumRoundingIncrement(smallestUnit), false);
    return createPlainTime(roundTime(s.time, increment, smallestUnit, roundingMode).time);
  }

  equals(other) {
    const s = slots(this, 'PlainTime', 'equals');
    return compareTimeRecord(s.time, toPlainTimeRecord(other)) === 0;
  }

  toString(options = undefined) {
    const s = slots(this, 'PlainTime', 'toString');
    const o = readToStringOptions(getOptionsObject(options), []);
    return formatTime(roundTime(s.time, o.precision.increment, o.precision.unit, o.roundingMode).time, o.precision.precision);
  }

  toJSON() {
    return formatTime(slots(this, 'PlainTime', 'toJSON').time, 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return formatTime(slots(this, 'PlainTime', 'toLocaleString').time, 'auto');
  }

  valueOf() {
    typeError('Temporal.PlainTime cannot be converted to a primitive; use compare');
  }
}
timeGetters(PlainTime, 'PlainTime');

// AddDurationToTime: the time part only (days are dropped)
const addDurationToPlainTime = (s, like, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  return createPlainTime(addTime(s.time, toInternalDuration(d).time).time);
};

// DifferenceTemporalPlainTime
const differencePlainTimes = (operation, s, other, options) => {
  const o = toPlainTimeRecord(other);
  const settings = getDifferenceSettings(operation, getOptionsObject(options), 'time', [], 'nanosecond', 'hour');
  const time = roundTimeDuration(timeToNs(o) - timeToNs(s.time), settings.increment, settings.smallestUnit, settings.roundingMode);
  let result = durationFromInternal(internalDuration(ZERO_DATE_DURATION, time), settings.largestUnit);
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};

// ---- Temporal.PlainDateTime ----

// RoundISODateTime
const roundISODateTime = (date, time, increment, unit, mode) => {
  const r = roundTime(time, increment, unit, mode);
  return isoDateTime(addDaysToISODate(date, r.days), r.time);
};

class PlainDateTime {
  constructor(isoYear, isoMonth, isoDay, hour = 0, minute = 0, second = 0, millisecond = 0, microsecond = 0, nanosecond = 0, calendar = 'iso8601') {
    if (new.target === undefined) typeError('Temporal.PlainDateTime must be called with new');
    const y = toIntegerWithTruncation(isoYear), m = toIntegerWithTruncation(isoMonth), d = toIntegerWithTruncation(isoDay);
    const h = toIntegerWithTruncation(hour), mi = toIntegerWithTruncation(minute), sec = toIntegerWithTruncation(second);
    const ms = toIntegerWithTruncation(millisecond), us = toIntegerWithTruncation(microsecond), ns = toIntegerWithTruncation(nanosecond);
    const cal = constructorCalendar(calendar);
    if (!isValidISODate(y, m, d)) rangeError('Invalid ISO date');
    if (!isValidTime(h, mi, sec, ms, us, ns)) rangeError('Invalid time');
    createPlainDateTime(isoDate(y, m, d), timeRecord(h, mi, sec, ms, us, ns), cal, this);
  }

  static from(item, options = undefined) {
    const r = toPlainDateTimeRecord(item, options);
    return createPlainDateTime(r.date, r.time, r.calendar);
  }

  static compare(one, two) {
    const a = toPlainDateTimeRecord(one), b = toPlainDateTimeRecord(two);
    return compareISODateTime(a, b);
  }

  with(temporalDateTimeLike, options = undefined) {
    const s = slots(this, 'PlainDateTime', 'with');
    requirePartialTemporalObject(temporalDateTimeLike);
    const partial = prepareCalendarFields(temporalDateTimeLike, DATE_TIME_FIELD_NAMES, 'partial');
    const fields = mergeFields({ ...dateToFields(s.date), ...timeToFields(s.time) }, partial);
    const overflow = getOverflowOption(getOptionsObject(options));
    const r = interpretDateTimeFields(fields, overflow);
    return createPlainDateTime(r.date, r.time, s.calendar);
  }

  withPlainTime(plainTimeLike = undefined) {
    const s = slots(this, 'PlainDateTime', 'withPlainTime');
    return createPlainDateTime(s.date, toTimeOrMidnight(plainTimeLike), s.calendar);
  }

  withCalendar(calendarLike) {
    const s = slots(this, 'PlainDateTime', 'withCalendar');
    return createPlainDateTime(s.date, s.time, toCalendarIdentifier(calendarLike));
  }

  add(temporalDurationLike, options = undefined) {
    return addDurationToPlainDateTime(slots(this, 'PlainDateTime', 'add'), temporalDurationLike, options, 1);
  }

  subtract(temporalDurationLike, options = undefined) {
    return addDurationToPlainDateTime(slots(this, 'PlainDateTime', 'subtract'), temporalDurationLike, options, -1);
  }

  until(other, options = undefined) {
    return differencePlainDateTimes('until', slots(this, 'PlainDateTime', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differencePlainDateTimes('since', slots(this, 'PlainDateTime', 'since'), other, options);
  }

  round(roundTo) {
    const s = slots(this, 'PlainDateTime', 'round');
    if (roundTo === undefined) typeError('round requires options');
    if (typeof roundTo === 'string') {
      const str = roundTo;
      roundTo = Object.create(null);
      roundTo.smallestUnit = str;
    } else roundTo = getOptionsObject(roundTo);
    const increment = getRoundingIncrementOption(roundTo);
    const roundingMode = getRoundingModeOption(roundTo, 'halfExpand');
    const smallestUnit = getUnitOption(roundTo, 'smallestUnit', undefined);
    if (smallestUnit === undefined) rangeError('smallestUnit is required');
    validateUnit(smallestUnit, 'time', [ 'day' ]);
    if (smallestUnit === 'day') validateRoundingIncrement(increment, 1, true);
    else validateRoundingIncrement(increment, maximumRoundingIncrement(smallestUnit), false);
    if (smallestUnit === 'nanosecond' && increment === 1) return createPlainDateTime(s.date, s.time, s.calendar);
    const r = roundISODateTime(s.date, s.time, increment, smallestUnit, roundingMode);
    return createPlainDateTime(r.date, r.time, s.calendar);
  }

  equals(other) {
    const s = slots(this, 'PlainDateTime', 'equals');
    const o = toPlainDateTimeRecord(other);
    return compareISODateTime(s, o) === 0 && s.calendar === o.calendar;
  }

  toString(options = undefined) {
    const s = slots(this, 'PlainDateTime', 'toString');
    const o = readToStringOptions(getOptionsObject(options), [ 'calendarName' ]);
    const r = roundISODateTime(s.date, s.time, o.precision.increment, o.precision.unit, o.roundingMode);
    checkISODateTimeWithinLimits(r.date, r.time);
    return `${formatDate(r.date)}T${formatTime(r.time, o.precision.precision)}${formatCalendarAnnotation(s.calendar, o.showCalendar)}`;
  }

  toJSON() {
    const s = slots(this, 'PlainDateTime', 'toJSON');
    return `${formatDate(s.date)}T${formatTime(s.time, 'auto')}${formatCalendarAnnotation(s.calendar, 'auto')}`;
  }

  toLocaleString(locales = undefined, options = undefined) {
    const s = slots(this, 'PlainDateTime', 'toLocaleString');
    return `${formatDate(s.date)}T${formatTime(s.time, 'auto')}${formatCalendarAnnotation(s.calendar, 'auto')}`;
  }

  valueOf() {
    typeError('Temporal.PlainDateTime cannot be converted to a primitive; use compare');
  }

  toPlainDate() {
    const s = slots(this, 'PlainDateTime', 'toPlainDate');
    return createPlainDate(s.date, s.calendar);
  }

  toPlainTime() {
    return createPlainTime(slots(this, 'PlainDateTime', 'toPlainTime').time);
  }

  toZonedDateTime(temporalTimeZoneLike, options = undefined) {
    const s = slots(this, 'PlainDateTime', 'toZonedDateTime');
    const timeZone = toTimeZoneIdentifier(temporalTimeZoneLike);
    const disambiguation = getDisambiguationOption(getOptionsObject(options));
    return createZonedDateTime(epochNsFor(timeZone, s.date, s.time, disambiguation), timeZone, s.calendar);
  }
}
calendarDateGetters(PlainDateTime, 'PlainDateTime');
timeGetters(PlainDateTime, 'PlainDateTime');

// AddDurationToDateTime
const addDurationToPlainDateTime = (s, like, options, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  const overflow = getOverflowOption(getOptionsObject(options));
  const internal = toInternalDurationWith24HourDays(d);
  const t = addTime(s.time, internal.time);
  const date = calendarDateAdd(s.date, adjustDateDuration(internal.date, t.days), overflow);
  return createPlainDateTime(date, t.time, s.calendar);
};

// DifferenceTemporalPlainDateTime
const differencePlainDateTimes = (operation, s, other, options) => {
  const o = toPlainDateTimeRecord(other);
  if (o.calendar !== s.calendar) rangeError('The date-times have different calendars');
  const settings = getDifferenceSettings(operation, getOptionsObject(options), 'datetime', [], 'nanosecond', 'day');
  if (compareISODateTime(s, o) === 0) return createDuration(ZERO_DURATION);
  const internal = differencePlainDateTimeWithRounding(isoDateTime(s.date, s.time), isoDateTime(o.date, o.time),
    settings.largestUnit, settings.increment, settings.smallestUnit, settings.roundingMode);
  let result = durationFromInternal(internal, settings.largestUnit);
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};
