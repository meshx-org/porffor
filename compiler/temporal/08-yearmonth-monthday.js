// ---- Temporal.PlainYearMonth ----

const createPlainYearMonth = (date, calendar, target) => {
  if (!isoYearMonthWithinLimits(date.year, date.month)) rangeError('Year-month outside the representable range');
  const obj = target === undefined ? Object.create(PlainYearMonth.prototype) : target;
  SLOTS.set(obj, { brand: 'PlainYearMonth', date, calendar });
  return obj;
};

const yearMonthFields = date => ({ year: date.year, month: date.month, monthCode: `M${padNumber(date.month, 2)}` });

// ToTemporalYearMonth: { date, calendar }
const toPlainYearMonthRecord = (item, options) => {
  if (isObject(item)) {
    const own = slotsIf(item, 'PlainYearMonth');
    if (own !== undefined) {
      getOverflowOption(getOptionsObject(options));
      return { date: own.date, calendar: own.calendar };
    }
    const calendar = calendarWithISODefault(item);
    const fields = prepareCalendarFields(item, [ 'year', 'month', 'monthCode' ], []);
    const overflow = getOverflowOption(getOptionsObject(options));
    return { date: calendarYearMonthFromFields(fields, overflow), calendar };
  }
  if (typeof item !== 'string') typeError('A year-month must be a string or an object');
  const parsed = parseISOString(item, 'yearmonth');
  const calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
  getOverflowOption(getOptionsObject(options));
  if (!isoYearMonthWithinLimits(parsed.year, parsed.month)) rangeError('Year-month outside the representable range');
  return { date: calendarYearMonthFromFields(yearMonthFields(isoDate(parsed.year, parsed.month, 1)), 'constrain'), calendar };
};

class PlainYearMonth {
  constructor(isoYear, isoMonth, calendar = 'iso8601', referenceISODay = 1) {
    if (new.target === undefined) typeError('Temporal.PlainYearMonth must be called with new');
    const y = toIntegerWithTruncation(isoYear);
    const m = toIntegerWithTruncation(isoMonth);
    const cal = constructorCalendar(calendar);
    const ref = toIntegerWithTruncation(referenceISODay);
    if (!isValidISODate(y, m, ref)) rangeError('Invalid ISO date');
    createPlainYearMonth(isoDate(y, m, ref), cal, this);
  }

  static from(item, options = undefined) {
    const r = toPlainYearMonthRecord(item, options);
    return createPlainYearMonth(r.date, r.calendar);
  }

  static compare(one, two) {
    return compareISODate(toPlainYearMonthRecord(one).date, toPlainYearMonthRecord(two).date);
  }

  with(temporalYearMonthLike, options = undefined) {
    const s = slots(this, 'PlainYearMonth', 'with');
    requirePartialTemporalObject(temporalYearMonthLike);
    const partial = prepareCalendarFields(temporalYearMonthLike, [ 'year', 'month', 'monthCode' ], 'partial');
    const fields = mergeFields(yearMonthFields(s.date), partial);
    const overflow = getOverflowOption(getOptionsObject(options));
    return createPlainYearMonth(calendarYearMonthFromFields(fields, overflow), s.calendar);
  }

  add(temporalDurationLike, options = undefined) {
    return addDurationToYearMonth(slots(this, 'PlainYearMonth', 'add'), temporalDurationLike, options, 1);
  }

  subtract(temporalDurationLike, options = undefined) {
    return addDurationToYearMonth(slots(this, 'PlainYearMonth', 'subtract'), temporalDurationLike, options, -1);
  }

  until(other, options = undefined) {
    return differenceYearMonths('until', slots(this, 'PlainYearMonth', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differenceYearMonths('since', slots(this, 'PlainYearMonth', 'since'), other, options);
  }

  equals(other) {
    const s = slots(this, 'PlainYearMonth', 'equals');
    const o = toPlainYearMonthRecord(other);
    return compareISODate(s.date, o.date) === 0 && s.calendar === o.calendar;
  }

  toString(options = undefined) {
    const s = slots(this, 'PlainYearMonth', 'toString');
    return yearMonthToString(s, getShowCalendarNameOption(getOptionsObject(options)));
  }

  toJSON() {
    return yearMonthToString(slots(this, 'PlainYearMonth', 'toJSON'), 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return yearMonthToString(slots(this, 'PlainYearMonth', 'toLocaleString'), 'auto');
  }

  valueOf() {
    typeError('Temporal.PlainYearMonth cannot be converted to a primitive; use compare');
  }

  toPlainDate(item) {
    const s = slots(this, 'PlainYearMonth', 'toPlainDate');
    if (!isObject(item)) typeError('toPlainDate needs an object with a day');
    const input = prepareCalendarFields(item, [ 'day' ], []);
    const fields = mergeFields(yearMonthFields(s.date), input);
    return createPlainDate(calendarDateFromFields(fields, 'constrain'), s.calendar);
  }
}
calendarDateGetters(PlainYearMonth, 'PlainYearMonth');

// TemporalYearMonthToString: YYYY-MM, and the reference day with a calendar shown
const yearMonthToString = (s, show) => {
  let out = `${formatISOYear(s.date.year)}-${padNumber(s.date.month, 2)}`;
  if (show === 'always' || show === 'critical' || s.calendar !== 'iso8601') out += `-${padNumber(s.date.day, 2)}`;
  return out + formatCalendarAnnotation(s.calendar, show);
};

// AddDurationToYearMonth: months and years only
const addDurationToYearMonth = (s, like, options, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  const overflow = getOverflowOption(getOptionsObject(options));
  if (d.weeks !== 0 || d.days !== 0 || d.hours !== 0 || d.minutes !== 0 || d.seconds !== 0 ||
    d.milliseconds !== 0 || d.microseconds !== 0 || d.nanoseconds !== 0) rangeError('A year-month can only add years and months');
  // from the 1st of the month (a date that must be in range), so no day is out of range
  const fields = yearMonthFields(s.date);
  fields.day = 1;
  const intermediate = calendarDateFromFields(fields, 'constrain');
  const added = calendarDateAdd(intermediate, dateDuration(d.years, d.months, 0, 0), overflow);
  return createPlainYearMonth(calendarYearMonthFromFields(yearMonthFields(added), overflow), s.calendar);
};

// DifferenceTemporalPlainYearMonth
const differenceYearMonths = (operation, s, other, options) => {
  const o = toPlainYearMonthRecord(other);
  if (o.calendar !== s.calendar) rangeError('The year-months have different calendars');
  const settings = getDifferenceSettings(operation, getOptionsObject(options), 'date', [ 'week', 'day' ], 'month', 'year');
  if (compareISODate(s.date, o.date) === 0) return createDuration(ZERO_DURATION);
  const thisDate = isoDate(s.date.year, s.date.month, 1);
  const otherDate = isoDate(o.date.year, o.date.month, 1);
  checkISODateWithinLimits(thisDate);
  checkISODateWithinLimits(otherDate);
  const diff = calendarDateUntil(thisDate, otherDate, settings.largestUnit);
  let duration = internalDuration(dateDuration(diff.years, diff.months, 0, 0), 0n);
  if (settings.smallestUnit !== 'month' || settings.increment !== 1) {
    duration = roundRelativeDuration(duration, utcEpochNs(thisDate, MIDNIGHT), utcEpochNs(otherDate, MIDNIGHT), isoDateTime(thisDate, MIDNIGHT), undefined,
      settings.largestUnit, settings.increment, settings.smallestUnit, settings.roundingMode);
  }
  let result = durationFromInternal(duration, 'day');
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};

// ---- Temporal.PlainMonthDay ----

const createPlainMonthDay = (date, calendar, target) => {
  checkISODateWithinLimits(date);
  const obj = target === undefined ? Object.create(PlainMonthDay.prototype) : target;
  SLOTS.set(obj, { brand: 'PlainMonthDay', date, calendar });
  return obj;
};

const monthDayFields = date => ({ monthCode: `M${padNumber(date.month, 2)}`, day: date.day });

// ToTemporalMonthDay: { date, calendar }
const toPlainMonthDayRecord = (item, options) => {
  if (isObject(item)) {
    const own = slotsIf(item, 'PlainMonthDay');
    if (own !== undefined) {
      getOverflowOption(getOptionsObject(options));
      return { date: own.date, calendar: own.calendar };
    }
    const calendar = calendarWithISODefault(item);
    const fields = prepareCalendarFields(item, DATE_FIELD_NAMES, []);
    const overflow = getOverflowOption(getOptionsObject(options));
    return { date: calendarMonthDayFromFields(fields, overflow), calendar };
  }
  if (typeof item !== 'string') typeError('A month-day must be a string or an object');
  const parsed = parseISOString(item, 'monthday');
  const calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
  getOverflowOption(getOptionsObject(options));
  return { date: isoDate(1972, parsed.month, parsed.day), calendar };
};

class PlainMonthDay {
  constructor(isoMonth, isoDay, calendar = 'iso8601', referenceISOYear = 1972) {
    if (new.target === undefined) typeError('Temporal.PlainMonthDay must be called with new');
    const m = toIntegerWithTruncation(isoMonth);
    const d = toIntegerWithTruncation(isoDay);
    const cal = constructorCalendar(calendar);
    const y = toIntegerWithTruncation(referenceISOYear);
    if (!isValidISODate(y, m, d)) rangeError('Invalid ISO date');
    createPlainMonthDay(isoDate(y, m, d), cal, this);
  }

  static from(item, options = undefined) {
    const r = toPlainMonthDayRecord(item, options);
    return createPlainMonthDay(r.date, r.calendar);
  }

  get calendarId() { return slots(this, 'PlainMonthDay', 'calendarId').calendar; }
  get monthCode() { return `M${padNumber(slots(this, 'PlainMonthDay', 'monthCode').date.month, 2)}`; }
  get day() { return slots(this, 'PlainMonthDay', 'day').date.day; }

  with(temporalMonthDayLike, options = undefined) {
    const s = slots(this, 'PlainMonthDay', 'with');
    requirePartialTemporalObject(temporalMonthDayLike);
    const partial = prepareCalendarFields(temporalMonthDayLike, DATE_FIELD_NAMES, 'partial');
    const fields = mergeFields(monthDayFields(s.date), partial);
    const overflow = getOverflowOption(getOptionsObject(options));
    return createPlainMonthDay(calendarMonthDayFromFields(fields, overflow), s.calendar);
  }

  equals(other) {
    const s = slots(this, 'PlainMonthDay', 'equals');
    const o = toPlainMonthDayRecord(other);
    return compareISODate(s.date, o.date) === 0 && s.calendar === o.calendar;
  }

  toString(options = undefined) {
    const s = slots(this, 'PlainMonthDay', 'toString');
    return monthDayToString(s, getShowCalendarNameOption(getOptionsObject(options)));
  }

  toJSON() {
    return monthDayToString(slots(this, 'PlainMonthDay', 'toJSON'), 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return monthDayToString(slots(this, 'PlainMonthDay', 'toLocaleString'), 'auto');
  }

  valueOf() {
    typeError('Temporal.PlainMonthDay cannot be converted to a primitive');
  }

  toPlainDate(item) {
    const s = slots(this, 'PlainMonthDay', 'toPlainDate');
    if (!isObject(item)) typeError('toPlainDate needs an object with a year');
    const input = prepareCalendarFields(item, [ 'year' ], []);
    const fields = mergeFields(monthDayFields(s.date), input);
    return createPlainDate(calendarDateFromFields(fields, 'constrain'), s.calendar);
  }
}

// TemporalMonthDayToString: MM-DD, and the reference year with a calendar shown
const monthDayToString = (s, show) => {
  let out = `${padNumber(s.date.month, 2)}-${padNumber(s.date.day, 2)}`;
  if (show === 'always' || show === 'critical' || s.calendar !== 'iso8601') out = `${formatISOYear(s.date.year)}-${out}`;
  return out + formatCalendarAnnotation(s.calendar, show);
};
