//! `meshx:intl/date-time`: `Intl.DateTimeFormat`. jiff turns the instant into wall time
//! and an offset in the time zone (its IANA database); ICU4X formats that, with a field
//! set built from the ECMA-402 options (dateStyle/timeStyle, or the components asked for).
//!
//! ICU4X chooses its patterns from field sets and lengths, not from one width per field,
//! so a component list maps onto the nearest field set: the fields asked for, at the
//! length the month's width implies. Ranges are the two dates around an en dash.

use icu::calendar::{Date, Iso};
use icu::datetime::fieldsets::builder::{DateFields, FieldSetBuilder, ZoneStyle};
use icu::datetime::fieldsets::enums::CompositeFieldSet;
use icu::datetime::options::{Alignment, Length, SubsecondDigits, TimePrecision, YearStyle};
use icu::datetime::preferences::HourCycle;
use icu::datetime::{DateTimeFormatter, DateTimeFormatterPreferences};
use icu::time::zone::{IanaParser, UtcOffset, ZoneNameTimestamp};
use icu::time::{Time, TimeZoneInfo, ZonedDateTime};
use jiff::tz::TimeZone;

use crate::exports::meshx::intl::date_time::{
    DateTimeFormat, DateTimeOptions, Guest, GuestDateTimeFormat, HourCycle as WitHourCycle,
    MonthWidth, NumericWidth, ResolvedDateTimeOptions, Style, TextWidth, TimeZoneName,
};
use crate::exports::meshx::intl::types::{Error, Part};
use crate::parts::{parts, with_source};
use crate::time_zone::{canonical, default_time_zone, timestamp, zone};
use crate::{pick_locale, range, resolved_locale, Provider};

impl Guest for Provider {
    type DateTimeFormat = DateTimeResource;
}

/// An `Intl.DateTimeFormat`.
pub struct DateTimeResource {
    formatter: DateTimeFormatter<CompositeFieldSet>,
    zone: TimeZone,
    zone_id: String,
    locale: String,
    /// the options as resolved: the components (or styles) in effect, the hour cycle
    options: DateTimeOptions,
}

/// CLDR's narrow no-break space (before AM/PM, in ranges) as a plain space: what browsers
/// and Node give, since pages parse dates that CLDR 42 changed to it.
fn web_spaces(text: String) -> String {
    if text.contains('\u{202f}') { text.replace('\u{202f}', " ") } else { text }
}

/// ICU4X's length for a style.
fn style_length(style: Style) -> Length {
    match style {
        Style::Full | Style::Long => Length::Long,
        Style::Medium => Length::Medium,
        Style::Short => Length::Short,
    }
}

/// The field set the options ask for.
fn field_set(options: &DateTimeOptions) -> Result<FieldSetBuilder, Error> {
    let mut builder = FieldSetBuilder::new();
    if options.date_style.is_some() || options.time_style.is_some() {
        if let Some(style) = options.date_style {
            builder.length = Some(style_length(style));
            builder.date_fields = Some(if matches!(style, Style::Full) { DateFields::YMDE } else { DateFields::YMD });
        }
        if let Some(style) = options.time_style {
            builder.length.get_or_insert(style_length(style));
            builder.time_precision = Some(match style {
                Style::Short => TimePrecision::Minute,
                _ => TimePrecision::Second,
            });
            builder.zone_style = match style {
                Style::Full => Some(ZoneStyle::SpecificLong),
                Style::Long => Some(ZoneStyle::SpecificShort),
                _ => None,
            };
        }
        return Ok(builder);
    }

    let (y, m, d, e) = (options.year.is_some(), options.month.is_some(), options.day.is_some(), options.weekday.is_some());
    // the nearest field set ICU4X has: a year and a day bring the month along, a
    // weekday is dropped where no set has it (year and month alone)
    builder.date_fields = if y && d || y && m && e {
        Some(if e { DateFields::YMDE } else { DateFields::YMD })
    } else if m && d || m && e {
        Some(if e { DateFields::MDE } else { DateFields::MD })
    } else if y && m {
        Some(DateFields::YM)
    } else if d {
        Some(if e { DateFields::DE } else { DateFields::D })
    } else if m {
        Some(DateFields::M)
    } else if y {
        Some(DateFields::Y)
    } else if e {
        Some(DateFields::E)
    } else {
        None
    };
    // the month's width sets the length; a weekday's does without one
    builder.length = Some(match (options.month, options.weekday) {
        (Some(MonthWidth::Long), _) => Length::Long,
        (Some(MonthWidth::Short), _) => Length::Medium,
        (Some(_), _) => Length::Short,
        (None, Some(TextWidth::Long)) => Length::Long,
        (None, Some(TextWidth::Short)) => Length::Medium,
        _ => Length::Short,
    });
    // a year style only where there is a year (ICU4X refuses one it would not use)
    if matches!(builder.date_fields, Some(DateFields::YMD | DateFields::YMDE | DateFields::YM | DateFields::Y)) {
        builder.year_style = Some(match (options.era, options.year) {
            (Some(_), _) => YearStyle::WithEra,
            (None, Some(NumericWidth::TwoDigit)) => YearStyle::Auto,
            _ => YearStyle::Full,
        });
    }
    builder.time_precision = if let Some(digits) = options.fractional_second_digits {
        Some(TimePrecision::Subsecond(match digits {
            1 => SubsecondDigits::S1,
            2 => SubsecondDigits::S2,
            _ => SubsecondDigits::S3,
        }))
    } else if options.second.is_some() {
        Some(TimePrecision::Second)
    } else if options.minute.is_some() {
        Some(TimePrecision::Minute)
    } else if options.hour.is_some() || options.day_period.is_some() {
        Some(TimePrecision::Hour)
    } else {
        None
    };
    let two_digit = |width: Option<NumericWidth>| matches!(width, Some(NumericWidth::TwoDigit));
    if two_digit(options.day) || two_digit(options.hour) || matches!(options.month, Some(MonthWidth::TwoDigit)) {
        builder.alignment = Some(Alignment::Column);
    }
    builder.zone_style = options.time_zone_name.map(|name| match name {
        TimeZoneName::Short => ZoneStyle::SpecificShort,
        TimeZoneName::Long => ZoneStyle::SpecificLong,
        TimeZoneName::ShortOffset => ZoneStyle::LocalizedOffsetShort,
        TimeZoneName::LongOffset => ZoneStyle::LocalizedOffsetLong,
        TimeZoneName::ShortGeneric => ZoneStyle::GenericShort,
        TimeZoneName::LongGeneric => ZoneStyle::GenericLong,
    });
    if builder.date_fields.is_none() && builder.time_precision.is_none() {
        // a zone name alone is shown with the date, as ECMA-402 fills it in
        builder.date_fields = Some(DateFields::YMD);
        builder.year_style = Some(YearStyle::Full);
    }
    Ok(builder)
}

/// ECMA-402's defaults: with no components and no styles, a numeric date.
fn with_defaults(mut options: DateTimeOptions) -> DateTimeOptions {
    let any = options.weekday.is_some()
        || options.era.is_some()
        || options.year.is_some()
        || options.month.is_some()
        || options.day.is_some()
        || options.day_period.is_some()
        || options.hour.is_some()
        || options.minute.is_some()
        || options.second.is_some()
        || options.fractional_second_digits.is_some()
        || options.date_style.is_some()
        || options.time_style.is_some();
    if !any {
        options.year = Some(NumericWidth::Numeric);
        options.month = Some(MonthWidth::Numeric);
        options.day = Some(NumericWidth::Numeric);
    }
    options
}

impl DateTimeResource {
    /// The instant as ICU4X's input: the wall time and the zone at it.
    fn input(&self, epoch_ms: f64) -> Result<ZonedDateTime<Iso, TimeZoneInfo<icu::time::zone::models::AtTime>>, Error> {
        let zoned = timestamp(epoch_ms)?.to_zoned(self.zone.clone());
        let civil = zoned.datetime();
        let date = Date::try_new_iso(civil.year() as i32, civil.month() as u8, civil.day() as u8)
            .map_err(|_| range("Invalid time value"))?;
        let time = Time::try_new(
            civil.hour() as u8,
            civil.minute() as u8,
            civil.second() as u8,
            civil.subsec_nanosecond() as u32,
        )
        .map_err(|_| range("Invalid time value"))?;
        let offset = UtcOffset::try_from_seconds(zoned.offset().seconds()).ok();
        let at = ZoneNameTimestamp::from_zoned_date_time(ZonedDateTime {
            date,
            time,
            zone: offset.unwrap_or_else(UtcOffset::zero),
        });
        let zone = IanaParser::new().parse(&self.zone_id).with_offset(offset).with_zone_name_timestamp(at);
        Ok(ZonedDateTime { date, time, zone })
    }
}

impl DateTimeResource {
    /// The formatter for `locales` and `options` (the WIT resource's `create`).
    pub(crate) fn new(locales: Vec<String>, options: DateTimeOptions) -> Result<Self, Error> {
        let locale = pick_locale(&locales)?;
        let components = options.weekday.is_some()
            || options.era.is_some()
            || options.year.is_some()
            || options.month.is_some()
            || options.day.is_some()
            || options.day_period.is_some()
            || options.hour.is_some()
            || options.minute.is_some()
            || options.second.is_some()
            || options.fractional_second_digits.is_some()
            || options.time_zone_name.is_some();
        if components && (options.date_style.is_some() || options.time_style.is_some()) {
            return Err(Error::Invalid("dateStyle and timeStyle cannot be used with date or time components".into()));
        }
        let zone_id = match &options.time_zone {
            Some(id) => canonical(id).ok_or_else(|| range(format!("Invalid time zone specified: {id}")))?,
            None => default_time_zone(),
        };
        let tz = zone(&zone_id)?;
        let mut prefs: DateTimeFormatterPreferences = (&locale).into();
        let hour_cycle = match (options.hour12, options.hour_cycle) {
            (Some(true), _) => Some(HourCycle::H12),
            (Some(false), _) => Some(HourCycle::H23),
            (None, Some(WitHourCycle::H11)) => Some(HourCycle::H11),
            (None, Some(WitHourCycle::H12)) => Some(HourCycle::H12),
            (None, Some(_)) => Some(HourCycle::H23),
            (None, None) => None,
        };
        if hour_cycle.is_some() {
            prefs.hour_cycle = hour_cycle;
        }
        let options = with_defaults(options);
        let fields = field_set(&options)?.build_composite().map_err(|error| range(format!("{error:?}")))?;
        let formatter = DateTimeFormatter::try_new(prefs, fields).map_err(|error| range(format!("{error:?}")))?;

        let mut resource = DateTimeResource { formatter, zone: tz, zone_id, locale: resolved_locale(&locale), options };
        resource.options.locale_matcher = None;
        resource.options.time_zone = None;
        resource.options.format_matcher = None;
        resource.options.calendar = None;
        resource.options.numbering_system = None;
        // the hour cycle in effect, when hours are shown: the one asked for, or the
        // locale's (whether noon comes out with a day period)
        let shows_hours = resource.options.hour.is_some() || resource.options.time_style.is_some();
        if shows_hours {
            let cycle = match hour_cycle {
                Some(HourCycle::H11) => WitHourCycle::H11,
                Some(HourCycle::H12) => WitHourCycle::H12,
                Some(_) => WitHourCycle::H23,
                None => {
                    let noon = resource.input(12.0 * 3600.0 * 1000.0).ok();
                    let twelve = noon.is_some_and(|noon| {
                        parts(&resource.formatter.format(&noon)).iter().any(|part| part.kind == "dayPeriod")
                    });
                    if twelve { WitHourCycle::H12 } else { WitHourCycle::H23 }
                }
            };
            resource.options.hour_cycle = Some(cycle);
            resource.options.hour12 = Some(matches!(cycle, WitHourCycle::H11 | WitHourCycle::H12));
        } else {
            resource.options.hour_cycle = None;
            resource.options.hour12 = None;
        }
        Ok(resource)
    }
}

impl GuestDateTimeFormat for DateTimeResource {
    fn create(locales: Vec<String>, options: DateTimeOptions) -> Result<DateTimeFormat, Error> {
        DateTimeResource::new(locales, options).map(DateTimeFormat::new)
    }

    fn format(&self, epoch_ms: f64) -> Result<String, Error> {
        Ok(web_spaces(self.formatter.format(&self.input(epoch_ms)?).to_string()))
    }

    fn format_to_parts(&self, epoch_ms: f64) -> Result<Vec<Part>, Error> {
        Ok(parts(&self.formatter.format(&self.input(epoch_ms)?))
            .into_iter()
            .map(|mut part| {
                part.value = web_spaces(part.value);
                part
            })
            .collect())
    }

    fn format_range(&self, start_ms: f64, end_ms: f64) -> Result<String, Error> {
        Ok(format!("{}\u{2009}–\u{2009}{}", self.format(start_ms)?, self.format(end_ms)?))
    }

    fn format_range_to_parts(&self, start_ms: f64, end_ms: f64) -> Result<Vec<Part>, Error> {
        let mut out = with_source(self.format_to_parts(start_ms)?, "startRange");
        out.push(Part { kind: "literal".into(), value: "\u{2009}–\u{2009}".into(), source: Some("shared".into()) });
        out.extend(with_source(self.format_to_parts(end_ms)?, "endRange"));
        Ok(out)
    }

    fn resolved_options(&self) -> ResolvedDateTimeOptions {
        ResolvedDateTimeOptions {
            locale: self.locale.clone(),
            calendar: "gregory".into(),
            numbering_system: "latn".into(),
            time_zone: self.zone_id.clone(),
            options: self.options.clone(),
        }
    }
}

