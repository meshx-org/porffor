// ---- the ISO 8601 calendar and the time of day ----

const NS_PER_DAY = 86400000000000n;
const NS_MAX_INSTANT = 8640000000000000000000n;
const NS_MIN_INSTANT = -8640000000000000000000n;

// floor division and modulo for BigInts
const floorDiv = (a, b) => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};
const floorMod = (a, b) => a - floorDiv(a, b) * b;
const numberFloorDiv = (a, b) => Math.floor(a / b);
const numberMod = (a, b) => ((a % b) + b) % b;

const isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInYear = year => isLeapYear(year) ? 366 : 365;
const daysInMonth = (year, month) => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

// days since 1970-01-01 of a date, and back (exact over Temporal's range as Numbers)
const epochDays = (year, month, day) => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};
const dateFromEpochDays = days => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
};

const isoDate = (year, month, day) => ({ year, month, day });

// BalanceISODate: any year, month and day made a real date
const balanceISODate = (year, month, day) => {
  const m0 = month - 1;
  const y = year + Math.floor(m0 / 12);
  const m = numberMod(m0, 12) + 1;
  return dateFromEpochDays(epochDays(y, m, 1) + day - 1);
};

const addDaysToISODate = (date, days) => dateFromEpochDays(epochDays(date.year, date.month, date.day) + days);

const isValidISODate = (year, month, day) =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

// RegulateISODate: an out-of-range month or day clamped ('constrain') or refused ('reject')
const regulateISODate = (year, month, day, overflow) => {
  if (overflow === 'constrain') {
    const m = month < 1 ? 1 : month > 12 ? 12 : month;
    const dim = daysInMonth(year, m);
    return isoDate(year, m, day < 1 ? 1 : day > dim ? dim : day);
  }
  if (!isValidISODate(year, month, day)) rangeError('Invalid ISO date');
  return isoDate(year, month, day);
};

const compareNumbers = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareISODate = (a, b) =>
  compareNumbers(a.year, b.year) || compareNumbers(a.month, b.month) || compareNumbers(a.day, b.day);

// 1 (Monday) to 7 (Sunday)
const dayOfWeek = date => numberMod(epochDays(date.year, date.month, date.day) + 3, 7) + 1;
const dayOfYear = date => epochDays(date.year, date.month, date.day) - epochDays(date.year, 1, 1) + 1;

// the ISO week of a date and the year it belongs to
const weekOfYear = date => {
  const doy = dayOfYear(date);
  const dow = dayOfWeek(date);
  let week = Math.floor((doy - dow + 10) / 7);
  let year = date.year;
  if (week < 1) {
    year--;
    const prevDec31 = isoDate(year, 12, 31);
    week = Math.floor((dayOfYear(prevDec31) - dayOfWeek(prevDec31) + 10) / 7);
  } else if (week === 53) {
    const dec31 = isoDate(year, 12, 31);
    if (dayOfWeek(dec31) < 4) {
      week = 1;
      year++;
    }
  }
  return { week, year };
};

// ---- the time of day ----

const timeRecord = (hour, minute, second, millisecond, microsecond, nanosecond) =>
  ({ hour, minute, second, millisecond, microsecond, nanosecond });
const MIDNIGHT = timeRecord(0, 0, 0, 0, 0, 0);
const NOON = timeRecord(12, 0, 0, 0, 0, 0);

const isValidTime = (h, mi, s, ms, us, ns) =>
  h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59 &&
  ms >= 0 && ms <= 999 && us >= 0 && us <= 999 && ns >= 0 && ns <= 999;

// RegulateTime
const regulateTime = (h, mi, s, ms, us, ns, overflow) => {
  if (overflow === 'constrain') {
    const clamp = (v, max) => v < 0 ? 0 : v > max ? max : v;
    return timeRecord(clamp(h, 23), clamp(mi, 59), clamp(s, 59), clamp(ms, 999), clamp(us, 999), clamp(ns, 999));
  }
  if (!isValidTime(h, mi, s, ms, us, ns)) rangeError('Invalid time');
  return timeRecord(h, mi, s, ms, us, ns);
};

// a time of day as nanoseconds since midnight, and back (0 <= ns < a day)
const timeToNs = t =>
  ((((BigInt(t.hour) * 60n + BigInt(t.minute)) * 60n + BigInt(t.second)) * 1000n + BigInt(t.millisecond)) * 1000n +
    BigInt(t.microsecond)) * 1000n + BigInt(t.nanosecond);
const timeFromNs = ns => {
  const n = Number(ns);
  const nanosecond = n % 1000;
  const us = Math.floor(n / 1000);
  const microsecond = us % 1000;
  const ms = Math.floor(us / 1000);
  const millisecond = ms % 1000;
  const s = Math.floor(ms / 1000);
  return timeRecord(Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, millisecond, microsecond, nanosecond);
};

// BalanceTime: any time fields (Numbers) as whole days and a time of day
const balanceTimeNs = total => ({ days: Number(floorDiv(total, NS_PER_DAY)), time: timeFromNs(floorMod(total, NS_PER_DAY)) });
const balanceTime = (h, mi, s, ms, us, ns) => balanceTimeNs(
  BigInt(h) * NS_PER.hour + BigInt(mi) * NS_PER.minute + BigInt(s) * NS_PER.second +
  BigInt(ms) * NS_PER.millisecond + BigInt(us) * NS_PER.microsecond + BigInt(ns));

const compareTimeRecord = (a, b) => {
  const x = timeToNs(a), y = timeToNs(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

// AddTime: a time and a time duration (BigInt ns): days carried and the time
const addTime = (time, durationNs) => balanceTimeNs(timeToNs(time) + durationNs);

// RoundTime: to a multiple of increment units (a day rounds the whole time)
const roundTime = (time, increment, unit, mode) =>
  balanceTimeNs(roundBigIntToIncrement(timeToNs(time), BigInt(increment) * NS_PER[unit], mode));

// ---- dates with times ----

const isoDateTime = (date, time) => ({ date, time });

// GetUTCEpochNanoseconds: the date-time read as UTC
const utcEpochNs = (date, time) => BigInt(epochDays(date.year, date.month, date.day)) * NS_PER_DAY + timeToNs(time);

// the date-time an epoch nanosecond count is in UTC (plus an offset, in ns)
const isoDateTimeFromEpochNs = (ns, offsetNs = 0n) => {
  const local = ns + offsetNs;
  return isoDateTime(dateFromEpochDays(Number(floorDiv(local, NS_PER_DAY))), timeFromNs(floorMod(local, NS_PER_DAY)));
};

const compareISODateTime = (a, b) => compareISODate(a.date, b.date) || compareTimeRecord(a.time, b.time);

// ISODateTimeWithinLimits: within a day of the instants' range
const isoDateTimeWithinLimits = (date, time) => {
  if (Math.abs(date.year) > 300000) return false;
  const ns = utcEpochNs(date, time);
  return ns > NS_MIN_INSTANT - NS_PER_DAY && ns < NS_MAX_INSTANT + NS_PER_DAY;
};
const isoDateWithinLimits = date => isoDateTimeWithinLimits(date, NOON);
const checkISODateTimeWithinLimits = (date, time) => {
  if (!isoDateTimeWithinLimits(date, time)) rangeError('Date-time outside the representable range');
};
const checkISODateWithinLimits = date => {
  if (!isoDateWithinLimits(date)) rangeError('Date outside the representable range');
};

// ISOYearMonthWithinLimits: -271821-04 to +275760-09
const isoYearMonthWithinLimits = (year, month) => {
  if (year < -271821 || year > 275760) return false;
  if (year === -271821 && month < 4) return false;
  if (year === 275760 && month > 9) return false;
  return true;
};

// CheckISODaysRange: within 100,000,000 days of the epoch
const checkISODaysRange = date => {
  if (Math.abs(epochDays(date.year, date.month, date.day)) > 100000000) rangeError('Date outside the representable range');
};

// an exact ratio (BigInts, denominator > 0) as the nearest Number
const bitLength = x => x === 0n ? 0 : x.toString(2).length;
const ratioToNumber = (numerator, denominator) => {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n;
  const p = negative ? -numerator : numerator;
  // enough quotient bits that rounding it once is rounding the ratio (a remainder is a sticky bit)
  const shift = Math.max(0, 66 + bitLength(denominator) - bitLength(p));
  const scaled = p << BigInt(shift);
  let q = scaled / denominator;
  if (scaled % denominator !== 0n) q |= 1n;
  const out = Number(q) / 2 ** shift;
  return negative ? -out : out;
};

const isValidEpochNs = ns => ns >= NS_MIN_INSTANT && ns <= NS_MAX_INSTANT;
const checkEpochNs = ns => {
  if (!isValidEpochNs(ns)) rangeError('Instant outside the representable range');
};
