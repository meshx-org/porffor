// Temporal, as the spec's abstract operations: this file and the ones after it (in name order)
// are one script, joined by build.js into ../temporal.js, which codegen puts in front of a
// program that names Temporal. Everything lives in one function, so none of its names reach
// the program; it gives back the Temporal namespace.
//
// The ISO 8601 calendar only, and the time zones this runtime knows: UTC, fixed offsets and
// the host's own zone (__Porffor_tz_offsetMs / __Porffor_tz_id). Epoch nanoseconds and time
// durations are BigInts, as the spec's mathematical values.
var Temporal = (() => {

// ---- errors and conversions ----

const rangeError = message => { throw new RangeError(message); };
const typeError = message => { throw new TypeError(message); };

// (not Number.isFinite, which a program can replace)
const isFiniteNumber = v => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;

const isObject = value => (typeof value === 'object' && value !== null) || typeof value === 'function';

// ToString, which throws for a Symbol
const toStr = value => {
  if (typeof value === 'symbol') typeError('Cannot convert a Symbol to a string');
  return `${value}`;
};

// ToPrimitive with hint string (Symbol.toPrimitive, then toString, then valueOf)
const toPrimitiveString = value => {
  if (!isObject(value)) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') typeError('Symbol.toPrimitive is not callable');
    const out = exotic.call(value, 'string');
    if (isObject(out)) typeError('Cannot convert object to primitive value');
    return out;
  }
  for (let _j = 0, _l = [ 'toString', 'valueOf' ]; _j < _l.length; _j++) { const name = _l[_j];
    const method = value[name];
    if (typeof method === 'function') {
      const out = method.call(value);
      if (!isObject(out)) return out;
    }
  }
  return typeError('Cannot convert object to primitive value');
};

// ToNumber (a BigInt or a Symbol throws)
const toNum = value => {
  if (typeof value === 'bigint') typeError('Cannot convert a BigInt to a number');
  if (typeof value === 'symbol') typeError('Cannot convert a Symbol to a number');
  return +value;
};

// ToIntegerWithTruncation: a finite number, truncated (-0 is 0)
const toIntegerWithTruncation = value => {
  const n = toNum(value);
  if (!isFiniteNumber(n)) rangeError('Infinity or NaN is not an integer');
  const t = Math.trunc(n);
  return t === 0 ? 0 : t;
};

// ToIntegerIfIntegral: a finite number that has no fraction
const toIntegerIfIntegral = value => {
  const n = toNum(value);
  if (!isFiniteNumber(n)) rangeError('Infinity or NaN is not an integer');
  if (Math.trunc(n) !== n) rangeError(`${n} is not an integer`);
  return n === 0 ? 0 : n;
};

// ToPositiveIntegerWithTruncation
const toPositiveIntegerWithTruncation = value => {
  const n = toIntegerWithTruncation(value);
  if (n <= 0) rangeError(`${n} is not positive`);
  return n;
};

// the value a string-valued property must be: ToPrimitive, then a String
const requireString = value => {
  if (typeof value !== 'string') typeError(`${typeof value === 'symbol' ? 'a Symbol' : toStr(value)} is not a string`);
  return value;
};

const padNumber = (n, width) => `${n}`.padStart(width, '0');

// ---- options ----

// GetOptionsObject
const getOptionsObject = options => {
  if (options === undefined) return Object.create(null);
  if (isObject(options)) return options;
  return typeError('options must be an object or undefined');
};

// GetOption with type string: undefined gives the fallback; else ToString, one of the values
const getStringOption = (options, name, values, fallback) => {
  const value = options[name];
  if (value === undefined) return fallback;
  const s = toStr(value);
  if (values !== undefined && !values.includes(s)) rangeError(`${s} is not a valid value for ${name}`);
  return s;
};

const getOverflowOption = options => getStringOption(options, 'overflow', [ 'constrain', 'reject' ], 'constrain');
const getDisambiguationOption = options => getStringOption(options, 'disambiguation', [ 'compatible', 'earlier', 'later', 'reject' ], 'compatible');
const getOffsetOption = (options, fallback) => getStringOption(options, 'offset', [ 'prefer', 'use', 'ignore', 'reject' ], fallback);
const getShowCalendarNameOption = options => getStringOption(options, 'calendarName', [ 'auto', 'always', 'never', 'critical' ], 'auto');
const getShowTimeZoneNameOption = options => getStringOption(options, 'timeZoneName', [ 'auto', 'never', 'critical' ], 'auto');
const getShowOffsetOption = options => getStringOption(options, 'offset', [ 'auto', 'never' ], 'auto');
const getDirectionOption = options => getStringOption(options, 'direction', [ 'next', 'previous' ], undefined);

const ROUNDING_MODES = [ 'ceil', 'floor', 'expand', 'trunc', 'halfCeil', 'halfFloor', 'halfExpand', 'halfTrunc', 'halfEven' ];
const getRoundingModeOption = (options, fallback) => getStringOption(options, 'roundingMode', ROUNDING_MODES, fallback);

// GetRoundingIncrementOption: an integer from 1 to 1e9
const getRoundingIncrementOption = options => {
  const value = options.roundingIncrement;
  if (value === undefined) return 1;
  const n = toIntegerWithTruncation(value);
  if (n < 1 || n > 1e9) rangeError(`roundingIncrement ${n} is out of range`);
  return n;
};

// GetTemporalFractionalSecondDigitsOption: 'auto' or an integer 0 to 9
const getFractionalSecondDigitsOption = options => {
  const value = options.fractionalSecondDigits;
  if (value === undefined) return 'auto';
  if (typeof value !== 'number') {
    if (toStr(value) !== 'auto') rangeError(`${value} is not a valid value for fractionalSecondDigits`);
    return 'auto';
  }
  if (!isFiniteNumber(value)) rangeError('fractionalSecondDigits must be finite');
  const digits = Math.floor(value);
  if (digits < 0 || digits > 9) rangeError(`fractionalSecondDigits ${digits} is out of range`);
  return digits;
};

// ---- units ----

const UNITS = [ 'year', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond' ];
const PLURAL_UNITS = UNITS.map(unit => unit + 's');
const DATE_UNITS = [ 'year', 'month', 'week', 'day' ];
const TIME_UNITS = [ 'hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond' ];

// a unit's place, larger first (year 0 .. nanosecond 9)
const unitIndex = unit => UNITS.indexOf(unit);
const largerUnit = (a, b) => unitIndex(a) <= unitIndex(b) ? a : b;
const isCalendarUnit = unit => unit === 'year' || unit === 'month' || unit === 'week';
const isDateUnit = unit => DATE_UNITS.includes(unit);

// the length of a time unit (a day is 24 hours here), in nanoseconds
const NS_PER = {
  day: 86400000000000n,
  hour: 3600000000000n,
  minute: 60000000000n,
  second: 1000000000n,
  millisecond: 1000000n,
  microsecond: 1000n,
  nanosecond: 1n
};

// GetTemporalUnitValuedOption: a unit (singular or plural, given singular), 'auto', or the
// fallback when the option is absent; which units are allowed is ValidateTemporalUnitValue's
const getUnitOption = (options, name, fallback) => {
  const value = options[name];
  if (value === undefined) return fallback;
  const s = toStr(value);
  if (s === 'auto') return 'auto';
  const plural = PLURAL_UNITS.indexOf(s);
  if (plural >= 0) return UNITS[plural];
  if (UNITS.includes(s)) return s;
  return rangeError(`${s} is not a valid value for ${name}`);
};

// ValidateTemporalUnitValue: a unit of the group ('date', 'time', 'datetime'), 'auto' where
// allowed, or absent (undefined)
const validateUnit = (value, group, extra = []) => {
  if (value === undefined) return;
  if (extra.includes(value)) return;
  if (value === 'auto') rangeError('auto is not allowed here');
  if (group === 'date' && !isDateUnit(value)) rangeError(`${value} is not a date unit`);
  if (group === 'time' && isDateUnit(value)) rangeError(`${value} is not a time unit`);
};

// ---- rounding ----

// GetUnsignedRoundingMode: how a mode rounds a magnitude, given the value's sign
const unsignedRoundingMode = (mode, negative) => {
  switch (mode) {
    case 'ceil': return negative ? 'zero' : 'infinity';
    case 'floor': return negative ? 'infinity' : 'zero';
    case 'expand': return 'infinity';
    case 'trunc': return 'zero';
    case 'halfCeil': return negative ? 'half-zero' : 'half-infinity';
    case 'halfFloor': return negative ? 'half-infinity' : 'half-zero';
    case 'halfExpand': return 'half-infinity';
    case 'halfTrunc': return 'half-zero';
    case 'halfEven': return 'half-even';
  }
};

const bigAbs = x => x < 0n ? -x : x;
const bigSign = x => x < 0n ? -1 : x > 0n ? 1 : 0;

// RoundNumberToIncrement over BigInts: x rounded to a multiple of increment (> 0)
const roundBigIntToIncrement = (x, increment, mode) => {
  const negative = x < 0n;
  const magnitude = bigAbs(x);
  const quotient = magnitude / increment;
  const remainder = magnitude % increment;
  let r1 = quotient;
  if (remainder !== 0n) {
    const umode = unsignedRoundingMode(mode, negative);
    const doubled = remainder * 2n;
    let up;
    if (umode === 'zero') up = false;
    else if (umode === 'infinity') up = true;
    else if (doubled < increment) up = false;
    else if (doubled > increment) up = true;
    else if (umode === 'half-zero') up = false;
    else if (umode === 'half-infinity') up = true;
    else up = quotient % 2n === 1n;
    if (up) r1 = quotient + 1n;
  }
  const out = r1 * increment;
  return negative ? -out : out;
};

// RoundNumberToIncrement over Numbers that are exact (integers, or a fraction given as
// numerator / denominator BigInts): used where a total is a ratio
const roundRatioToIncrement = (numerator, denominator, increment, mode) => {
  // numerator / denominator rounded to a multiple of increment (all BigInts, denominator > 0)
  const scaled = increment * denominator;
  const negative = numerator < 0n;
  const magnitude = bigAbs(numerator);
  const quotient = magnitude / scaled;
  const remainder = magnitude % scaled;
  let r1 = quotient;
  if (remainder !== 0n) {
    const umode = unsignedRoundingMode(mode, negative);
    const doubled = remainder * 2n;
    let up;
    if (umode === 'zero') up = false;
    else if (umode === 'infinity') up = true;
    else if (doubled < scaled) up = false;
    else if (doubled > scaled) up = true;
    else if (umode === 'half-zero') up = false;
    else if (umode === 'half-infinity') up = true;
    else up = quotient % 2n === 1n;
    if (up) r1 = quotient + 1n;
  }
  const out = r1 * increment;
  return negative ? -out : out;
};

// ValidateTemporalRoundingIncrement: the increment divides dividend (and is below it, unless
// inclusive)
const validateRoundingIncrement = (increment, dividend, inclusive) => {
  const maximum = inclusive ? dividend : dividend - 1;
  if (increment > maximum) rangeError(`roundingIncrement ${increment} is out of range`);
  if (dividend % increment !== 0) rangeError(`roundingIncrement ${increment} does not divide ${dividend}`);
};

// MaximumTemporalDurationRoundingIncrement: the dividend a unit's increment must divide
const maximumRoundingIncrement = unit => {
  switch (unit) {
    case 'year': case 'month': case 'week': case 'day': return undefined;
    case 'hour': return 24;
    case 'minute': case 'second': return 60;
    default: return 1000;
  }
};
