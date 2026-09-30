//! `meshx:intl/list`: `Intl.ListFormat`.

use icu::list::options::{ListFormatterOptions, ListLength};
use icu::list::ListFormatter;

use crate::exports::meshx::intl::list::{
    Guest, GuestListFormat, ListFormat, ListOptions, ListStyle, ListType, ResolvedListOptions,
};
use crate::exports::meshx::intl::types::{Error, Part};
use crate::parts::parts;
use crate::{pick_locale, range, resolved_locale, Provider};

impl Guest for Provider {
    type ListFormat = ListResource;
}

/// An `Intl.ListFormat`.
pub struct ListResource {
    formatter: ListFormatter,
    locale: String,
    kind: ListType,
    style: ListStyle,
}

impl ListResource {
    /// The formatter for `locales` and `options` (the WIT resource's `create`).
    pub(crate) fn new(locales: Vec<String>, options: ListOptions) -> Result<Self, Error> {
        let locale = pick_locale(&locales)?;
        let kind = options.type_.unwrap_or(ListType::Conjunction);
        let style = options.style.unwrap_or(ListStyle::Long);
        let length = match style {
            ListStyle::Long => ListLength::Wide,
            ListStyle::Short => ListLength::Short,
            ListStyle::Narrow => ListLength::Narrow,
        };
        let prefs = (&locale).into();
        let icu_options = ListFormatterOptions::default().with_length(length);
        let formatter = match kind {
            ListType::Conjunction => ListFormatter::try_new_and(prefs, icu_options),
            ListType::Disjunction => ListFormatter::try_new_or(prefs, icu_options),
            ListType::Unit => ListFormatter::try_new_unit(prefs, icu_options),
        }
        .map_err(|error| range(error.to_string()))?;
        Ok(ListResource { formatter, locale: resolved_locale(&locale), kind, style })
    }
}

impl GuestListFormat for ListResource {
    fn create(locales: Vec<String>, options: ListOptions) -> Result<ListFormat, Error> {
        ListResource::new(locales, options).map(ListFormat::new)
    }

    fn format(&self, items: Vec<String>) -> String {
        self.formatter.format_to_string(items.iter())
    }

    fn format_to_parts(&self, items: Vec<String>) -> Vec<Part> {
        parts(&self.formatter.format(items.iter()))
    }

    fn resolved_options(&self) -> ResolvedListOptions {
        ResolvedListOptions { locale: self.locale.clone(), type_: self.kind, style: self.style }
    }
}
