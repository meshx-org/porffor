//! `meshx:intl/plural`: `Intl.PluralRules`, choosing on the number rounded as the options
//! say (1 and 1.0 can differ: "1 star", "1.0 stars").

use icu::plurals::{PluralCategory as IcuCategory, PluralRules};

use crate::exports::meshx::intl::plural::{
    Guest, GuestPluralRules, PluralCategory, PluralOptions, PluralRules as PluralRulesHandle,
    PluralType, ResolvedPluralOptions,
};
use crate::exports::meshx::intl::types::{Error, Notation};
use crate::number::{decimal_of_f64, Digits};
use crate::{pick_locale, range, resolved_locale, Provider};

impl Guest for Provider {
    type PluralRules = PluralResource;
}

/// An `Intl.PluralRules`.
pub struct PluralResource {
    rules: PluralRules,
    locale: String,
    kind: PluralType,
    digits: Digits,
}

fn category(category: IcuCategory) -> PluralCategory {
    match category {
        IcuCategory::Zero => PluralCategory::Zero,
        IcuCategory::One => PluralCategory::One,
        IcuCategory::Two => PluralCategory::Two,
        IcuCategory::Few => PluralCategory::Few,
        IcuCategory::Many => PluralCategory::Many,
        IcuCategory::Other => PluralCategory::Other,
    }
}

impl PluralResource {
    fn select_rounded(&self, n: f64) -> Option<icu::decimal::input::Decimal> {
        let mut decimal = decimal_of_f64(n)?;
        self.digits.round(&mut decimal);
        Some(decimal)
    }
}

impl PluralResource {
    /// The formatter for `locales` and `options` (the WIT resource's `create`).
    pub(crate) fn new(locales: Vec<String>, options: PluralOptions) -> Result<Self, Error> {
        let locale = pick_locale(&locales)?;
        let kind = options.type_.unwrap_or(PluralType::Cardinal);
        let prefs = (&locale).into();
        let rules = match kind {
            PluralType::Cardinal => PluralRules::try_new_cardinal(prefs),
            PluralType::Ordinal => PluralRules::try_new_ordinal(prefs),
        }
        .map_err(|error| range(error.to_string()))?;
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
            0,
            3,
        )?;
        Ok(PluralResource { rules, locale: resolved_locale(&locale), kind, digits })
    }
}

impl GuestPluralRules for PluralResource {
    fn create(locales: Vec<String>, options: PluralOptions) -> Result<PluralRulesHandle, Error> {
        PluralResource::new(locales, options).map(PluralRulesHandle::new)
    }

    fn select(&self, n: f64) -> PluralCategory {
        match self.select_rounded(n) {
            Some(decimal) => category(self.rules.category_for(&decimal)),
            None => PluralCategory::Other,
        }
    }

    fn select_range(&self, start: f64, end: f64) -> Result<PluralCategory, Error> {
        // CLDR's range rules give the end's category for nearly every locale and pair
        // (ICU4X has them behind an unstable feature)
        let (Some(_), Some(b)) = (self.select_rounded(start), self.select_rounded(end)) else {
            return Err(range("selectRange: a bound is not a number"));
        };
        Ok(category(self.rules.category_for(&b)))
    }

    fn resolved_options(&self) -> ResolvedPluralOptions {
        ResolvedPluralOptions {
            locale: self.locale.clone(),
            plural_categories: self.rules.categories().map(category).collect(),
            options: PluralOptions {
                locale_matcher: None,
                type_: Some(self.kind),
                notation: Some(Notation::Standard),
                minimum_integer_digits: Some(self.digits.min_integer),
                minimum_fraction_digits: self.digits.min_fraction,
                maximum_fraction_digits: self.digits.max_fraction,
                minimum_significant_digits: self.digits.min_significant,
                maximum_significant_digits: self.digits.max_significant,
                rounding_increment: Some(self.digits.increment),
                rounding_mode: Some(self.digits.mode),
                rounding_priority: Some(self.digits.priority),
                trailing_zero_display: Some(self.digits.trailing_zeros),
            },
        }
    }
}
