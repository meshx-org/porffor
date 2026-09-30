//! The C ABI of Porffor's native Intl: one call that takes a request as JSON and answers
//! as JSON, so the JavaScript side (runtime/host/native/intl) is `JSON.stringify`, one C
//! call and `JSON.parse`, and no C struct layout has to match anything.
//!
//! A request is `{"call": "<interface>.<function>", "args": [...]}`, or for a resource
//! `{"call": "<resource>.<method>", "self": <handle>, "args": [...]}`
//! (`date-time-format.create`, `collator.compare`), named and shaped as the WIT has it, in the
//! JavaScript spelling the component glue gives it: camelCase record fields, kebab-case
//! enum cases, `{tag, val}` variants, a missing field for none. The reply is `{"ok": value}`
//! or `{"err": {"tag": "range" | "invalid", "val": message}}`, the WIT `error`.
//!
//! A resource (a DateTimeFormat, NumberFormat, ...) lives in a table here; `create`
//! answers its handle, and `<resource>.drop` frees it.

use std::collections::HashMap;
use std::ffi::c_void;
use std::cell::RefCell;

use serde_json::{json, Map, Value};

use crate::date_time::DateTimeResource;
use crate::exports::meshx::intl::date_time::{self, GuestDateTimeFormat};
use crate::exports::meshx::intl::list::{self, GuestListFormat};
use crate::exports::meshx::intl::locale::{self, Guest as _};
use crate::exports::meshx::intl::number::{self, GuestNumberFormat};
use crate::exports::meshx::intl::plural::{self, GuestPluralRules};
use crate::exports::meshx::intl::text::{self, Guest as _, GuestCollator};
use crate::exports::meshx::intl::time_zone::Guest as _;
use crate::exports::meshx::intl::types::{self, Error, NumberValue};
use crate::list::ListResource;
use crate::number::NumberResource;
use crate::plural::PluralResource;
use crate::text::CollatorResource;
use crate::Provider;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

/// A value read from a request.
trait FromJson: Sized {
    fn from_json(value: &Value) -> Result<Self, Error>;
}

/// A value written into a reply.
trait ToJson {
    fn to_json(&self) -> Value;
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

impl FromJson for String {
    fn from_json(value: &Value) -> Result<Self, Error> {
        value.as_str().map(str::to_owned).ok_or_else(|| invalid("expected a string"))
    }
}

impl ToJson for String {
    fn to_json(&self) -> Value {
        Value::String(self.clone())
    }
}

impl FromJson for bool {
    fn from_json(value: &Value) -> Result<Self, Error> {
        value.as_bool().ok_or_else(|| invalid("expected a boolean"))
    }
}

impl ToJson for bool {
    fn to_json(&self) -> Value {
        Value::Bool(*self)
    }
}

/// JSON has no NaN or infinities: `JSON.stringify` writes them as null, read back as NaN
/// (an invalid date or a plural of nothing, which is what the implementations expect).
impl FromJson for f64 {
    fn from_json(value: &Value) -> Result<Self, Error> {
        match value {
            Value::Null => Ok(f64::NAN),
            _ => value.as_f64().ok_or_else(|| invalid("expected a number")),
        }
    }
}

macro_rules! json_integer {
    ($($ty:ty),*) => {$(
        impl FromJson for $ty {
            fn from_json(value: &Value) -> Result<Self, Error> {
                let n = value.as_f64().ok_or_else(|| invalid("expected a number"))?;
                if n.fract() != 0.0 || n < <$ty>::MIN as f64 || n > <$ty>::MAX as f64 {
                    return Err(crate::range(format!("{n} is out of range")));
                }
                Ok(n as $ty)
            }
        }

        impl ToJson for $ty {
            fn to_json(&self) -> Value {
                json!(*self)
            }
        }
    )*};
}

json_integer!(u8, u16, i8, i32, u32);

impl<T: FromJson> FromJson for Option<T> {
    fn from_json(value: &Value) -> Result<Self, Error> {
        match value {
            Value::Null => Ok(None),
            _ => T::from_json(value).map(Some),
        }
    }
}

impl<T: ToJson> ToJson for Option<T> {
    fn to_json(&self) -> Value {
        self.as_ref().map_or(Value::Null, ToJson::to_json)
    }
}

impl<T: FromJson> FromJson for Vec<T> {
    fn from_json(value: &Value) -> Result<Self, Error> {
        value.as_array().ok_or_else(|| invalid("expected a list"))?.iter().map(T::from_json).collect()
    }
}

impl<T: ToJson> ToJson for Vec<T> {
    fn to_json(&self) -> Value {
        Value::Array(self.iter().map(ToJson::to_json).collect())
    }
}

/// A Rust name as the glue spells it in JavaScript: a variant `ExceptZero` is the enum
/// case `except-zero`, a field `hour_cycle` is `hourCycle` (and `type_`, WIT's `%type`,
/// is `type`).
fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in name.trim_end_matches('_').chars() {
        if ch == '_' {
            upper = true;
        } else {
            out.push(if upper { ch.to_ascii_uppercase() } else { ch });
            upper = false;
        }
    }
    out
}

/// A WIT enum: its cases as strings.
macro_rules! json_enum {
    ($ty:path { $($case:ident),* $(,)? }) => {
        impl FromJson for $ty {
            fn from_json(value: &Value) -> Result<Self, Error> {
                let text = value.as_str().ok_or_else(|| invalid("expected an enum case"))?;
                $(if text == kebab(stringify!($case)) {
                    return Ok(<$ty>::$case);
                })*
                Err(crate::range(format!("Value {text} out of range")))
            }
        }

        impl ToJson for $ty {
            fn to_json(&self) -> Value {
                Value::String(match self {
                    $(<$ty>::$case => kebab(stringify!($case)),)*
                })
            }
        }
    };
}

/// A WIT record: an object, its fields camelCase, a field that is none left out.
macro_rules! json_record {
    ($ty:path { $($field:ident),* $(,)? }) => {
        impl FromJson for $ty {
            fn from_json(value: &Value) -> Result<Self, Error> {
                let object = value.as_object().ok_or_else(|| invalid("expected a record"))?;
                Ok(Self {
                    $($field: FromJson::from_json(object.get(&camel(stringify!($field))).unwrap_or(&Value::Null))?,)*
                })
            }
        }

        impl ToJson for $ty {
            fn to_json(&self) -> Value {
                let mut object = Map::new();
                $(
                    let value = self.$field.to_json();
                    if !value.is_null() {
                        object.insert(camel(stringify!($field)), value);
                    }
                )*
                Value::Object(object)
            }
        }
    };
}

json_enum!(types::LocaleMatcher { Lookup, BestFit });
json_enum!(types::Notation { Standard, Scientific, Engineering, Compact });
json_enum!(types::RoundingMode { Ceil, Floor, Expand, Trunc, HalfCeil, HalfFloor, HalfExpand, HalfTrunc, HalfEven });
json_enum!(types::RoundingPriority { Auto, MorePrecision, LessPrecision });
json_enum!(types::TrailingZeroDisplay { Auto, StripIfInteger });
json_enum!(locale::Service { Collator, DateTimeFormat, ListFormat, NumberFormat, PluralRules });
json_enum!(locale::SupportedKey { Calendar, Collation, Currency, NumberingSystem, TimeZone, Unit });
json_enum!(locale::Direction { Ltr, Rtl });
json_enum!(date_time::TextWidth { Narrow, Short, Long });
json_enum!(date_time::NumericWidth { Numeric, TwoDigit });
json_enum!(date_time::MonthWidth { Numeric, TwoDigit, Narrow, Short, Long });
json_enum!(date_time::HourCycle { H11, H12, H23, H24 });
json_enum!(date_time::TimeZoneName { Short, Long, ShortOffset, LongOffset, ShortGeneric, LongGeneric });
json_enum!(date_time::FormatMatcher { Basic, BestFit });
json_enum!(date_time::Style { Full, Long, Medium, Short });
json_enum!(number::NumberStyle { Decimal, Percent, Currency, Unit });
json_enum!(number::CurrencyDisplay { Code, Symbol, NarrowSymbol, Name });
json_enum!(number::CurrencySign { Standard, Accounting });
json_enum!(number::UnitDisplay { Short, Narrow, Long });
json_enum!(number::CompactDisplay { Short, Long });
json_enum!(number::UseGrouping { Always, Auto, Min2, Off });
json_enum!(number::SignDisplay { Auto, Never, Always, ExceptZero, Negative });
json_enum!(plural::PluralType { Cardinal, Ordinal });
json_enum!(plural::PluralCategory { Zero, One, Two, Few, Many, Other });
json_enum!(list::ListType { Conjunction, Disjunction, Unit });
json_enum!(list::ListStyle { Long, Short, Narrow });
json_enum!(text::NormalizationForm { Nfc, Nfd, Nfkc, Nfkd });
json_enum!(text::Usage { Sort, Search });
json_enum!(text::Sensitivity { Base, Accent, Case, Variant });
json_enum!(text::CaseFirst { Upper, Lower, False });

json_record!(types::Part { kind, value, source });
json_record!(locale::LocaleOptions {
    language, script, region, calendar, collation, hour_cycle, case_first, numeric, numbering_system,
});
json_record!(locale::WeekRules { first_day, weekend });
json_record!(date_time::DateTimeOptions {
    locale_matcher, calendar, numbering_system, hour12, hour_cycle, time_zone, weekday, era, year,
    month, day, day_period, hour, minute, second, fractional_second_digits, time_zone_name,
    format_matcher, date_style, time_style,
});
json_record!(date_time::ResolvedDateTimeOptions { locale, calendar, numbering_system, time_zone, options });
json_record!(number::NumberOptions {
    locale_matcher, numbering_system, style, currency, currency_display, currency_sign, unit,
    unit_display, minimum_integer_digits, minimum_fraction_digits, maximum_fraction_digits,
    minimum_significant_digits, maximum_significant_digits, rounding_increment, rounding_mode,
    rounding_priority, trailing_zero_display, notation, compact_display, use_grouping, sign_display,
});
json_record!(number::ResolvedNumberOptions { locale, numbering_system, options });
json_record!(plural::PluralOptions {
    locale_matcher, type_, notation, minimum_integer_digits, minimum_fraction_digits,
    maximum_fraction_digits, minimum_significant_digits, maximum_significant_digits,
    rounding_increment, rounding_mode, rounding_priority, trailing_zero_display,
});
json_record!(plural::ResolvedPluralOptions { locale, plural_categories, options });
json_record!(list::ListOptions { locale_matcher, type_, style });
json_record!(list::ResolvedListOptions { locale, type_, style });
json_record!(text::CollatorOptions {
    locale_matcher, usage, sensitivity, ignore_punctuation, numeric, case_first, collation,
});
json_record!(text::ResolvedCollatorOptions { locale, collation, options });

impl FromJson for NumberValue {
    fn from_json(value: &Value) -> Result<Self, Error> {
        let payload = value.get("val").unwrap_or(&Value::Null);
        match value.get("tag").and_then(Value::as_str) {
            Some("float") => f64::from_json(payload).map(NumberValue::Float),
            Some("decimal") => String::from_json(payload).map(NumberValue::Decimal),
            _ => Err(invalid("expected a number-value")),
        }
    }
}

impl ToJson for Error {
    fn to_json(&self) -> Value {
        match self {
            Error::Range(message) => json!({ "tag": "range", "val": message }),
            Error::Invalid(message) => json!({ "tag": "invalid", "val": message }),
        }
    }
}

/// A resource the JavaScript side holds a handle to (boxed: their sizes differ widely).
enum Resource {
    DateTime(Box<DateTimeResource>),
    Number(Box<NumberResource>),
    Plural(Box<PluralResource>),
    List(Box<ListResource>),
    Collator(Box<CollatorResource>),
}

/// The live resources, by handle. Porffor's program runs on one thread (ICU4X's
/// formatters are not `Send` either), so each thread has its own.
#[derive(Default)]
struct Table {
    next: u32,
    items: HashMap<u32, Resource>,
}

thread_local! {
    static TABLE: RefCell<Table> = RefCell::new(Table::default());
}

/// Runs `f` on the table.
fn with_table<R>(f: impl FnOnce(&mut Table) -> R) -> R {
    TABLE.with(|table| f(&mut table.borrow_mut()))
}

/// A new resource's handle.
fn insert(resource: Resource) -> Value {
    with_table(|table| {
        // 0 is no handle
        table.next += 1;
        let handle = table.next;
        table.items.insert(handle, resource);
        json!(handle)
    })
}

/// The request's `n`th argument.
fn arg<T: FromJson>(args: &[Value], n: usize) -> Result<T, Error> {
    T::from_json(args.get(n).unwrap_or(&Value::Null))
}

fn to_value<T: ToJson>(value: T) -> Result<Value, Error> {
    Ok(value.to_json())
}

/// One call on a resource: `$pattern` names the kind the handle must be.
macro_rules! on_resource {
    ($handle:expr, $pattern:ident, |$it:ident| $body:expr) => {
        with_table(|table| match table.items.get(&$handle) {
            Some(Resource::$pattern($it)) => $body,
            _ => Err(invalid("not a live handle of this kind")),
        })
    };
}

/// Answers one request.
fn dispatch(call: &str, handle: u32, args: &[Value]) -> Result<Value, Error> {
    match call {
        "locale.default-locale" => to_value(Provider::default_locale()),
        "locale.canonicalize" => to_value(<Provider as locale::Guest>::canonicalize(arg(args, 0)?)?),
        "locale.build" => to_value(Provider::build(arg(args, 0)?, arg(args, 1)?)?),
        "locale.maximize" => to_value(Provider::maximize(arg(args, 0)?)?),
        "locale.minimize" => to_value(Provider::minimize(arg(args, 0)?)?),
        "locale.week-info" => to_value(Provider::week_info(arg(args, 0)?)?),
        "locale.text-direction" => to_value(Provider::text_direction(arg(args, 0)?)?),
        "locale.supported-locales" => to_value(Provider::supported_locales(arg(args, 0)?, arg(args, 1)?)?),
        "locale.supported-values" => to_value(Provider::supported_values(arg(args, 0)?)),

        "time-zone.default-time-zone" => to_value(Provider::default_time_zone()),
        "time-zone.canonicalize" => {
            to_value(<Provider as crate::exports::meshx::intl::time_zone::Guest>::canonicalize(arg(args, 0)?))
        }
        "time-zone.offset-at" => to_value(Provider::offset_at(arg(args, 0)?, arg(args, 1)?)?),

        "text.normalize" => to_value(Provider::normalize(arg(args, 0)?, arg(args, 1)?)),
        "text.to-lower" => to_value(Provider::to_lower(arg(args, 0)?, arg(args, 1)?)?),
        "text.to-upper" => to_value(Provider::to_upper(arg(args, 0)?, arg(args, 1)?)?),

        "date-time-format.create" => Ok(insert(Resource::DateTime(Box::new(DateTimeResource::new(arg(args, 0)?, arg(args, 1)?)?)))),
        "date-time-format.format" => on_resource!(handle, DateTime, |it| to_value(it.format(arg(args, 0)?)?)),
        "date-time-format.format-to-parts" => {
            on_resource!(handle, DateTime, |it| to_value(it.format_to_parts(arg(args, 0)?)?))
        }
        "date-time-format.format-range" => {
            on_resource!(handle, DateTime, |it| to_value(it.format_range(arg(args, 0)?, arg(args, 1)?)?))
        }
        "date-time-format.format-range-to-parts" => on_resource!(handle, DateTime, |it| to_value(
            it.format_range_to_parts(arg(args, 0)?, arg(args, 1)?)?
        )),
        "date-time-format.resolved-options" => on_resource!(handle, DateTime, |it| to_value(it.resolved_options())),

        "number-format.create" => Ok(insert(Resource::Number(Box::new(NumberResource::new(arg(args, 0)?, arg(args, 1)?)?)))),
        "number-format.format" => on_resource!(handle, Number, |it| to_value(it.format(arg(args, 0)?)?)),
        "number-format.format-to-parts" => on_resource!(handle, Number, |it| to_value(it.format_to_parts(arg(args, 0)?)?)),
        "number-format.format-range" => {
            on_resource!(handle, Number, |it| to_value(it.format_range(arg(args, 0)?, arg(args, 1)?)?))
        }
        "number-format.format-range-to-parts" => on_resource!(handle, Number, |it| to_value(
            it.format_range_to_parts(arg(args, 0)?, arg(args, 1)?)?
        )),
        "number-format.resolved-options" => on_resource!(handle, Number, |it| to_value(it.resolved_options())),

        "plural-rules.create" => Ok(insert(Resource::Plural(Box::new(PluralResource::new(arg(args, 0)?, arg(args, 1)?)?)))),
        "plural-rules.select" => on_resource!(handle, Plural, |it| to_value(it.select(arg(args, 0)?))),
        "plural-rules.select-range" => {
            on_resource!(handle, Plural, |it| to_value(it.select_range(arg(args, 0)?, arg(args, 1)?)?))
        }
        "plural-rules.resolved-options" => on_resource!(handle, Plural, |it| to_value(it.resolved_options())),

        "list-format.create" => Ok(insert(Resource::List(Box::new(ListResource::new(arg(args, 0)?, arg(args, 1)?)?)))),
        "list-format.format" => on_resource!(handle, List, |it| to_value(it.format(arg(args, 0)?))),
        "list-format.format-to-parts" => on_resource!(handle, List, |it| to_value(it.format_to_parts(arg(args, 0)?))),
        "list-format.resolved-options" => on_resource!(handle, List, |it| to_value(it.resolved_options())),

        "collator.create" => Ok(insert(Resource::Collator(Box::new(CollatorResource::new(arg(args, 0)?, arg(args, 1)?)?)))),
        "collator.compare" => {
            on_resource!(handle, Collator, |it| to_value(it.compare(arg(args, 0)?, arg(args, 1)?)))
        }
        "collator.resolved-options" => on_resource!(handle, Collator, |it| to_value(it.resolved_options())),

        "date-time-format.drop" | "number-format.drop" | "plural-rules.drop" | "list-format.drop" | "collator.drop" => {
            with_table(|table| table.items.remove(&handle));
            Ok(Value::Null)
        }
        _ => Err(invalid(format!("meshx:intl has no {call}"))),
    }
}

/// A request's reply, as JSON text.
fn answer(request: &[u8]) -> String {
    let reply = match serde_json::from_slice::<Value>(request) {
        Ok(request) => {
            let call = request.get("call").and_then(Value::as_str).unwrap_or("");
            let handle = request.get("self").and_then(Value::as_u64).unwrap_or(0) as u32;
            let args = request.get("args").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            dispatch(call, handle, args)
        }
        Err(error) => Err(invalid(format!("meshx:intl: a request that is not JSON: {error}"))),
    };
    match reply {
        Ok(value) => json!({ "ok": value }).to_string(),
        Err(error) => json!({ "err": error.to_json() }).to_string(),
    }
}

/// Answers `request` (`len` bytes of UTF-8 JSON, not NUL-terminated) with a reply of JSON
/// in a buffer from `malloc` (NUL-terminated, its length without the NUL in `*reply_len`),
/// which the caller frees with `free` or [`porf_intl_free`]. Null only when out of memory.
///
/// # Safety
///
/// `request` points to `len` readable bytes, and `reply_len` to a writable `size_t`.
#[no_mangle]
pub unsafe extern "C" fn porf_intl_call(request: *const u8, len: usize, reply_len: *mut usize) -> *mut u8 {
    let request = if len == 0 { &[][..] } else { std::slice::from_raw_parts(request, len) };
    let reply = answer(request);
    let out = malloc(reply.len() + 1).cast::<u8>();
    if out.is_null() {
        return out;
    }
    std::ptr::copy_nonoverlapping(reply.as_ptr(), out, reply.len());
    *out.add(reply.len()) = 0;
    *reply_len = reply.len();
    out
}

/// Frees a reply of [`porf_intl_call`].
///
/// # Safety
///
/// `reply` is null or a reply not yet freed.
#[no_mangle]
pub unsafe extern "C" fn porf_intl_free(reply: *mut u8) {
    free(reply.cast());
}

#[cfg(test)]
mod tests {
    use super::answer;

    fn call(request: &str) -> String {
        answer(request.as_bytes())
    }

    #[test]
    fn formats_through_json() {
        assert_eq!(call(r#"{"call":"locale.maximize","args":["zh-TW"]}"#), r#"{"ok":"zh-Hant-TW"}"#);
        assert_eq!(
            call(r#"{"call":"number-format.create","args":[["de-DE"],{"style":"currency","currency":"EUR"}]}"#),
            r#"{"ok":1}"#
        );
        assert_eq!(
            call(r#"{"call":"number-format.format","self":1,"args":[{"tag":"float","val":1234.5}]}"#),
            "{\"ok\":\"1.234,50\u{a0}€\"}"
        );
        assert!(call(r#"{"call":"number-format.create","args":[["en"],{"style":"currency"}]}"#)
            .starts_with(r#"{"err":{"tag":"invalid""#));
        assert!(call(r#"{"call":"locale.maximize","args":["!!"]}"#).starts_with(r#"{"err":{"tag":"range""#));
    }
}
