// ---- durations ----

const DURATION_FIELDS = [ 'years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds' ];
// the order a property bag's duration fields are read in (alphabetical)
const DURATION_FIELDS_SORTED = [ 'days', 'hours', 'microseconds', 'milliseconds', 'minutes', 'months', 'nanoseconds', 'seconds', 'weeks', 'years' ];

const MAX_TIME_DURATION = 9007199254740991999999999n; // 2^53 seconds, less a nanosecond
const TWO_32 = 4294967296;

const durationRecord = (years, months, weeks, days, hours, minutes, seconds, milliseconds, microseconds, nanoseconds) =>
  ({ years, months, weeks, days, hours, minutes, seconds, milliseconds, microseconds, nanoseconds });
const ZERO_DURATION = durationRecord(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

const durationSign = d => {
  for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j];
    if (d[k] < 0) return -1;
    if (d[k] > 0) return 1;
  }
  return 0;
};

// the time fields as nanoseconds (BigInt), exact for any Numbers
const timeFieldsNs = d =>
  BigInt(d.hours) * NS_PER.hour + BigInt(d.minutes) * NS_PER.minute + BigInt(d.seconds) * NS_PER.second +
  BigInt(d.milliseconds) * NS_PER.millisecond + BigInt(d.microseconds) * NS_PER.microsecond + BigInt(d.nanoseconds);

// IsValidDuration
const isValidDuration = d => {
  let sign = 0;
  for (let _j = 0, _l = DURATION_FIELDS; _j < _l.length; _j++) { const k = _l[_j];
    const v = d[k];
    if (!isFiniteNumber(v)) return false;
    if (v < 0) {
      if (sign > 0) return false;
      sign = -1;
    } else if (v > 0) {
      if (sign < 0) return false;
      sign = 1;
    }
  }
  if (Math.abs(d.years) >= TWO_32 || Math.abs(d.months) >= TWO_32 || Math.abs(d.weeks) >= TWO_32) return false;
  const seconds = BigInt(d.days) * NS_PER_DAY + timeFieldsNs(d);
  return bigAbs(seconds) <= MAX_TIME_DURATION;
};
const checkValidDuration = d => {
  if (!isValidDuration(d)) rangeError('Invalid duration');
};

// DefaultTemporalLargestUnit: the largest unit with a value
const defaultLargestUnit = d => {
  for (let k = 0; k < DURATION_FIELDS.length; k++) if (d[DURATION_FIELDS[k]] !== 0) return UNITS[k];
  return 'nanosecond';
};

// ---- internal durations: a date part (Numbers) and a time part (BigInt ns) ----

const dateDuration = (years, months, weeks, days) => ({ years, months, weeks, days });
const ZERO_DATE_DURATION = dateDuration(0, 0, 0, 0);
const internalDuration = (date, time) => ({ date, time });

const dateDurationSign = d => {
  for (let _j = 0, _l = [ 'years', 'months', 'weeks', 'days' ]; _j < _l.length; _j++) { const k = _l[_j];
    if (d[k] < 0) return -1;
    if (d[k] > 0) return 1;
  }
  return 0;
};
const internalDurationSign = d => dateDurationSign(d.date) || bigSign(d.time);

const toInternalDuration = d => internalDuration(dateDuration(d.years, d.months, d.weeks, d.days), timeFieldsNs(d));
const toInternalDurationWith24HourDays = d =>
  internalDuration(dateDuration(d.years, d.months, d.weeks, 0), timeFieldsNs(d) + BigInt(d.days) * NS_PER_DAY);

const checkTimeDuration = ns => {
  if (bigAbs(ns) > MAX_TIME_DURATION) rangeError('Duration out of range');
  return ns;
};

// RoundTimeDurationToIncrement / RoundTimeDuration
const roundTimeDuration = (ns, increment, unit, mode) =>
  checkTimeDuration(roundBigIntToIncrement(ns, BigInt(increment) * NS_PER[unit], mode));

// TemporalDurationFromInternal: the time part balanced up to largestUnit (a date unit: days)
const durationFromInternal = (internal, largestUnit) => {
  const sign = internal.time < 0n ? -1n : 1n;
  let ns = bigAbs(internal.time);
  let days = 0n, hours = 0n, minutes = 0n, seconds = 0n, milliseconds = 0n, microseconds = 0n;
  const index = unitIndex(largestUnit);
  if (index <= unitIndex('microsecond')) {
    microseconds = ns / 1000n;
    ns %= 1000n;
  }
  if (index <= unitIndex('millisecond')) {
    milliseconds = microseconds / 1000n;
    microseconds %= 1000n;
  }
  if (index <= unitIndex('second')) {
    seconds = milliseconds / 1000n;
    milliseconds %= 1000n;
  }
  if (index <= unitIndex('minute')) {
    minutes = seconds / 60n;
    seconds %= 60n;
  }
  if (index <= unitIndex('hour')) {
    hours = minutes / 60n;
    minutes %= 60n;
  }
  if (index <= unitIndex('day')) {
    days = hours / 24n;
    hours %= 24n;
  }
  const f = x => {
    const v = Number(x * sign);
    return v === 0 ? 0 : v;
  };
  const d = durationRecord(internal.date.years, internal.date.months, internal.date.weeks, internal.date.days + f(days),
    f(hours), f(minutes), f(seconds), f(milliseconds), f(microseconds), f(ns));
  checkValidDuration(d);
  return d;
};

// ---- ISO calendar arithmetic ----

// BalanceISOYearMonth
const balanceISOYearMonth = (year, month) => {
  const m0 = month - 1;
  return { year: year + Math.floor(m0 / 12), month: numberMod(m0, 12) + 1 };
};

// CalendarDateAdd (ISO 8601): years and months first (the day regulated), then weeks and days
const calendarDateAdd = (date, duration, overflow) => {
  const ym = balanceISOYearMonth(date.year + duration.years, date.month + duration.months);
  const regulated = regulateISODate(ym.year, ym.month, date.day, overflow);
  const out = addDaysToISODate(regulated, duration.weeks * 7 + duration.days);
  checkISODateWithinLimits(out);
  return out;
};

// CompareSurpasses
const compareSurpasses = (sign, year, month, day, target) => {
  if (year !== target.year) return sign * (year - target.year) > 0;
  if (month !== target.month) return sign * (month - target.month) > 0;
  if (day !== target.day) return sign * (day - target.day) > 0;
  return false;
};

// ISODateSurpasses: whether one + (years, months) passes two, going sign's way
const isoDateSurpasses = (sign, one, two, years, months) => {
  const ym = balanceISOYearMonth(one.year + years, one.month + months);
  return compareSurpasses(sign, ym.year, ym.month, one.day, two);
};

// CalendarDateUntil (ISO 8601): from one to two in units up to largestUnit
const calendarDateUntil = (one, two, largestUnit) => {
  const sign = -compareISODate(one, two);
  if (sign === 0) return ZERO_DATE_DURATION;
  let years = 0, months = 0;
  if (largestUnit === 'year' || largestUnit === 'month') {
    let candidateYears = two.year - one.year;
    if (candidateYears !== 0) candidateYears -= sign;
    while (!isoDateSurpasses(sign, one, two, candidateYears, 0)) {
      years = candidateYears;
      candidateYears += sign;
    }
    let candidateMonths = sign;
    while (!isoDateSurpasses(sign, one, two, years, candidateMonths)) {
      months = candidateMonths;
      candidateMonths += sign;
    }
    if (largestUnit === 'month') {
      months += years * 12;
      years = 0;
    }
  }
  const ym = balanceISOYearMonth(one.year + years, one.month + months);
  const constrained = regulateISODate(ym.year, ym.month, one.day, 'constrain');
  // the days left: adding days never goes back, so they are the difference of the two dates
  let days = epochDays(two.year, two.month, two.day) - epochDays(constrained.year, constrained.month, constrained.day);
  let weeks = 0;
  if (largestUnit === 'week') {
    weeks = Math.trunc(days / 7);
    days -= weeks * 7;
  }
  return dateDuration(years, months, weeks === 0 ? 0 : weeks, days === 0 ? 0 : days);
};

// DifferenceISODateTime
const differenceISODateTime = (one, two, largestUnit) => {
  let time = timeToNs(two.time) - timeToNs(one.time);
  const timeSign = bigSign(time);
  const dateSign = compareISODate(two.date, one.date);
  let adjusted = two.date;
  if (timeSign === -dateSign) {
    adjusted = addDaysToISODate(adjusted, timeSign);
    time -= BigInt(timeSign) * NS_PER_DAY;
  }
  const dateLargestUnit = largerUnit('day', largestUnit);
  let date = calendarDateUntil(one.date, adjusted, dateLargestUnit);
  if (largestUnit !== dateLargestUnit) {
    time += BigInt(date.days) * NS_PER_DAY;
    date = dateDuration(date.years, date.months, date.weeks, 0);
  }
  return internalDuration(date, time);
};

// DifferenceZonedDateTime: calendar units counted in the time zone's local dates
const differenceZonedDateTime = (ns1, ns2, tz, largestUnit) => {
  if (ns1 === ns2) return internalDuration(ZERO_DATE_DURATION, 0n);
  const start = isoDateTimeFor(tz, ns1);
  const end = isoDateTimeFor(tz, ns2);
  if (compareISODate(start.date, end.date) === 0) return internalDuration(ZERO_DATE_DURATION, ns2 - ns1);
  const sign = ns2 < ns1 ? -1 : 1;
  const maxDayCorrection = sign === 1 ? 2 : 1;
  let dayCorrection = 0;
  let time = timeToNs(end.time) - timeToNs(start.time);
  if (bigSign(time) === -sign) dayCorrection++;
  let intermediateDate;
  let success = false;
  while (dayCorrection <= maxDayCorrection && !success) {
    intermediateDate = addDaysToISODate(end.date, -dayCorrection * sign);
    const intermediateNs = epochNsFor(tz, intermediateDate, start.time, 'compatible');
    time = ns2 - intermediateNs;
    if (sign !== -bigSign(time)) success = true;
    dayCorrection++;
  }
  if (!success) rangeError('Time zone offset shifts too far');
  const date = calendarDateUntil(start.date, intermediateDate, largerUnit(largestUnit, 'day'));
  return internalDuration(date, time);
};

// ---- rounding a duration relative to a starting point ----

const adjustDateDuration = (d, days, weeks, months) =>
  dateDuration(d.years, months === undefined ? d.months : months, weeks === undefined ? d.weeks : weeks, days);

// ApplyUnsignedRoundingMode for r1 + progress (numerator / denominator, 0 to 1) of a step to r2
const roundsUp = (numerator, denominator, umode, r1Cardinality) => {
  if (numerator === 0n) return false;
  if (numerator === denominator) return true;
  if (umode === 'zero') return false;
  if (umode === 'infinity') return true;
  const doubled = numerator * 2n;
  if (doubled < denominator) return false;
  if (doubled > denominator) return true;
  if (umode === 'half-zero') return false;
  if (umode === 'half-infinity') return true;
  return r1Cardinality % 2 !== 0;
};

// the endpoint (UTC, or in a time zone) of a date-time
const epochNsOfDateTime = (date, time, tz) => tz === undefined ? utcEpochNs(date, time) : epochNsFor(tz, date, time, 'compatible');

// ComputeNudgeWindow: the two candidate durations around the rounded unit and their instants
// (shifted one increment on when the destination is past the first window)
const computeNudgeWindow = (sign, duration, originEpochNs, origin, tz, increment, unit, shift) => {
  let r1, r2, startDuration, endDuration;
  const d = duration.date;
  const base = value => Number(roundBigIntToIncrement(BigInt(value), BigInt(increment), 'trunc')) + (shift ? increment * sign : 0);
  if (unit === 'year') {
    r1 = base(d.years);
    r2 = r1 + increment * sign;
    startDuration = dateDuration(r1, 0, 0, 0);
    endDuration = dateDuration(r2, 0, 0, 0);
  } else if (unit === 'month') {
    r1 = base(d.months);
    r2 = r1 + increment * sign;
    startDuration = adjustDateDuration(d, 0, 0, r1);
    endDuration = adjustDateDuration(d, 0, 0, r2);
  } else if (unit === 'week') {
    const yearsMonths = adjustDateDuration(d, 0, 0);
    const weeksStart = calendarDateAdd(origin.date, yearsMonths, 'constrain');
    const weeksEnd = addDaysToISODate(weeksStart, d.days);
    const untilResult = calendarDateUntil(weeksStart, weeksEnd, 'week');
    r1 = base(d.weeks + untilResult.weeks);
    r2 = r1 + increment * sign;
    startDuration = adjustDateDuration(d, 0, r1);
    endDuration = adjustDateDuration(d, 0, r2);
  } else {
    r1 = base(d.days);
    r2 = r1 + increment * sign;
    startDuration = adjustDateDuration(d, r1);
    endDuration = adjustDateDuration(d, r2);
  }
  let startEpochNs;
  // a start of no duration at all is the origin itself
  if (dateDurationSign(startDuration) === 0) startEpochNs = originEpochNs;
  else startEpochNs = epochNsOfDateTime(calendarDateAdd(origin.date, startDuration, 'constrain'), origin.time, tz);
  const endEpochNs = epochNsOfDateTime(calendarDateAdd(origin.date, endDuration, 'constrain'), origin.time, tz);
  return { r1, r2, startEpochNs, endEpochNs, startDuration, endDuration };
};

// NudgeToCalendarUnit: gives { nudge: { duration, nudgedEpochNs, didExpand }, total }
const nudgeToCalendarUnit = (sign, duration, originEpochNs, destEpochNs, origin, tz, increment, unit, roundingMode) => {
  const inside = w => sign === 1
    ? w.startEpochNs <= destEpochNs && destEpochNs <= w.endEpochNs
    : w.endEpochNs <= destEpochNs && destEpochNs <= w.startEpochNs;
  let w = computeNudgeWindow(sign, duration, originEpochNs, origin, tz, increment, unit, false);
  if (!inside(w)) {
    w = computeNudgeWindow(sign, duration, originEpochNs, origin, tz, increment, unit, true);
    if (!inside(w)) rangeError('Rounding span does not contain the end');
  }
  const { r1, startEpochNs, endEpochNs, startDuration, endDuration } = w;
  if (startEpochNs === endEpochNs) rangeError('Rounding over an empty span');
  // progress is numerator / denominator, from 0 to 1
  const num = bigAbs(destEpochNs - startEpochNs);
  const den = bigAbs(endEpochNs - startEpochNs);
  // total: r1 + progress × increment × sign, as the nearest Number
  const total = ratioToNumber(BigInt(r1) * den + BigInt(increment * sign) * num, den);
  const umode = unsignedRoundingMode(roundingMode, sign < 0);
  const up = roundsUp(num, den, umode, Math.abs(r1) / increment);
  let result;
  if (up) result = { duration: internalDuration(endDuration, 0n), nudgedEpochNs: endEpochNs, didExpand: true };
  else result = { duration: internalDuration(startDuration, 0n), nudgedEpochNs: startEpochNs, didExpand: false };
  return { nudge: result, total };
};

// NudgeToZonedTime: time units in a day whose length the time zone decides
const nudgeToZonedTime = (sign, duration, origin, tz, increment, unit, roundingMode) => {
  const start = calendarDateAdd(origin.date, duration.date, 'constrain');
  const endDate = addDaysToISODate(start, sign);
  const startEpochNs = epochNsFor(tz, start, origin.time, 'compatible');
  const endEpochNs = epochNsFor(tz, endDate, origin.time, 'compatible');
  const daySpan = endEpochNs - startEpochNs;
  if (bigSign(daySpan) !== sign) rangeError('Time zone offset shifts too far');
  const unitLength = BigInt(increment) * NS_PER[unit];
  let rounded = checkTimeDuration(roundBigIntToIncrement(duration.time, unitLength, roundingMode));
  const beyond = rounded - daySpan;
  let didRoundBeyondDay, dayDelta, nudgedEpochNs;
  if (bigSign(beyond) !== -sign) {
    didRoundBeyondDay = true;
    dayDelta = sign;
    rounded = checkTimeDuration(roundBigIntToIncrement(beyond, unitLength, roundingMode));
    nudgedEpochNs = endEpochNs + rounded;
  } else {
    didRoundBeyondDay = false;
    dayDelta = 0;
    nudgedEpochNs = startEpochNs + rounded;
  }
  const date = adjustDateDuration(duration.date, duration.date.days + dayDelta);
  return { duration: internalDuration(date, rounded), nudgedEpochNs, didExpand: didRoundBeyondDay };
};

// NudgeToDayOrTime: days of 24 hours
const nudgeToDayOrTime = (duration, destEpochNs, largestUnit, increment, smallestUnit, roundingMode) => {
  const time = duration.time + BigInt(duration.date.days) * NS_PER_DAY;
  const rounded = checkTimeDuration(roundBigIntToIncrement(time, BigInt(increment) * NS_PER[smallestUnit], roundingMode));
  const diff = rounded - time;
  const wholeDays = time / NS_PER_DAY;
  const roundedWholeDays = rounded / NS_PER_DAY;
  const dayDelta = roundedWholeDays - wholeDays;
  const didExpandDays = bigSign(dayDelta) === bigSign(time);
  const nudgedEpochNs = destEpochNs + diff;
  let days = 0n, remainder = rounded;
  if (isDateUnit(largestUnit)) {
    days = roundedWholeDays;
    remainder = rounded - roundedWholeDays * NS_PER_DAY;
  }
  const date = adjustDateDuration(duration.date, Number(days));
  return { duration: internalDuration(date, remainder), nudgedEpochNs, didExpand: didExpandDays };
};

// BubbleRelativeDuration: a unit rounded up to its whole may make the next larger one whole
const bubbleRelativeDuration = (sign, duration, nudgedEpochNs, origin, tz, largestUnit, smallestUnit) => {
  if (smallestUnit === largestUnit) return duration;
  const largestIndex = unitIndex(largestUnit);
  let index = unitIndex(smallestUnit) - 1;
  let done = false;
  while (index >= largestIndex && !done) {
    const unit = UNITS[index];
    if (unit !== 'week' || largestUnit === 'week') {
      const d = duration.date;
      let endDuration;
      if (unit === 'year') endDuration = dateDuration(d.years + sign, 0, 0, 0);
      else if (unit === 'month') endDuration = adjustDateDuration(d, 0, 0, d.months + sign);
      else if (unit === 'week') endDuration = adjustDateDuration(d, 0, d.weeks + sign);
      else endDuration = adjustDateDuration(d, d.days + sign);
      const end = calendarDateAdd(origin.date, endDuration, 'constrain');
      const endEpochNs = epochNsOfDateTime(end, origin.time, tz);
      const beyond = nudgedEpochNs - endEpochNs;
      if (bigSign(beyond) !== -sign) duration = internalDuration(endDuration, 0n);
      else done = true;
    }
    index--;
  }
  return duration;
};

// RoundRelativeDuration
const roundRelativeDuration = (duration, originEpochNs, destEpochNs, origin, tz, largestUnit, increment, smallestUnit, roundingMode) => {
  const irregular = isCalendarUnit(smallestUnit) || (tz !== undefined && smallestUnit === 'day');
  const sign = internalDurationSign(duration) < 0 ? -1 : 1;
  let nudge;
  if (irregular) nudge = nudgeToCalendarUnit(sign, duration, originEpochNs, destEpochNs, origin, tz, increment, smallestUnit, roundingMode).nudge;
  else if (tz !== undefined) nudge = nudgeToZonedTime(sign, duration, origin, tz, increment, smallestUnit, roundingMode);
  else nudge = nudgeToDayOrTime(duration, destEpochNs, largestUnit, increment, smallestUnit, roundingMode);
  duration = nudge.duration;
  if (nudge.didExpand && smallestUnit !== 'week') {
    const startUnit = largerUnit(smallestUnit, 'day');
    duration = bubbleRelativeDuration(sign, duration, nudge.nudgedEpochNs, origin, tz, largestUnit, startUnit);
  }
  return duration;
};

// TotalRelativeDuration
const totalRelativeDuration = (duration, originEpochNs, destEpochNs, origin, tz, unit) => {
  if (isCalendarUnit(unit) || (tz !== undefined && unit === 'day')) {
    const sign = internalDurationSign(duration) < 0 ? -1 : 1;
    return nudgeToCalendarUnit(sign, duration, originEpochNs, destEpochNs, origin, tz, 1, unit, 'trunc').total;
  }
  return totalTimeDuration(duration.time + BigInt(duration.date.days) * NS_PER_DAY, unit);
};

// TotalTimeDuration: ns in units, as a Number (the division exact before rounding to a Number)
const totalTimeDuration = (ns, unit) => ratioToNumber(ns, NS_PER[unit]);

// DifferencePlainDateTimeWithRounding
const differencePlainDateTimeWithRounding = (one, two, largestUnit, increment, smallestUnit, roundingMode) => {
  if (compareISODateTime(one, two) === 0) return internalDuration(ZERO_DATE_DURATION, 0n);
  checkISODateTimeWithinLimits(one.date, one.time);
  checkISODateTimeWithinLimits(two.date, two.time);
  const diff = differenceISODateTime(one, two, largestUnit);
  if (smallestUnit === 'nanosecond' && increment === 1) return diff;
  return roundRelativeDuration(diff, utcEpochNs(one.date, one.time), utcEpochNs(two.date, two.time), one, undefined, largestUnit, increment, smallestUnit, roundingMode);
};

// DifferenceInstant
const differenceInstant = (ns1, ns2, increment, smallestUnit, roundingMode) =>
  internalDuration(ZERO_DATE_DURATION, roundTimeDuration(ns2 - ns1, increment, smallestUnit, roundingMode));

// DifferenceZonedDateTimeWithRounding
const differenceZonedDateTimeWithRounding = (ns1, ns2, tz, largestUnit, increment, smallestUnit, roundingMode) => {
  if (!isDateUnit(largestUnit)) return differenceInstant(ns1, ns2, increment, smallestUnit, roundingMode);
  const diff = differenceZonedDateTime(ns1, ns2, tz, largestUnit);
  if (smallestUnit === 'nanosecond' && increment === 1) return diff;
  const origin = isoDateTimeFor(tz, ns1);
  return roundRelativeDuration(diff, ns1, ns2, origin, tz, largestUnit, increment, smallestUnit, roundingMode);
};

// AddInstant
const addInstant = (epochNs, timeNs) => {
  const out = epochNs + timeNs;
  checkEpochNs(out);
  return out;
};

// AddZonedDateTime: the date part in local dates, then the time part exactly
const addZonedDateTime = (epochNs, tz, duration, overflow) => {
  if (dateDurationSign(duration.date) === 0) return addInstant(epochNs, duration.time);
  const dt = isoDateTimeFor(tz, epochNs);
  const addedDate = calendarDateAdd(dt.date, duration.date, overflow);
  checkISODateTimeWithinLimits(addedDate, dt.time);
  const intermediate = epochNsFor(tz, addedDate, dt.time, 'compatible');
  return addInstant(intermediate, duration.time);
};
