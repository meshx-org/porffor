//! `meshx:intl/locale`: tags canonicalized, likely subtags, week and text direction.

use icu::calendar::types::Weekday;
use icu::calendar::week::WeekInformation;
use icu::locale::extensions::unicode::{Key, Value};
use icu::locale::subtags::{Language, Region, Script};
use icu::locale::{Direction as IcuDirection, Locale, LocaleDirectionality, LocaleExpander};

use crate::exports::meshx::intl::locale::{
    Direction, Guest, LocaleOptions, Service, SupportedKey, WeekRules,
};
use crate::exports::meshx::intl::types::Error;
use crate::{default_locale, parse_locale, range, Provider};

/// Sets (or, for none, leaves) the Unicode extension keyword `key`.
fn set_keyword(locale: &mut Locale, key: &str, value: Option<String>) -> Result<(), Error> {
    let Some(value) = value else { return Ok(()) };
    let key = Key::try_from_str(key).map_err(|_| range(format!("Invalid key: {key}")))?;
    let value = Value::try_from_str(&value).map_err(|_| range(format!("Invalid value: {value}")))?;
    locale.extensions.unicode.keywords.set(key, value);
    Ok(())
}

/// ISO weekday number, 1 = Monday ... 7 = Sunday.
fn weekday_number(day: Weekday) -> u8 {
    match day {
        Weekday::Monday => 1,
        Weekday::Tuesday => 2,
        Weekday::Wednesday => 3,
        Weekday::Thursday => 4,
        Weekday::Friday => 5,
        Weekday::Saturday => 6,
        Weekday::Sunday => 7,
    }
}

const CALENDARS: &[&str] = &[
    "buddhist", "chinese", "coptic", "dangi", "ethioaa", "ethiopic", "gregory", "hebrew",
    "indian", "islamic-civil", "islamic-tbla", "islamic-umalqura", "iso8601", "japanese",
    "persian", "roc",
];
const COLLATIONS: &[&str] = &["compat", "emoji", "eor", "phonebk", "pinyin", "stroke", "trad", "unihan", "zhuyin"];
const CURRENCIES: &[&str] = &[
    "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS",
    "INR", "JPY", "KRW", "MXN", "NOK", "NZD", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "TWD",
    "USD", "ZAR",
];
const NUMBERING_SYSTEMS: &[&str] = &[
    "arab", "arabext", "beng", "deva", "fullwide", "gujr", "guru", "hanidec", "khmr", "knda",
    "laoo", "latn", "limb", "mlym", "mong", "mymr", "orya", "tamldec", "telu", "thai", "tibt",
];
const UNITS: &[&str] = &[
    "acre", "bit", "byte", "celsius", "centimeter", "day", "degree", "fahrenheit", "fluid-ounce",
    "foot", "gallon", "gigabit", "gigabyte", "gram", "hectare", "hour", "inch", "kilobit",
    "kilobyte", "kilogram", "kilometer", "liter", "megabit", "megabyte", "meter", "microsecond",
    "mile", "mile-scandinavian", "milliliter", "millimeter", "millisecond", "minute", "month",
    "nanosecond", "ounce", "percent", "petabyte", "pound", "second", "stone", "terabit",
    "terabyte", "week", "yard", "year",
];

impl Guest for Provider {
    fn default_locale() -> String {
        default_locale()
    }

    fn canonicalize(locales: Vec<String>) -> Result<Vec<String>, Error> {
        let mut out: Vec<String> = Vec::new();
        for tag in &locales {
            let canonical = parse_locale(tag)?.to_string();
            if !out.contains(&canonical) {
                out.push(canonical);
            }
        }
        Ok(out)
    }

    fn build(tag: String, options: LocaleOptions) -> Result<String, Error> {
        let mut locale = parse_locale(&tag)?;
        if let Some(language) = options.language {
            locale.id.language = Language::try_from_str(&language)
                .map_err(|_| range(format!("Invalid language: {language}")))?;
        }
        if let Some(script) = options.script {
            locale.id.script = Some(
                Script::try_from_str(&script).map_err(|_| range(format!("Invalid script: {script}")))?,
            );
        }
        if let Some(region) = options.region {
            locale.id.region = Some(
                Region::try_from_str(&region).map_err(|_| range(format!("Invalid region: {region}")))?,
            );
        }
        set_keyword(&mut locale, "ca", options.calendar)?;
        set_keyword(&mut locale, "co", options.collation)?;
        set_keyword(&mut locale, "hc", options.hour_cycle)?;
        set_keyword(&mut locale, "kf", options.case_first)?;
        set_keyword(&mut locale, "kn", options.numeric.map(|on| if on { "true" } else { "false" }.into()))?;
        set_keyword(&mut locale, "nu", options.numbering_system)?;
        Ok(parse_locale(&locale.to_string())?.to_string())
    }

    fn maximize(tag: String) -> Result<String, Error> {
        let mut locale = parse_locale(&tag)?;
        LocaleExpander::new_extended().maximize(&mut locale.id);
        Ok(locale.to_string())
    }

    fn minimize(tag: String) -> Result<String, Error> {
        let mut locale = parse_locale(&tag)?;
        LocaleExpander::new_extended().minimize(&mut locale.id);
        Ok(locale.to_string())
    }

    fn week_info(tag: String) -> Result<WeekRules, Error> {
        let locale = parse_locale(&tag)?;
        let week = WeekInformation::try_new((&locale).into()).map_err(|error| range(error.to_string()))?;
        let mut weekend: Vec<u8> = week.weekend().map(weekday_number).collect();
        weekend.sort_unstable();
        Ok(WeekRules { first_day: weekday_number(week.first_weekday), weekend })
    }

    fn text_direction(tag: String) -> Result<Direction, Error> {
        let locale = parse_locale(&tag)?;
        Ok(match LocaleDirectionality::new_common().get(&locale.id) {
            Some(IcuDirection::RightToLeft) => Direction::Rtl,
            _ => Direction::Ltr,
        })
    }

    fn supported_locales(_service: Service, locales: Vec<String>) -> Result<Vec<String>, Error> {
        // every locale has data here (falling back to its parent, then the root)
        Self::canonicalize(locales)
    }

    fn supported_values(key: SupportedKey) -> Vec<String> {
        let list: Vec<String> = match key {
            SupportedKey::Calendar => CALENDARS.iter().map(|s| (*s).into()).collect(),
            SupportedKey::Collation => COLLATIONS.iter().map(|s| (*s).into()).collect(),
            SupportedKey::Currency => CURRENCIES.iter().map(|s| (*s).into()).collect(),
            SupportedKey::NumberingSystem => NUMBERING_SYSTEMS.iter().map(|s| (*s).into()).collect(),
            SupportedKey::Unit => UNITS.iter().map(|s| (*s).into()).collect(),
            SupportedKey::TimeZone => crate::time_zone::names(),
        };
        list
    }
}
