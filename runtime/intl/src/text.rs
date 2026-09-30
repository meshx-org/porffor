//! `meshx:intl/text`: normalization, locale-aware case and collation.

use core::cmp::Ordering;

use icu::casemap::CaseMapper;
use icu::collator::options::{
    AlternateHandling, CaseLevel, CollatorOptions as IcuCollatorOptions, Strength,
};
use icu::collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
use icu::collator::{Collator as IcuCollator, CollatorBorrowed, CollatorPreferences};
use icu::normalizer::{ComposingNormalizer, DecomposingNormalizer};

use crate::exports::meshx::intl::text::{
    CaseFirst, Collator, CollatorOptions, Guest, GuestCollator, NormalizationForm,
    ResolvedCollatorOptions, Sensitivity, Usage,
};
use crate::exports::meshx::intl::types::Error;
use crate::{parse_locale, pick_locale, range, resolved_locale, Provider};

impl Guest for Provider {
    type Collator = CollatorResource;

    fn normalize(s: String, form: NormalizationForm) -> String {
        match form {
            NormalizationForm::Nfc => ComposingNormalizer::new_nfc().normalize(&s).into_owned(),
            NormalizationForm::Nfkc => ComposingNormalizer::new_nfkc().normalize(&s).into_owned(),
            NormalizationForm::Nfd => DecomposingNormalizer::new_nfd().normalize(&s).into_owned(),
            NormalizationForm::Nfkd => DecomposingNormalizer::new_nfkd().normalize(&s).into_owned(),
        }
    }

    fn to_lower(s: String, locale: String) -> Result<String, Error> {
        let locale = parse_locale(&locale)?;
        Ok(CaseMapper::new().lowercase_to_string(&s, &locale.id).into_owned())
    }

    fn to_upper(s: String, locale: String) -> Result<String, Error> {
        let locale = parse_locale(&locale)?;
        Ok(CaseMapper::new().uppercase_to_string(&s, &locale.id).into_owned())
    }
}

/// An `Intl.Collator`: ICU4X's, and the options it was made with, resolved.
pub struct CollatorResource {
    collator: CollatorBorrowed<'static>,
    locale: String,
    options: CollatorOptions,
}

impl CollatorResource {
    /// The formatter for `locales` and `options` (the WIT resource's `create`).
    pub(crate) fn new(locales: Vec<String>, options: CollatorOptions) -> Result<Self, Error> {
        let locale = pick_locale(&locales)?;
        let mut prefs: CollatorPreferences = (&locale).into();
        let numeric = options.numeric.unwrap_or(false);
        let case_first = options.case_first.unwrap_or(CaseFirst::False);
        let sensitivity = options.sensitivity.unwrap_or(Sensitivity::Variant);
        prefs.numeric_ordering = Some(if numeric { CollationNumericOrdering::True } else { CollationNumericOrdering::False });
        prefs.case_first = Some(match case_first {
            CaseFirst::Upper => CollationCaseFirst::Upper,
            CaseFirst::Lower => CollationCaseFirst::Lower,
            CaseFirst::False => CollationCaseFirst::False,
        });
        // ECMA-402's sensitivity as a strength (and, for `case`, the case level)
        let mut icu = IcuCollatorOptions::default();
        icu.strength = Some(match sensitivity {
            Sensitivity::Base | Sensitivity::Case => Strength::Primary,
            Sensitivity::Accent => Strength::Secondary,
            Sensitivity::Variant => Strength::Tertiary,
        });
        if matches!(sensitivity, Sensitivity::Case) {
            icu.case_level = Some(CaseLevel::On);
        }
        if options.ignore_punctuation == Some(true) {
            icu.alternate_handling = Some(AlternateHandling::Shifted);
        }
        let collator = IcuCollator::try_new(prefs, icu).map_err(|error| range(error.to_string()))?;
        Ok(CollatorResource {
            collator,
            locale: resolved_locale(&locale),
            options: CollatorOptions {
                locale_matcher: None,
                usage: Some(options.usage.unwrap_or(Usage::Sort)),
                sensitivity: Some(sensitivity),
                ignore_punctuation: Some(options.ignore_punctuation.unwrap_or(false)),
                numeric: Some(numeric),
                case_first: Some(case_first),
                collation: None,
            },
        })
    }
}

impl GuestCollator for CollatorResource {
    fn create(locales: Vec<String>, options: CollatorOptions) -> Result<Collator, Error> {
        CollatorResource::new(locales, options).map(Collator::new)
    }

    fn compare(&self, a: String, b: String) -> i8 {
        match self.collator.compare(&a, &b) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        }
    }

    fn resolved_options(&self) -> ResolvedCollatorOptions {
        ResolvedCollatorOptions {
            locale: self.locale.clone(),
            collation: "default".into(),
            options: self.options.clone(),
        }
    }
}
