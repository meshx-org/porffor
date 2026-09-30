//! `meshx:intl/number`: `Intl.NumberFormat` over ICU4X's decimal formatter, and the digit
//! rounding (ECMA-402's SetNumberFormatDigitOptions) that plural rules share.
//!
//! Decimal numbers, grouping, rounding and signs are ICU4X's, per locale. Percent, currency,
//! unit and compact notation wrap that number with the sign, symbol, unit or suffix, placed
//! as English and most European locales do: ICU4X's own formatters for those are still in
//! icu_experimental.

use fixed_decimal::{SignDisplay, SignedRoundingMode, UnsignedRoundingMode};
use icu::decimal::input::Decimal;
use icu::decimal::options::{DecimalFormatterOptions, GroupingStrategy};
use icu::decimal::DecimalFormatter;
use icu::locale::Locale;

use crate::exports::meshx::intl::number::{
    CompactDisplay, CurrencyDisplay, CurrencySign, Guest, GuestNumberFormat, NumberFormat,
    NumberOptions, NumberStyle, ResolvedNumberOptions, SignDisplay as WitSignDisplay, UnitDisplay,
    UseGrouping,
};
use crate::exports::meshx::intl::types::{
    Error, Notation, NumberValue, Part, RoundingMode, RoundingPriority, TrailingZeroDisplay,
};
use crate::parts::{parts, with_source};
use crate::{pick_locale, range, resolved_locale, Provider};

const MAX_FRACTION: u8 = 100;
const MAX_SIGNIFICANT: u8 = 21;

/// The digit options, resolved (SetNumberFormatDigitOptions): fraction digits or
/// significant digits (or both, with a priority), the rounding mode and increment.
#[derive(Clone, Copy)]
pub(crate) struct Digits {
    pub min_integer: u8,
    pub min_fraction: Option<u8>,
    pub max_fraction: Option<u8>,
    pub min_significant: Option<u8>,
    pub max_significant: Option<u8>,
    pub increment: u16,
    pub mode: RoundingMode,
    pub priority: RoundingPriority,
    pub trailing_zeros: TrailingZeroDisplay,
}

impl Digits {
    /// The options as ECMA-402 resolves them, with this style's default fraction digits.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn resolve(
        min_integer: Option<u8>,
        min_fraction: Option<u8>,
        max_fraction: Option<u8>,
        min_significant: Option<u8>,
        max_significant: Option<u8>,
        increment: Option<u16>,
        mode: Option<RoundingMode>,
        priority: Option<RoundingPriority>,
        trailing_zeros: Option<TrailingZeroDisplay>,
        default_min_fraction: u8,
        default_max_fraction: u8,
    ) -> Result<Digits, Error> {
        let min_integer = min_integer.unwrap_or(1);
        if !(1..=MAX_SIGNIFICANT).contains(&min_integer) {
            return Err(range("minimumIntegerDigits value is out of range."));
        }
        let priority = priority.unwrap_or(RoundingPriority::Auto);
        let has_significant = min_significant.is_some() || max_significant.is_some();
        let has_fraction = min_fraction.is_some() || max_fraction.is_some();
        let need_significant = !matches!(priority, RoundingPriority::Auto) || has_significant;
        let need_fraction = !matches!(priority, RoundingPriority::Auto) || !has_significant;

        let (mut min_sig, mut max_sig) = (None, None);
        if need_significant {
            let min = min_significant.unwrap_or(1);
            let max = max_significant.unwrap_or(MAX_SIGNIFICANT);
            if min < 1 || max > MAX_SIGNIFICANT || min > max {
                return Err(range("maximumSignificantDigits value is out of range."));
            }
            min_sig = Some(min);
            max_sig = Some(max);
        }
        let (mut min_frac, mut max_frac) = (None, None);
        if need_fraction {
            let (min, max) = if has_fraction {
                let max = max_fraction.map(|max| max.max(min_fraction.unwrap_or(0)));
                let min = min_fraction.unwrap_or_else(|| default_min_fraction.min(max.unwrap_or(u8::MAX)));
                let max = max.unwrap_or_else(|| default_max_fraction.max(min));
                (min, max)
            } else {
                (default_min_fraction, default_max_fraction)
            };
            if min > max || max > MAX_FRACTION {
                return Err(range("maximumFractionDigits value is out of range."));
            }
            min_frac = Some(min);
            max_frac = Some(max);
        }
        Ok(Digits {
            min_integer,
            min_fraction: min_frac,
            max_fraction: max_frac,
            min_significant: min_sig,
            max_significant: max_sig,
            increment: increment.unwrap_or(1),
            mode: mode.unwrap_or(RoundingMode::HalfExpand),
            priority,
            trailing_zeros: trailing_zeros.unwrap_or(TrailingZeroDisplay::Auto),
        })
    }

    /// `decimal` rounded as these options say, padded to the minimum digits.
    pub(crate) fn round(&self, decimal: &mut Decimal) {
        let mode = signed_mode(self.mode);
        let by_fraction = |d: &Decimal| -> Decimal {
            let mut d = d.clone();
            if let (Some(min), Some(max)) = (self.min_fraction, self.max_fraction) {
                d.round_with_mode(-(max as i16), mode);
                d.pad_end(-(min as i16));
            }
            d
        };
        let by_significant = |d: &Decimal| -> Decimal {
            let mut d = d.clone();
            if let (Some(min), Some(max)) = (self.min_significant, self.max_significant) {
                let top = if d.is_zero() { 0 } else { d.nonzero_magnitude_start() };
                d.round_with_mode(top - (max as i16 - 1), mode);
                let top = if d.is_zero() { 0 } else { d.nonzero_magnitude_start() };
                d.pad_end(top - (min as i16 - 1));
            }
            d
        };
        let fraction_step = |d: &Decimal| -(d.magnitude_range().start().min(&0).abs());
        *decimal = match (self.min_significant.is_some(), self.min_fraction.is_some(), self.priority) {
            (true, false, _) | (true, true, RoundingPriority::Auto) => by_significant(decimal),
            (false, _, _) => by_fraction(decimal),
            (true, true, priority) => {
                let (a, b) = (by_significant(decimal), by_fraction(decimal));
                // morePrecision keeps the one with more fraction digits, lessPrecision fewer
                let a_finer = fraction_step(&a) <= fraction_step(&b);
                if a_finer == matches!(priority, RoundingPriority::MorePrecision) { a } else { b }
            }
        };
        if matches!(self.trailing_zeros, TrailingZeroDisplay::StripIfInteger) {
            decimal.trim_end_if_integer();
        }
        decimal.pad_start(self.min_integer as i16);
    }
}

fn signed_mode(mode: RoundingMode) -> SignedRoundingMode {
    match mode {
        RoundingMode::Ceil => SignedRoundingMode::Ceil,
        RoundingMode::Floor => SignedRoundingMode::Floor,
        RoundingMode::Expand => SignedRoundingMode::Unsigned(UnsignedRoundingMode::Expand),
        RoundingMode::Trunc => SignedRoundingMode::Unsigned(UnsignedRoundingMode::Trunc),
        RoundingMode::HalfCeil => SignedRoundingMode::HalfCeil,
        RoundingMode::HalfFloor => SignedRoundingMode::HalfFloor,
        RoundingMode::HalfExpand => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfExpand),
        RoundingMode::HalfTrunc => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfTrunc),
        RoundingMode::HalfEven => SignedRoundingMode::Unsigned(UnsignedRoundingMode::HalfEven),
    }
}

/// A finite f64 as an exact decimal (its shortest round-tripping digits); none for NaN
/// and the infinities.
pub(crate) fn decimal_of_f64(n: f64) -> Option<Decimal> {
    if !n.is_finite() {
        return None;
    }
    Decimal::try_from_str(&format!("{n}")).ok()
}

/// The digits a currency has by default (ISO 4217's minor units).
fn currency_digits(code: &str) -> u8 {
    match code {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        _ => 2,
    }
}

/// A currency's symbol, where it has a well-known one; its code otherwise.
fn currency_symbol(code: &str, narrow: bool) -> String {
    match code {
        "USD" => "$".into(),
        "EUR" => "€".into(),
        "GBP" => "£".into(),
        "JPY" | "CNY" => "¥".into(),
        "INR" => "₹".into(),
        "KRW" => "₩".into(),
        "ILS" => "₪".into(),
        "VND" => "₫".into(),
        "CAD" if !narrow => "CA$".into(),
        "AUD" if !narrow => "A$".into(),
        "CAD" | "AUD" | "MXN" | "NZD" | "HKD" | "SGD" | "TWD" | "BRL" if narrow => "$".into(),
        _ => code.into(),
    }
}

/// A unit's short and long names (the long one for 1 and for other counts).
fn unit_names(unit: &str) -> (&str, &str, &str) {
    match unit {
        "kilometer" => ("km", "kilometer", "kilometers"),
        "meter" => ("m", "meter", "meters"),
        "centimeter" => ("cm", "centimeter", "centimeters"),
        "millimeter" => ("mm", "millimeter", "millimeters"),
        "mile" => ("mi", "mile", "miles"),
        "foot" => ("ft", "foot", "feet"),
        "inch" => ("in", "inch", "inches"),
        "kilogram" => ("kg", "kilogram", "kilograms"),
        "gram" => ("g", "gram", "grams"),
        "pound" => ("lb", "pound", "pounds"),
        "liter" => ("L", "liter", "liters"),
        "milliliter" => ("mL", "milliliter", "milliliters"),
        "byte" => ("byte", "byte", "bytes"),
        "kilobyte" => ("kB", "kilobyte", "kilobytes"),
        "megabyte" => ("MB", "megabyte", "megabytes"),
        "gigabyte" => ("GB", "gigabyte", "gigabytes"),
        "terabyte" => ("TB", "terabyte", "terabytes"),
        "millisecond" => ("ms", "millisecond", "milliseconds"),
        "second" => ("sec", "second", "seconds"),
        "minute" => ("min", "minute", "minutes"),
        "hour" => ("hr", "hour", "hours"),
        "day" => ("day", "day", "days"),
        "week" => ("wk", "week", "weeks"),
        "month" => ("mth", "month", "months"),
        "year" => ("yr", "year", "years"),
        "percent" => ("%", "percent", "percent"),
        "celsius" => ("°C", "degree Celsius", "degrees Celsius"),
        "fahrenheit" => ("°F", "degree Fahrenheit", "degrees Fahrenheit"),
        "kilometer-per-hour" => ("km/h", "kilometer per hour", "kilometers per hour"),
        "mile-per-hour" => ("mph", "mile per hour", "miles per hour"),
        _ => (unit, unit, unit),
    }
}

/// Whether this locale writes a currency symbol before the number.
fn symbol_first(locale: &Locale) -> bool {
    matches!(
        locale.id.language.as_str(),
        "en" | "ja" | "zh" | "ko" | "th" | "hi" | "ms" | "id" | "fil" | "he" | "ga" | "cy"
    )
}

impl Guest for Provider {
    type NumberFormat = NumberResource;
}

/// An `Intl.NumberFormat`.
pub struct NumberResource {
    formatter: DecimalFormatter,
    locale: Locale,
    style: NumberStyle,
    currency: Option<String>,
    currency_display: CurrencyDisplay,
    currency_sign: CurrencySign,
    unit: Option<String>,
    unit_display: UnitDisplay,
    notation: Notation,
    compact_display: CompactDisplay,
    use_grouping: UseGrouping,
    sign_display: WitSignDisplay,
    digits: Digits,
    /// compact notation's own rounding (no digit options given): 2 significant digits
    /// or no fraction digits, whichever is more precise
    compact_rounding: bool,
}

/// A run of formatted text: a part of the number or a piece around it.
fn part(kind: &str, value: impl Into<String>) -> Part {
    Part { kind: kind.into(), value: value.into(), source: None }
}

impl NumberResource {
    /// The value's parts: the rounded number, with its sign, symbol, unit or suffix.
    fn format_parts(&self, value: &NumberValue) -> Vec<Part> {
        let decimal = match value {
            NumberValue::Float(n) => decimal_of_f64(*n).ok_or(*n),
            NumberValue::Decimal(text) => Decimal::try_from_str(text.trim()).map_err(|_| match text.trim() {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => f64::NAN,
            }),
        };
        let mut decimal = match decimal {
            Ok(decimal) => decimal,
            Err(special) => {
                let text = if special.is_nan() { "NaN" } else { "∞" };
                let mut out = Vec::new();
                if special < 0.0 {
                    out.push(part("minusSign", "-"));
                }
                out.push(part(if special.is_nan() { "nan" } else { "infinity" }, text));
                return out;
            }
        };
        if matches!(self.style, NumberStyle::Percent) {
            decimal.multiply_pow10(2);
        }
        let mut suffix = None;
        if matches!(self.notation, Notation::Compact) {
            let top = if decimal.is_zero() { 0 } else { decimal.nonzero_magnitude_start() };
            let exponent = if top >= 3 { (top / 3 * 3).min(12) } else { 0 };
            if exponent > 0 {
                decimal.multiply_pow10(-exponent);
                let long = matches!(self.compact_display, CompactDisplay::Long);
                suffix = Some(match (exponent, long) {
                    (3, false) => "K",
                    (6, false) => "M",
                    (9, false) => "B",
                    (12, false) => "T",
                    (3, true) => " thousand",
                    (6, true) => " million",
                    (9, true) => " billion",
                    _ => " trillion",
                });
            }
        }
        if self.compact_rounding {
            let two = {
                let mut d = decimal.clone();
                let top = if d.is_zero() { 0 } else { d.nonzero_magnitude_start() };
                d.round_with_mode(top - 1, signed_mode(self.digits.mode));
                d.trim_end();
                d
            };
            let mut whole = decimal.clone();
            whole.round_with_mode(0, signed_mode(self.digits.mode));
            let two_step = two.magnitude_range().start().min(&0).abs();
            decimal = if two_step > 0 { two } else { whole };
        } else {
            self.digits.round(&mut decimal);
        }
        decimal.apply_sign_display(match self.sign_display {
            WitSignDisplay::Auto => SignDisplay::Auto,
            WitSignDisplay::Never => SignDisplay::Never,
            WitSignDisplay::Always => SignDisplay::Always,
            WitSignDisplay::ExceptZero => SignDisplay::ExceptZero,
            WitSignDisplay::Negative => SignDisplay::Negative,
        });
        let mut number = parts(&self.formatter.format(&decimal));
        // the sign stays in front of a symbol written before the number
        let sign = match number.first() {
            Some(first) if first.kind == "minusSign" || first.kind == "plusSign" => Some(number.remove(0)),
            _ => None,
        };
        let accounting = matches!(self.currency_sign, CurrencySign::Accounting)
            && sign.as_ref().is_some_and(|sign| sign.kind == "minusSign");
        let mut out = Vec::new();
        if accounting {
            out.push(part("literal", "("));
        } else if let Some(sign) = sign.clone() {
            out.push(sign);
        }
        let space = "\u{a0}";
        match self.style {
            NumberStyle::Currency => {
                let code = self.currency.clone().unwrap_or_default();
                let symbol = match self.currency_display {
                    CurrencyDisplay::Code => code.clone(),
                    CurrencyDisplay::Symbol => currency_symbol(&code, false),
                    CurrencyDisplay::NarrowSymbol => currency_symbol(&code, true),
                    CurrencyDisplay::Name => code.clone(),
                };
                let is_code = symbol.len() == 3 && symbol.bytes().all(|b| b.is_ascii_uppercase());
                if symbol_first(&self.locale) && !matches!(self.currency_display, CurrencyDisplay::Name) {
                    out.push(part("currency", symbol));
                    if is_code {
                        out.push(part("literal", space));
                    }
                    out.extend(number);
                } else {
                    out.extend(number);
                    out.push(part("literal", if matches!(self.currency_display, CurrencyDisplay::Name) { " " } else { space }));
                    out.push(part("currency", symbol));
                }
            }
            NumberStyle::Percent => {
                out.extend(number);
                if !symbol_first(&self.locale) {
                    out.push(part("literal", space));
                }
                out.push(part("percentSign", "%"));
            }
            _ => out.extend(number),
        }
        if let Some(suffix) = suffix {
            if let Some(word) = suffix.strip_prefix(' ') {
                out.push(part("literal", " "));
                out.push(part("compact", word));
            } else {
                out.push(part("compact", suffix));
            }
        }
        if let (NumberStyle::Unit, Some(unit)) = (self.style, self.unit.as_deref()) {
            let (short, one, other) = unit_names(unit);
            let is_one = !decimal.is_zero() && decimal.to_string().trim_start_matches(['-', '+']) == "1";
            match self.unit_display {
                UnitDisplay::Long => {
                    out.push(part("literal", " "));
                    out.push(part("unit", if is_one { one } else { other }));
                }
                UnitDisplay::Narrow if unit == "percent" || short.starts_with('°') => out.push(part("unit", short)),
                _ => {
                    out.push(part("literal", " "));
                    out.push(part("unit", short));
                }
            }
        }
        if accounting {
            out.push(part("literal", ")"));
        }
        out
    }

    fn format_text(&self, value: &NumberValue) -> String {
        self.format_parts(value).into_iter().map(|part| part.value).collect()
    }
}

impl NumberResource {
    /// The formatter for `locales` and `options` (the WIT resource's `create`).
    pub(crate) fn new(locales: Vec<String>, options: NumberOptions) -> Result<Self, Error> {
        let locale = pick_locale(&locales)?;
        let style = options.style.unwrap_or(NumberStyle::Decimal);
        let currency = match (&options.currency, style) {
            (Some(code), _) if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_alphabetic()) => {
                return Err(range(format!("Invalid currency code : {code}")));
            }
            (Some(code), _) => Some(code.to_ascii_uppercase()),
            (None, NumberStyle::Currency) => {
                return Err(Error::Invalid("Currency code is required with currency style.".into()));
            }
            (None, _) => None,
        };
        if matches!(style, NumberStyle::Unit) && options.unit.is_none() {
            return Err(Error::Invalid("Unit is required with unit style.".into()));
        }
        let notation = options.notation.unwrap_or(Notation::Standard);
        let (default_min, default_max) = match style {
            NumberStyle::Currency => {
                let digits = currency_digits(currency.as_deref().unwrap_or(""));
                (digits, digits)
            }
            NumberStyle::Percent => (0, 0),
            _ if matches!(notation, Notation::Compact) => (0, 0),
            _ => (0, 3),
        };
        let digits = Digits::resolve(
            options.minimum_integer_digits,
            options.minimum_fraction_digits,
            options.maximum_fraction_digits,
            options.minimum_significant_digits,
            options.maximum_significant_digits,
            options.rounding_increment,
            options.rounding_mode,
            options.rounding_priority,
            options.trailing_zero_display,
            default_min,
            default_max,
        )?;
        let compact_rounding = matches!(notation, Notation::Compact)
            && options.minimum_fraction_digits.is_none()
            && options.maximum_fraction_digits.is_none()
            && options.minimum_significant_digits.is_none()
            && options.maximum_significant_digits.is_none();
        let use_grouping = options.use_grouping.unwrap_or(if matches!(notation, Notation::Compact) {
            UseGrouping::Min2
        } else {
            UseGrouping::Auto
        });
        let mut icu_options = DecimalFormatterOptions::default();
        icu_options.grouping_strategy = Some(match use_grouping {
            UseGrouping::Always => GroupingStrategy::Always,
            UseGrouping::Auto => GroupingStrategy::Auto,
            UseGrouping::Min2 => GroupingStrategy::Min2,
            UseGrouping::Off => GroupingStrategy::Never,
        });
        let formatter =
            DecimalFormatter::try_new((&locale).into(), icu_options).map_err(|error| range(error.to_string()))?;
        Ok(NumberResource {
            formatter,
            locale,
            style,
            currency,
            currency_display: options.currency_display.unwrap_or(CurrencyDisplay::Symbol),
            currency_sign: options.currency_sign.unwrap_or(CurrencySign::Standard),
            unit: options.unit,
            unit_display: options.unit_display.unwrap_or(UnitDisplay::Short),
            notation,
            compact_display: options.compact_display.unwrap_or(CompactDisplay::Short),
            use_grouping,
            sign_display: options.sign_display.unwrap_or(WitSignDisplay::Auto),
            digits,
            compact_rounding,
        })
    }
}

impl GuestNumberFormat for NumberResource {
    fn create(locales: Vec<String>, options: NumberOptions) -> Result<NumberFormat, Error> {
        NumberResource::new(locales, options).map(NumberFormat::new)
    }

    fn format(&self, value: NumberValue) -> Result<String, Error> {
        Ok(self.format_text(&value))
    }

    fn format_to_parts(&self, value: NumberValue) -> Result<Vec<Part>, Error> {
        Ok(self.format_parts(&value))
    }

    fn format_range(&self, start: NumberValue, end: NumberValue) -> Result<String, Error> {
        Ok(format!("{}–{}", self.format_text(&start), self.format_text(&end)))
    }

    fn format_range_to_parts(&self, start: NumberValue, end: NumberValue) -> Result<Vec<Part>, Error> {
        let mut out = with_source(self.format_parts(&start), "startRange");
        out.push(Part { kind: "literal".into(), value: "–".into(), source: Some("shared".into()) });
        out.extend(with_source(self.format_parts(&end), "endRange"));
        Ok(out)
    }

    fn resolved_options(&self) -> ResolvedNumberOptions {
        let digits = self.digits;
        ResolvedNumberOptions {
            locale: resolved_locale(&self.locale),
            numbering_system: "latn".into(),
            options: NumberOptions {
                locale_matcher: None,
                numbering_system: None,
                style: Some(self.style),
                currency: self.currency.clone(),
                currency_display: self.currency.as_ref().map(|_| self.currency_display),
                currency_sign: self.currency.as_ref().map(|_| self.currency_sign),
                unit: self.unit.clone(),
                unit_display: self.unit.as_ref().map(|_| self.unit_display),
                minimum_integer_digits: Some(digits.min_integer),
                minimum_fraction_digits: digits.min_fraction,
                maximum_fraction_digits: digits.max_fraction,
                // compact rounding: two significant digits or none after the point,
                // whichever is more precise
                minimum_significant_digits: if self.compact_rounding { Some(1) } else { digits.min_significant },
                maximum_significant_digits: if self.compact_rounding { Some(2) } else { digits.max_significant },
                rounding_increment: Some(digits.increment),
                rounding_mode: Some(digits.mode),
                rounding_priority: Some(if self.compact_rounding { RoundingPriority::MorePrecision } else { digits.priority }),
                trailing_zero_display: Some(digits.trailing_zeros),
                notation: Some(self.notation),
                compact_display: matches!(self.notation, Notation::Compact).then_some(self.compact_display),
                use_grouping: Some(self.use_grouping),
                sign_display: Some(self.sign_display),
            },
        }
    }
}
