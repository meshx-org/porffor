// ---- Temporal.Duration ----

const createDuration = (d, target) => {
  checkValidDuration(d);
  const obj = target === undefined ? Object.create(Duration.prototype) : target;
  const s = { brand: 'Duration' };
  for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j]; s[k] = d[k] === 0 ? 0 : d[k]; }
  SLOTS.set(obj, s);
  return obj;
};
const durationFields = s => durationRecord(s.years, s.months, s.weeks, s.days, s.hours, s.minutes, s.seconds, s.milliseconds, s.microseconds, s.nanoseconds);
const negatedDuration = d => {
  const out = {};
  for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j]; out[k] = d[k] === 0 ? 0 : -d[k]; }
  return out;
};

// ToTemporalPartialDurationRecord: a bag's duration fields (read alphabetically), at least one
const toPartialDuration = bag => {
  if (!isObject(bag)) typeError('A duration-like object is required');
  const out = {};
  let any = false;
  for (let _j = 0, _l = DURATION_FIELDS_SORTED; _j < _l.length; _j++) { const k = _l[_j];
    const value = bag[k];
    if (value !== undefined) {
      out[k] = toIntegerIfIntegral(value);
      any = true;
    }
  }
  if (!any) typeError('A duration-like object needs at least one duration field');
  return out;
};

// ToTemporalDuration: a record
const toDurationRecord = item => {
  const own = slotsIf(item, 'Duration');
  if (own !== undefined) return durationFields(own);
  if (!isObject(item)) {
    if (typeof item !== 'string') typeError('A duration must be a string or an object');
    const d = parseDurationString(item);
    checkValidDuration(d);
    return d;
  }
  const partial = toPartialDuration(item);
  const d = {};
  for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j]; d[k] = partial[k] === undefined ? 0 : partial[k]; }
  checkValidDuration(d);
  return d;
};

// GetTemporalRelativeToOption: { plain } (a date), { zoned }, or neither
const getRelativeToOption = options => {
  const value = options.relativeTo;
  if (value === undefined) return {};
  let offsetBehaviour = 'option';
  let matchMinutes = false;
  let date, time, timeZone, offsetNs, calendar;
  if (isObject(value)) {
    const zdt = slotsIf(value, 'ZonedDateTime');
    if (zdt !== undefined) return { zoned: { epochNs: zdt.epochNs, timeZone: zdt.timeZone, calendar: zdt.calendar } };
    const pd = slotsIf(value, 'PlainDate');
    if (pd !== undefined) return { plain: { date: pd.date, calendar: pd.calendar } };
    const pdt = slotsIf(value, 'PlainDateTime');
    if (pdt !== undefined) return { plain: { date: pdt.date, calendar: pdt.calendar } };
    calendar = calendarWithISODefault(value);
    const fields = prepareCalendarFields(value, ZONED_FIELD_NAMES, []);
    const result = interpretDateTimeFields(fields, 'constrain');
    timeZone = fields.timeZone;
    if (fields.offset === undefined) offsetBehaviour = 'wall';
    else offsetNs = parseDateTimeUTCOffset(fields.offset);
    date = result.date;
    time = result.time;
  } else {
    if (typeof value !== 'string') typeError('relativeTo must be a string or an object');
    let parsed;
    try {
      parsed = parseISOString(value, 'zoned');
    } catch (e) {
      parsed = parseISOString(value, 'datetime');
    }
    if (parsed.timeZone !== undefined) {
      timeZone = toTimeZoneIdentifier(parsed.timeZone);
      if (parsed.z) offsetBehaviour = 'exact';
      else if (parsed.offsetNs === null) offsetBehaviour = 'wall';
      matchMinutes = !parsed.offsetSubMinute;
    } else if (parsed.z) rangeError('relativeTo with Z needs a time zone');
    offsetNs = parsed.z ? 0n : parsed.offsetNs;
    calendar = parsed.calendar === undefined ? 'iso8601' : canonicalizeCalendar(parsed.calendar);
    date = isoDate(parsed.year, parsed.month, parsed.day);
    time = parsed.time === null ? 'start-of-day' : parsed.time;
  }
  if (timeZone === undefined) {
    checkISODateWithinLimits(date);
    return { plain: { date, calendar } };
  }
  const epochNs = interpretISODateTimeOffset(date, time, offsetBehaviour, offsetBehaviour === 'option' ? offsetNs : 0n,
    timeZone, 'compatible', 'reject', matchMinutes);
  return { zoned: { epochNs, timeZone, calendar } };
};

// DateDurationDays: years, months and weeks as days, counted from a date
const dateDurationDays = (d, plainDate) => {
  const ymw = adjustDateDuration(d, 0);
  if (dateDurationSign(ymw) === 0) return d.days;
  const later = calendarDateAdd(plainDate, ymw, 'constrain');
  return d.days + epochDays(later.year, later.month, later.day) - epochDays(plainDate.year, plainDate.month, plainDate.day);
};

// TemporalDurationToString
const formatInt = n => BigInt(Math.abs(n)).toString();
const durationToString = (d, precision) => {
  const sign = durationSign(d);
  let datePart = '';
  if (d.years !== 0) datePart += formatInt(d.years) + 'Y';
  if (d.months !== 0) datePart += formatInt(d.months) + 'M';
  if (d.weeks !== 0) datePart += formatInt(d.weeks) + 'W';
  if (d.days !== 0) datePart += formatInt(d.days) + 'D';
  let timePart = '';
  if (d.hours !== 0) timePart += formatInt(d.hours) + 'H';
  if (d.minutes !== 0) timePart += formatInt(d.minutes) + 'M';
  const zeroMinutesAndHigher = d.years === 0 && d.months === 0 && d.weeks === 0 && d.days === 0 && d.hours === 0 && d.minutes === 0;
  const secondsNs = BigInt(d.seconds) * NS_PER.second + BigInt(d.milliseconds) * NS_PER.millisecond +
    BigInt(d.microseconds) * NS_PER.microsecond + BigInt(d.nanoseconds);
  if (secondsNs !== 0n || zeroMinutesAndHigher || precision !== 'auto') {
    const abs = bigAbs(secondsNs);
    timePart += (abs / NS_PER.second).toString() + formatFraction(Number(abs % NS_PER.second), precision) + 'S';
  }
  return (sign < 0 ? '-' : '') + 'P' + datePart + (timePart === '' ? '' : 'T' + timePart);
};

const negateRoundingMode = mode =>
  mode === 'ceil' ? 'floor' : mode === 'floor' ? 'ceil' : mode === 'halfCeil' ? 'halfFloor' : mode === 'halfFloor' ? 'halfCeil' : mode;

// GetDifferenceSettings
const getDifferenceSettings = (operation, options, group, disallowed, fallbackSmallest, smallestLargestDefault) => {
  let largestUnit = getUnitOption(options, 'largestUnit', undefined);
  const increment = getRoundingIncrementOption(options);
  let roundingMode = getRoundingModeOption(options, 'trunc');
  let smallestUnit = getUnitOption(options, 'smallestUnit', undefined);
  validateUnit(largestUnit, group, [ 'auto' ]);
  if (largestUnit === undefined) largestUnit = 'auto';
  if (disallowed.includes(largestUnit)) rangeError(`largestUnit ${largestUnit} is not allowed here`);
  validateUnit(smallestUnit, group);
  if (smallestUnit === undefined) smallestUnit = fallbackSmallest;
  if (disallowed.includes(smallestUnit)) rangeError(`smallestUnit ${smallestUnit} is not allowed here`);
  const defaultLargest = largerUnit(smallestLargestDefault, smallestUnit);
  if (largestUnit === 'auto') largestUnit = defaultLargest;
  if (largerUnit(largestUnit, smallestUnit) !== largestUnit) rangeError('largestUnit is smaller than smallestUnit');
  const maximum = maximumRoundingIncrement(smallestUnit);
  if (maximum !== undefined) validateRoundingIncrement(increment, maximum, false);
  if (operation === 'since') roundingMode = negateRoundingMode(roundingMode);
  return { smallestUnit, largestUnit, roundingMode, increment };
};

class Duration {
  constructor(years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0, microseconds = 0, nanoseconds = 0) {
    if (new.target === undefined) typeError('Temporal.Duration must be called with new');
    const d = durationRecord(
      toIntegerIfIntegral(years), toIntegerIfIntegral(months), toIntegerIfIntegral(weeks), toIntegerIfIntegral(days),
      toIntegerIfIntegral(hours), toIntegerIfIntegral(minutes), toIntegerIfIntegral(seconds),
      toIntegerIfIntegral(milliseconds), toIntegerIfIntegral(microseconds), toIntegerIfIntegral(nanoseconds));
    createDuration(d, this);
  }

  static from(item) {
    return createDuration(toDurationRecord(item));
  }

  static compare(one, two, options = undefined) {
    const d1 = toDurationRecord(one);
    const d2 = toDurationRecord(two);
    const resolved = getOptionsObject(options);
    const relativeTo = getRelativeToOption(resolved);
    if (DURATION_FIELDS.every(k => d1[k] === d2[k])) return 0;
    const largest1 = defaultLargestUnit(d1);
    const largest2 = defaultLargestUnit(d2);
    const i1 = toInternalDuration(d1);
    const i2 = toInternalDuration(d2);
    if (relativeTo.zoned !== undefined && (isDateUnit(largest1) || isDateUnit(largest2))) {
      const z = relativeTo.zoned;
      const after1 = addZonedDateTime(z.epochNs, z.timeZone, i1, 'constrain');
      const after2 = addZonedDateTime(z.epochNs, z.timeZone, i2, 'constrain');
      return after1 < after2 ? -1 : after1 > after2 ? 1 : 0;
    }
    let days1, days2;
    if (isCalendarUnit(largest1) || isCalendarUnit(largest2)) {
      if (relativeTo.plain === undefined) rangeError('Comparing calendar units needs relativeTo');
      days1 = dateDurationDays(i1.date, relativeTo.plain.date);
      days2 = dateDurationDays(i2.date, relativeTo.plain.date);
    } else {
      days1 = d1.days;
      days2 = d2.days;
    }
    // Add24HourDaysToTimeDuration, which has the time durations' range
    const t1 = checkTimeDuration(i1.time + BigInt(days1) * NS_PER_DAY);
    const t2 = checkTimeDuration(i2.time + BigInt(days2) * NS_PER_DAY);
    return t1 < t2 ? -1 : t1 > t2 ? 1 : 0;
  }

  get years() { return slots(this, 'Duration', 'years').years; }
  get months() { return slots(this, 'Duration', 'months').months; }
  get weeks() { return slots(this, 'Duration', 'weeks').weeks; }
  get days() { return slots(this, 'Duration', 'days').days; }
  get hours() { return slots(this, 'Duration', 'hours').hours; }
  get minutes() { return slots(this, 'Duration', 'minutes').minutes; }
  get seconds() { return slots(this, 'Duration', 'seconds').seconds; }
  get milliseconds() { return slots(this, 'Duration', 'milliseconds').milliseconds; }
  get microseconds() { return slots(this, 'Duration', 'microseconds').microseconds; }
  get nanoseconds() { return slots(this, 'Duration', 'nanoseconds').nanoseconds; }
  get sign() { return durationSign(slots(this, 'Duration', 'sign')); }
  get blank() { return durationSign(slots(this, 'Duration', 'blank')) === 0; }

  with(temporalDurationLike) {
    const s = slots(this, 'Duration', 'with');
    const partial = toPartialDuration(temporalDurationLike);
    const d = {};
    for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j]; d[k] = partial[k] === undefined ? s[k] : partial[k]; }
    return createDuration(d);
  }

  negated() {
    return createDuration(negatedDuration(slots(this, 'Duration', 'negated')));
  }

  abs() {
    const s = slots(this, 'Duration', 'abs');
    const d = {};
    for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j]; d[k] = Math.abs(s[k]); }
    return createDuration(d);
  }

  add(other) {
    return addDurations(slots(this, 'Duration', 'add'), other, 1);
  }

  subtract(other) {
    return addDurations(slots(this, 'Duration', 'subtract'), other, -1);
  }

  round(roundTo) {
    const d = durationFields(slots(this, 'Duration', 'round'));
    if (roundTo === undefined) typeError('round requires options');
    if (typeof roundTo === 'string') {
      const s = roundTo;
      roundTo = Object.create(null);
      roundTo.smallestUnit = s;
    } else roundTo = getOptionsObject(roundTo);
    let largestUnit = getUnitOption(roundTo, 'largestUnit', undefined);
    const relativeTo = getRelativeToOption(roundTo);
    const increment = getRoundingIncrementOption(roundTo);
    const roundingMode = getRoundingModeOption(roundTo, 'halfExpand');
    let smallestUnit = getUnitOption(roundTo, 'smallestUnit', undefined);
    validateUnit(smallestUnit, 'datetime');
    let smallestUnitPresent = true, largestUnitPresent = true;
    if (smallestUnit === undefined) {
      smallestUnitPresent = false;
      smallestUnit = 'nanosecond';
    }
    const existingLargestUnit = defaultLargestUnit(d);
    const defaultLargest = largerUnit(existingLargestUnit, smallestUnit);
    if (largestUnit === undefined) {
      largestUnitPresent = false;
      largestUnit = defaultLargest;
    } else if (largestUnit === 'auto') largestUnit = defaultLargest;
    if (!smallestUnitPresent && !largestUnitPresent) rangeError('smallestUnit or largestUnit is required');
    if (largerUnit(largestUnit, smallestUnit) !== largestUnit) rangeError('largestUnit is smaller than smallestUnit');
    const maximum = maximumRoundingIncrement(smallestUnit);
    if (maximum !== undefined) validateRoundingIncrement(increment, maximum, false);
    if (increment > 1 && largestUnit !== smallestUnit && isDateUnit(smallestUnit)) rangeError('roundingIncrement must be 1 with these units');

    if (relativeTo.zoned !== undefined) {
      const z = relativeTo.zoned;
      const internal = toInternalDuration(d);
      const target = addZonedDateTime(z.epochNs, z.timeZone, internal, 'constrain');
      const result = differenceZonedDateTimeWithRounding(z.epochNs, target, z.timeZone, largestUnit, increment, smallestUnit, roundingMode);
      return createDuration(durationFromInternal(result, isDateUnit(largestUnit) ? 'hour' : largestUnit));
    }
    if (relativeTo.plain !== undefined) {
      const p = relativeTo.plain;
      const internal = toInternalDurationWith24HourDays(d);
      const targetTime = addTime(MIDNIGHT, internal.time);
      const dd = adjustDateDuration(internal.date, targetTime.days);
      const targetDate = calendarDateAdd(p.date, dd, 'constrain');
      const result = differencePlainDateTimeWithRounding(isoDateTime(p.date, MIDNIGHT), isoDateTime(targetDate, targetTime.time),
        largestUnit, increment, smallestUnit, roundingMode);
      return createDuration(durationFromInternal(result, largestUnit));
    }
    if (isCalendarUnit(existingLargestUnit) || isCalendarUnit(largestUnit)) rangeError('Rounding calendar units needs relativeTo');
    const internal = toInternalDurationWith24HourDays(d);
    let result;
    if (smallestUnit === 'day') {
      const days = roundRatioToIncrement(internal.time, NS_PER_DAY, BigInt(increment), roundingMode);
      result = internalDuration(dateDuration(0, 0, 0, Number(days)), 0n);
    } else {
      result = internalDuration(ZERO_DATE_DURATION, roundTimeDuration(internal.time, increment, smallestUnit, roundingMode));
    }
    return createDuration(durationFromInternal(result, largestUnit));
  }

  total(totalOf) {
    const d = durationFields(slots(this, 'Duration', 'total'));
    if (totalOf === undefined) typeError('total requires options');
    if (typeof totalOf === 'string') {
      const s = totalOf;
      totalOf = Object.create(null);
      totalOf.unit = s;
    } else totalOf = getOptionsObject(totalOf);
    const relativeTo = getRelativeToOption(totalOf);
    const unit = getUnitOption(totalOf, 'unit', undefined);
    if (unit === undefined) rangeError('unit is required');
    validateUnit(unit, 'datetime');
    if (relativeTo.zoned !== undefined) {
      const z = relativeTo.zoned;
      const target = addZonedDateTime(z.epochNs, z.timeZone, toInternalDuration(d), 'constrain');
      if (!isDateUnit(unit)) return totalTimeDuration(target - z.epochNs, unit);
      const diff = differenceZonedDateTime(z.epochNs, target, z.timeZone, unit);
      return totalRelativeDuration(diff, z.epochNs, target, isoDateTimeFor(z.timeZone, z.epochNs), z.timeZone, unit);
    }
    if (relativeTo.plain !== undefined) {
      const p = relativeTo.plain;
      const internal = toInternalDurationWith24HourDays(d);
      const targetTime = addTime(MIDNIGHT, internal.time);
      const targetDate = calendarDateAdd(p.date, adjustDateDuration(internal.date, targetTime.days), 'constrain');
      const one = isoDateTime(p.date, MIDNIGHT);
      const two = isoDateTime(targetDate, targetTime.time);
      if (compareISODateTime(one, two) === 0) return 0;
      checkISODateTimeWithinLimits(one.date, one.time);
      checkISODateTimeWithinLimits(two.date, two.time);
      const diff = differenceISODateTime(one, two, unit);
      if (unit === 'nanosecond') return Number(diff.time);
      return totalRelativeDuration(diff, utcEpochNs(one.date, one.time), utcEpochNs(two.date, two.time), one, undefined, unit);
    }
    if (isCalendarUnit(defaultLargestUnit(d)) || isCalendarUnit(unit)) rangeError('A total in calendar units needs relativeTo');
    return totalTimeDuration(toInternalDurationWith24HourDays(d).time, unit);
  }

  toString(options = undefined) {
    const d = durationFields(slots(this, 'Duration', 'toString'));
    const resolved = getOptionsObject(options);
    const digits = getFractionalSecondDigitsOption(resolved);
    const roundingMode = getRoundingModeOption(resolved, 'trunc');
    const smallestUnit = getUnitOption(resolved, 'smallestUnit', undefined);
    validateUnit(smallestUnit, 'time');
    if (smallestUnit === 'hour' || smallestUnit === 'minute') rangeError(`smallestUnit ${smallestUnit} is not allowed here`);
    const precision = secondsStringPrecision(smallestUnit, digits);
    if (precision.unit === 'nanosecond' && precision.increment === 1) return durationToString(d, precision.precision);
    const largestUnit = defaultLargestUnit(d);
    const internal = toInternalDuration(d);
    const time = roundTimeDuration(internal.time, precision.increment, precision.unit, roundingMode);
    const rounded = durationFromInternal(internalDuration(internal.date, time), largerUnit(largestUnit, 'second'));
    return durationToString(rounded, precision.precision);
  }

  toJSON() {
    return durationToString(durationFields(slots(this, 'Duration', 'toJSON')), 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return durationToString(durationFields(slots(this, 'Duration', 'toLocaleString')), 'auto');
  }

  valueOf() {
    typeError('Temporal.Duration cannot be converted to a primitive; use compare');
  }
}

// AddDurations
const addDurations = (s, other, sign) => {
  const d1 = durationFields(s);
  let d2 = toDurationRecord(other);
  if (sign < 0) d2 = negatedDuration(d2);
  const largestUnit = largerUnit(defaultLargestUnit(d1), defaultLargestUnit(d2));
  if (isCalendarUnit(largestUnit)) rangeError('Adding durations with calendar units needs a relativeTo; use a date');
  const time = checkTimeDuration(toInternalDurationWith24HourDays(d1).time + toInternalDurationWith24HourDays(d2).time);
  return createDuration(durationFromInternal(internalDuration(ZERO_DATE_DURATION, time), largestUnit));
};

// ---- Temporal.Instant ----

// ToBigInt
const toBigInt = value => {
  const prim = toPrimitiveNumberHint(value);
  if (typeof prim === 'bigint') return prim;
  if (typeof prim === 'boolean') return prim ? 1n : 0n;
  if (typeof prim === 'string') {
    try {
      return BigInt(prim);
    } catch (e) {
      throw new SyntaxError(`Cannot convert ${prim} to a BigInt`);
    }
  }
  return typeError(`Cannot convert ${typeof prim === 'symbol' ? 'a Symbol' : prim} to a BigInt`);
};

// ToPrimitive with hint number
const toPrimitiveNumberHint = value => {
  if (!isObject(value)) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') typeError('Symbol.toPrimitive is not callable');
    const out = exotic.call(value, 'number');
    if (isObject(out)) typeError('Cannot convert object to primitive value');
    return out;
  }
  for (let _j = 0, _l = [ 'valueOf', 'toString' ]; _j < _l.length; _j++) { const name = _l[_j];
    const method = value[name];
    if (typeof method === 'function') {
      const out = method.call(value);
      if (!isObject(out)) return out;
    }
  }
  return typeError('Cannot convert object to primitive value');
};

const createInstant = (epochNs, target) => {
  checkEpochNs(epochNs);
  const obj = target === undefined ? Object.create(Instant.prototype) : target;
  SLOTS.set(obj, { brand: 'Instant', epochNs });
  return obj;
};

// ToTemporalInstant: epoch nanoseconds
const toInstantNs = item => {
  if (isObject(item)) {
    const b = brandOf(item);
    if (b === 'Instant' || b === 'ZonedDateTime') return SLOTS.get(item).epochNs;
    item = toPrimitiveString(item);
  }
  if (typeof item !== 'string') typeError('An instant must be a string or a Temporal.Instant');
  const parsed = parseISOString(item, 'instant');
  const date = isoDate(parsed.year, parsed.month, parsed.day);
  const offset = parsed.z ? 0n : parsed.offsetNs;
  // the date-time with its offset must be within the limits, then the instant
  const balanced = isoDateTimeFromEpochNs(utcEpochNs(date, parsed.time) - offset);
  checkISODateTimeWithinLimits(balanced.date, balanced.time);
  const ns = utcEpochNs(date, parsed.time) - offset;
  checkEpochNs(ns);
  return ns;
};

// RoundNumberToIncrementAsIfPositive, for epoch nanoseconds
const roundAsIfPositive = (x, increment, mode) => {
  const q = floorDiv(x, increment);
  const r = x - q * increment;
  if (r === 0n) return x;
  const umode = unsignedRoundingMode(mode, false);
  let up;
  const doubled = r * 2n;
  if (umode === 'zero') up = false;
  else if (umode === 'infinity') up = true;
  else if (doubled < increment) up = false;
  else if (doubled > increment) up = true;
  else if (umode === 'half-zero') up = false;
  else if (umode === 'half-infinity') up = true;
  else up = floorMod(q, 2n) === 1n;
  return (up ? q + 1n : q) * increment;
};

const INSTANT_ROUND_MAXIMUM = { hour: 24, minute: 1440, second: 86400, millisecond: 86400000, microsecond: 86400000000, nanosecond: 86400000000000 };

// TemporalInstantToString
const instantToString = (epochNs, timeZone, precision) => {
  const tz = timeZone === undefined ? 'UTC' : timeZone;
  const offsetNs = offsetNsFor(tz, epochNs);
  const dt = isoDateTimeFromEpochNs(epochNs, offsetNs);
  const s = `${formatDate(dt.date)}T${formatTime(dt.time, precision)}`;
  return s + (timeZone === undefined ? 'Z' : formatOffsetRounded(offsetNs));
};

class Instant {
  constructor(epochNanoseconds) {
    if (new.target === undefined) typeError('Temporal.Instant must be called with new');
    const ns = toBigInt(epochNanoseconds);
    if (!isValidEpochNs(ns)) rangeError('Instant outside the representable range');
    createInstant(ns, this);
  }

  static from(item) {
    return createInstant(toInstantNs(item));
  }

  static fromEpochMilliseconds(epochMilliseconds) {
    const n = toNum(epochMilliseconds);
    if (!isFiniteNumber(n) || Math.trunc(n) !== n) rangeError(`${n} is not an integer number of milliseconds`);
    const ns = BigInt(n) * 1000000n;
    if (!isValidEpochNs(ns)) rangeError('Instant outside the representable range');
    return createInstant(ns);
  }

  static fromEpochNanoseconds(epochNanoseconds) {
    const ns = toBigInt(epochNanoseconds);
    if (!isValidEpochNs(ns)) rangeError('Instant outside the representable range');
    return createInstant(ns);
  }

  static compare(one, two) {
    const a = toInstantNs(one);
    const b = toInstantNs(two);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  get epochMilliseconds() {
    return Number(floorDiv(slots(this, 'Instant', 'epochMilliseconds').epochNs, 1000000n));
  }

  get epochNanoseconds() {
    return slots(this, 'Instant', 'epochNanoseconds').epochNs;
  }

  add(temporalDurationLike) {
    return addDurationToInstant(slots(this, 'Instant', 'add'), temporalDurationLike, 1);
  }

  subtract(temporalDurationLike) {
    return addDurationToInstant(slots(this, 'Instant', 'subtract'), temporalDurationLike, -1);
  }

  until(other, options = undefined) {
    return differenceInstants('until', slots(this, 'Instant', 'until'), other, options);
  }

  since(other, options = undefined) {
    return differenceInstants('since', slots(this, 'Instant', 'since'), other, options);
  }

  round(roundTo) {
    const s = slots(this, 'Instant', 'round');
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
    validateRoundingIncrement(increment, INSTANT_ROUND_MAXIMUM[smallestUnit], true);
    return createInstant(roundAsIfPositive(s.epochNs, BigInt(increment) * NS_PER[smallestUnit], roundingMode));
  }

  equals(other) {
    const s = slots(this, 'Instant', 'equals');
    return toInstantNs(other) === s.epochNs;
  }

  toString(options = undefined) {
    const s = slots(this, 'Instant', 'toString');
    const resolved = getOptionsObject(options);
    const digits = getFractionalSecondDigitsOption(resolved);
    const roundingMode = getRoundingModeOption(resolved, 'trunc');
    const smallestUnit = getUnitOption(resolved, 'smallestUnit', undefined);
    let timeZone = resolved.timeZone;
    validateUnit(smallestUnit, 'time');
    if (smallestUnit === 'hour') rangeError('smallestUnit hour is not allowed here');
    if (timeZone !== undefined) timeZone = toTimeZoneIdentifier(timeZone);
    const precision = secondsStringPrecision(smallestUnit, digits);
    const ns = roundAsIfPositive(s.epochNs, BigInt(precision.increment) * NS_PER[precision.unit], roundingMode);
    checkEpochNs(ns);
    return instantToString(ns, timeZone, precision.precision);
  }

  toJSON() {
    return instantToString(slots(this, 'Instant', 'toJSON').epochNs, undefined, 'auto');
  }

  toLocaleString(locales = undefined, options = undefined) {
    return instantToString(slots(this, 'Instant', 'toLocaleString').epochNs, undefined, 'auto');
  }

  valueOf() {
    typeError('Temporal.Instant cannot be converted to a primitive; use compare');
  }

  toZonedDateTimeISO(timeZone) {
    const s = slots(this, 'Instant', 'toZonedDateTimeISO');
    return createZonedDateTime(s.epochNs, toTimeZoneIdentifier(timeZone), 'iso8601');
  }
}

// AddDurationToInstant
const addDurationToInstant = (s, like, sign) => {
  let d = toDurationRecord(like);
  if (sign < 0) d = negatedDuration(d);
  if (isDateUnit(defaultLargestUnit(d))) rangeError('An instant cannot add years, months, weeks or days');
  return createInstant(addInstant(s.epochNs, toInternalDurationWith24HourDays(d).time));
};

// DifferenceTemporalInstant
const differenceInstants = (operation, s, other, options) => {
  const otherNs = toInstantNs(other);
  const resolved = getOptionsObject(options);
  const settings = getDifferenceSettings(operation, resolved, 'time', [], 'nanosecond', 'second');
  const internal = differenceInstant(s.epochNs, otherNs, settings.increment, settings.smallestUnit, settings.roundingMode);
  let result = durationFromInternal(internal, settings.largestUnit);
  if (operation === 'since') result = negatedDuration(result);
  return createDuration(result);
};
