//! `meshx:intl` answered by ICU4X, in two builds of one implementation:
//!
//! - a component (feature `component`), for guests whose host does not answer the
//!   interface itself (`wasmtime serve`, CI), composed into them with `wac plug`. Built for
//!   `wasm32-unknown-unknown`, so it imports nothing, and asks nothing of its host:
//!   `default-locale` is en-US and `default-time-zone` is UTC.
//! - Porffor's native Intl (feature `capi`): a static library with a C ABI ([`capi`]) that
//!   runtime/host/native/intl calls. It answers the process's locale (`LC_ALL`,
//!   `LC_MESSAGES`, `LANG`) and time zone (`TZ`, the system's).
//!
//! A browser or Node answers from its own `Intl`, so the data only ships where nothing else
//! provides it. Time zones come from jiff's bundled IANA database (ICU4X has none).
//!
//! The types are wit-bindgen's in both builds, generated from the same WIT, so the two
//! cannot drift; the component exports the `Guest` implementations, and the C ABI calls the
//! same implementations directly.

wit_bindgen::generate!({ path: "../../wasi/wit/meshx-intl-0.1.0", world: "provider" });

#[cfg(feature = "capi")]
pub mod capi;
mod date_time;
mod list;
mod locale;
mod number;
mod parts;
mod plural;
mod text;
mod time_zone;

use exports::meshx::intl::types::Error;
use icu::locale::{Locale, LocaleCanonicalizer};

/// The component: every exported interface is implemented on it.
pub(crate) struct Provider;

#[cfg(feature = "component")]
export!(Provider);

/// The locale when none is asked for or the environment names none.
const FALLBACK_LOCALE: &str = "en-US";

/// What `default-locale` answers, and the locale when none is asked for: en-US in a
/// component; natively, the process's (`LC_ALL`, then `LC_MESSAGES`, then `LANG`, as
/// POSIX orders them), when it names one.
pub(crate) fn default_locale() -> String {
    #[cfg(feature = "capi")]
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(name) else { continue };
        if value.is_empty() {
            continue;
        }
        // `de_DE.UTF-8@euro` is de-DE; `C` and `POSIX` name no language
        let tag = value.split(['.', '@']).next().unwrap_or("").replace('_', "-");
        if tag == "C" || tag == "POSIX" {
            break;
        }
        if let Ok(locale) = parse_locale(&tag) {
            return locale.to_string();
        }
        break;
    }
    FALLBACK_LOCALE.into()
}

/// A RangeError with this message.
pub(crate) fn range(message: impl Into<String>) -> Error {
    Error::Range(message.into())
}

/// `tag` parsed and canonicalized (`EN-us` is `en-US`, aliases replaced).
pub(crate) fn parse_locale(tag: &str) -> Result<Locale, Error> {
    let mut locale = Locale::try_from_str(tag)
        .map_err(|_| range(format!("Incorrect locale information provided: {tag}")))?;
    LocaleCanonicalizer::new_extended().canonicalize(&mut locale);
    Ok(locale)
}

/// The locale a formatter uses: the first of `locales`, or the default when there are
/// none. Every locale has data (ICU4X falls back to its parent, then to the root), so
/// the first requested one is the one used.
pub(crate) fn pick_locale(locales: &[String]) -> Result<Locale, Error> {
    for tag in locales {
        parse_locale(tag)?;
    }
    match locales.first() {
        Some(tag) => parse_locale(tag),
        None => parse_locale(&default_locale()),
    }
}

/// What `resolvedOptions().locale` reports for `locale`: its language, script, region
/// and variants (the Unicode extension keywords are reported as options of their own).
pub(crate) fn resolved_locale(locale: &Locale) -> String {
    locale.id.to_string()
}
