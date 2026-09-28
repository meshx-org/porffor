// ---- Temporal.ZonedDateTime ----

const createZonedDateTime = (epochNs, timeZone, calendar, target) => {
  checkEpochNs(epochNs);
  const obj = target === undefined ? Object.create(ZonedDateTime.prototype) : target;
  SLOTS.set(obj, { brand: 'ZonedDateTime', epochNs, timeZone, calendar });
  return obj;
};

// TimeZoneEquals
const timeZoneEquals = (one, two) => {
  if (one === two) return true;
  const a = parseOffsetIdentifier(one), b = parseOffsetIdentifier(two);
  if (a !== null || b !== null) return a !== null && b !== null && a === b;
  return asciiLowercase(one) === asciiLowercase(two);
};

// ToTemporalZonedDateTime: { epochNs, timeZone, calendar }
const toZonedDateTimeRecord = (item, options) => {
  let offsetBehaviour = 'option';
  let matchMinutes = false;
  let timeZone, offsetNs, calendar, date, time, disambiguation, offsetOption;
  if (isObject(item)) {
    const own = slotsIf(item, 'ZonedDateTime');
    if (own !== undefined) {
      const resolved = getOptionsObject(options);
      getDisambiguationOption(resolved);
      getOffsetOption(resolved, 'reject');
      getOverflowOption(resolved);
      return { epochNs: own.epochNs, timeZone: own.timeZone, calendar: own.calendar };
    }
    calendar = calendarWithISODefault(item);
    const fields = prepareCalendarFields(item, ZONED_FIELD_NAMES, [ 'timeZone' ]);
    timeZone = fields.timeZone;
    const resolved = getOptionsObject(options);
    disambiguation = getDisambiguationOption(resolved);
    offsetOption = getOffsetOption(resolved, 'reject');
    const overflow = getOverflowOption(resolved);
    const result = interpretDateTimeFields(fields, overflow);
    date = result.date;
    time = result.time;
    if (fields.offset === undefined) offsetBehaviour = 'wall';
    else offsetNs = parseDateTimeUTCOffset(fields.offset);
  } else {
    if (typeof item !== 'string') typeError('A zoned date-time must be a string or an object');
    const parsed = parseISOString(item, 'zoned');
    timeZone = toTimeZoneIdentifier(parsed.timeZone);
    if (parsed.z) offsetBehaviour = 'exact';
    else if (parsed.offsetNs === null) offsetBehaviour = 'wall';
    offsetNs = parsed.z ? 0n : parsed.offsetNs;
    matchMinutes = !parsed.offsetSubMinute;
    calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
    const resolved = getOptionsObject(options);
    disambiguation = getDisambiguationOption(resolved);
    offsetOption = getOffsetOption(resolved, 'reject');
    getOverflowOption(resolved);
    date = isoDate(parsed.year, parsed.month, parsed.day);
    time = parsed.time === null ? 'start-of-day' : parsed.time;
  }
  const epochNs = interpretISODateTimeOffset(date, time, offsetBehaviour, offsetBehaviour === 'option' ? offsetNs : 0n,
    timeZone, disambiguation, offsetOption, matchMinutes);
  return { epochNs, timeZone, calendar };
};

// TemporalZonedDateTimeToString
const zonedDateTimeToString = (s, precision, showCalendar, showTimeZone, showOffset, increment = 1, unit = 'nanosecond', roundingMode = 'trunc') => {
  const epochNs = roundAsIfPositive(s.epochNs, BigInt(increment) * NS_PER[unit], roundingMode);
  checkEpochNs(epochNs);
  const offsetNs = offsetNsFor(s.timeZone, epochNs);
  const dt = isoDateTimeFromEpochNs(epochNs, offsetNs);
  let out = `${formatDate(dt.date)}T${formatTime(dt.time, precision)}`;
  if (showOffset !== 'never') out += formatOffsetRounded(offsetNs);
  if (showTimeZone !== 'never') out += `[${showTimeZone === 'critical' ? '!' : ''}${s.timeZone}]`;
  return out + formatCalendarAnnotation(s.calendar, showCalendar);
};

class ZonedDateTime {
  constructor(epochNanoseconds, timeZone, calendar = 'iso8601') {
    if (new.target === undefined) typeError('Temporal.ZonedDateTime must be called with new');
    const ns = toBigInt(epochNanoseconds);
    if (!isValidEpochNs(ns)) rangeError('Instant outside the representable range');
    if (typeof timeZone !== 'string') typeError('timeZone must be a string');
    if (!isTimeZoneIdentifierSyntax(timeZone)) rangeError(`${timeZone} is not a valid time zone identifier`);
    const tz = normalizeTimeZoneIdentifier(timeZone);
    const cal = constructorCalendar(calendar);
    createZonedDateTime(ns, tz, cal, this);
  }

  static from(item, options = undefined) {
    const r = toZonedDateTimeRecord(item, options);
    return createZonedDateTime(r.epochNs, r.timeZone, r.calendar);
  }

  static compare(one, two) {
    const a = toZonedDateTimeRecord(one).epochNs;
    const b = toZonedDateTimeRecord(two).epochNs;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  get timeZoneId() { return slots(this, 'ZonedDateTime', 'timeZoneId').timeZone; }
  get epochMilliseconds() { return Number(floorDiv(slots(this, 'ZonedDateTime', 'epochMilliseconds').epochNs, 1000000n)); }
  get epochNanoseconds() { return slots(this, 'ZonedDateTime', 'epochNanoseconds').epochNs; }
  get offsetNanoseconds() {
    const s = slots(this, 'ZonedDateTime', 'offsetNanoseconds');
    return Number(offsetNsFor(s.timeZone, s.epochNs));
  }
  get offset() {
    const s = slots(this, 'ZonedDateTime', 'offset');
    return formatOffsetNs(offsetNsFor(s.timeZone, s.epochNs));
  }
  get hoursInDay() {
    const s = slots(this, 'ZonedDateTime', 'hoursInDay');
    const today = isoDateTimeFor(s.timeZone, s.epochNs).date;
    const tomorrow = addDaysToISODate(today, 1);
    return totalTimeDuration(startOfDay(s.timeZone, tomorrow) - startOfDay(s.timeZone, today), 'hour');
  }

  with(temporalZonedDateTimeLike, options = undefined) {
    const s = slots(this, 'ZonedDateTime', 'with');
    requirePartialTemporalObject(temporalZonedDateTimeLike);
    const offsetNs = offsetNsFor(s.timeZone, s.epochNs);
    const dt = isoDateTimeFromEpochNs(s.epochNs, offsetNs);
    const existing = { ...dateToFields(dt.date), ...timeToFields(dt.time), offset: formatOffsetNs(offsetNs) };
    const partial = prepareCalendarFields(temporalZonedDateTimeLike, ZONED_WITH_FIELD_NAMES, 'partial');
    const fields = mergeFields(existing, partial);
    const resolved = getOptionsObject(options);
    const disambiguation = getDisambiguationOption(resolved);
    const offsetOption = getOffsetOption(resolved, 'prefer');
    const overflow = getOverflowOption(resolved);
    const r = interpretDateTimeFields(fields, overflow);
    const newOffsetNs = parseDateTimeUTCOffset(fields.offset);
    const epochNs = interpretISODateTimeOffset(r.date, r.time, 'option', newOffsetNs, s.timeZone, disambiguation, offsetOption, false);
    return createZonedDateTime(epochNs, s.timeZone, s.calendar);
  }

  withPlainTime(plainTimeLike = undefined) {
    const s = slots(this, 'ZonedDateTime', 'withPlainTime');
    const dt = isoDateTimeFor(s.timeZone, s.epochNs);
    let epochNs;
    if (plainTimeLike === undefined) epochNs = startOfDay(s.timeZone, dt.date);
    else epochNs = epochNsFor(s.timeZone, dt.date, toPlainTimeRecord(plainTimeLike), 'compatible');
    return createZonedDateTime(epochNs, s.timeZone, s.calendar);
  }

  withTimeZone(timeZoneLike) {
    const s = slots(this, 'ZonedDateTime', 'withTimeZone');
    return createZonedDateTime(s.epochNs, toTimeZoneIdentifier(timeZoneLike), s.calendar);
  }

  withCalendar(calendarLike) {
    const s = slots(this, 'ZonedDateTime', 'withCalendar');
    return createZonedDateTime(s.epochNs, s.timeZone, toCalendarIdentifier(calendarLike));
  }

  add(temporalDurationLike, options = undefined) {
    return addDurationToZoned(slots(this, 'ZonedDateTime', 'add'), temporalDurationLike, options, 1);
  }

  subtract(temporalDurationLike, options = undefined) {
    return addDurationToZoned(slots(this, 'ZonedDateTime', 'subtract'), temporalDurationLike, options, -1);
  }

  until(other, options = undefined) {
    return differenceZoned('until', slots(this, 'ZonedDateTime', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differenceZoned('since', slots(this, 'ZonedDateTime', 'since'), other, options);
  }

  round(roundTo) {
    const s = slots(this, 'ZonedDateTime', 'round');
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
    if (smallestUnit === 'nanosecond' && increment === 1) return createZonedDateTime(s.epochNs, s.timeZone, s.calendar);
    const dt = isoDateTimeFor(s.timeZone, s.epochNs);
    let epochNs;
    if (smallestUnit === 'day') {
      const startNs = startOfDay(s.timeZone, dt.date);
      const endNs = startOfDay(s.timeZone, addDaysToISODate(dt.date, 1));
      const rounded = roundBigIntToIncrement(s.epochNs - startNs, endNs - startNs, roundingMode);
      epochNs = startNs + rounded;
    } else {
      const r = roundISODateTime(dt.date, dt.time, increment, smallestUnit, roundingMode);
      const offsetNs = offsetNsFor(s.timeZone, s.epochNs);
      epochNs = interpretISODateTimeOffset(r.date, r.time, 'option', offsetNs, s.timeZone, 'compatible', 'prefer', false);
    }
    return createZonedDateTime(epochNs, s.timeZone, s.calendar);
  }

  equals(other) {
    const s = slots(this, 'ZonedDateTime', 'equals');
    const o = toZonedDateTimeRecord(other);
    return s.epochNs === o.epochNs && timeZoneEquals(s.timeZone, o.timeZone) && s.calendar === o.calendar;
  }

  toString(options = undefined) {
    const s = slots(this, 'ZonedDateTime', 'toString');
    const o = readToStringOptions(getOptionsObject(options), [ 'calendarName', 'offset', 'timeZoneName' ]);
    return zonedDateTimeToString(s, o.precision.precision, o.showCalendar, o.showTimeZone, o.showOffset,
      o.precision.increment, o.precision.unit, o.roundingMode);
  }

  toJSON() {
    return zonedDateTimeToString(slots(this, 'ZonedDateTime', 'toJSON'), 'auto', 'auto', 'auto', 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return zonedDateTimeToString(slots(this, 'ZonedDateTime', 'toLocaleString'), 'auto', 'auto', 'auto', 'auto');
  }

  valueOf() {
    typeError('Temporal.ZonedDateTime cannot be converted to a primitive; use compare');
  }

  startOfDay() {
    const s = slots(this, 'ZonedDateTime', 'startOfDay');
    const dt = isoDateTimeFor(s.timeZone, s.epochNs);
    return createZonedDateTime(startOfDay(s.timeZone, dt.date), s.timeZone, s.calendar);
  }

  getTimeZoneTransition(directionParam) {
    const s = slots(this, 'ZonedDateTime', 'getTimeZoneTransition');
    if (directionParam === undefined) typeError('getTimeZoneTransition requires a direction');
    if (typeof directionParam === 'string') {
      const str = directionParam;
      directionParam = Object.create(null);
      directionParam.direction = str;
    } else directionParam = getOptionsObject(directionParam);
    const direction = getDirectionOption(directionParam);
    if (direction === undefined) rangeError('direction is required');
    const transition = timeZoneTransition(s.timeZone, s.epochNs, direction);
    return transition === null ? null : createZonedDateTime(transition, s.timeZone, s.calendar);
  }

  toInstant() {
    return createInstant(slots(this, 'ZonedDateTime', 'toInstant').epochNs);
  }

  toPlainDate() {
    const s = slots(this, 'ZonedDateTime', 'toPlainDate');
    return createPlainDate(isoDateTimeFor(s.timeZone, s.epochNs).date, s.calendar);
  }

  toPlainTime() {
    const s = slots(this, 'ZonedDateTime', 'toPlainTime');
    return createPlainTime(isoDateTimeFor(s.timeZone, s.epochNs).time);
  }

  toPlainDateTime() {
    const s = slots(this, 'ZonedDateTime', 'toPlainDateTime');
    const dt = isoDateTimeFor(s.timeZone, s.epochNs);
    return createPlainDateTime(dt.date, dt.time, s.calendar);
  }
}
calendarDateGetters(ZonedDateTime, 'ZonedDateTime');
timeGetters(ZonedDateTime, 'ZonedDateTime');

// AddDurationToZonedDateTime
const addDurationToZoned = (s, like, options, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  const overflow = getOverflowOption(getOptionsObject(options));
  return createZonedDateTime(addZonedDateTime(s.epochNs, s.timeZone, toInternalDuration(d), overflow), s.timeZone, s.calendar);
};

// DifferenceTemporalZonedDateTime
const differenceZoned = (operation, s, other, options) => {
  const o = toZonedDateTimeRecord(other);
  if (o.calendar !== s.calendar) rangeError('The zoned date-times have different calendars');
  const settings = getDifferenceSettings(operation, getOptionsObject(options), 'datetime', [], 'nanosecond', 'hour');
  let result;
  if (!isDateUnit(settings.largestUnit)) {
    const internal = differenceInstant(s.epochNs, o.epochNs, settings.increment, settings.smallestUnit, settings.roundingMode);
    result = durationFromInternal(internal, settings.largestUnit);
  } else {
    if (!timeZoneEquals(s.timeZone, o.timeZone)) rangeError('Differences in calendar units need the same time zone');
    if (s.epochNs === o.epochNs) return createDuration(ZERO_DURATION);
    const internal = differenceZonedDateTimeWithRounding(s.epochNs, o.epochNs, s.timeZone, settings.largestUnit,
      settings.increment, settings.smallestUnit, settings.roundingMode);
    result = durationFromInternal(internal, 'hour');
  }
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};
