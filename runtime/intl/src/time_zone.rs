//! `meshx:intl/time-zone`, over jiff's bundled IANA database.

use jiff::tz::{self, TimeZone};
use jiff::Timestamp;

use crate::exports::meshx::intl::time_zone::Guest;
use crate::exports::meshx::intl::types::Error;
use crate::{range, Provider};

/// What `default-time-zone` answers: UTC in a component (the host's zone is not asked
/// for); natively, the system's (`TZ`, else the zone the system is set to), when it has an
/// IANA name.
pub(crate) fn default_time_zone() -> String {
    #[cfg(feature = "capi")]
    if let Some(name) = TimeZone::try_system().ok().and_then(|zone| zone.iana_name().and_then(canonical)) {
        return name;
    }
    "UTC".into()
}

/// The zone `id` names: an IANA name (any case, links included) or a UTC offset.
pub(crate) fn zone(id: &str) -> Result<TimeZone, Error> {
    TimeZone::get(id).map_err(|_| range(format!("Invalid time zone specified: {id}")))
}

/// `id` as ECMA-402 reports it: the database's own spelling of the name.
pub(crate) fn canonical(id: &str) -> Option<String> {
    if id.eq_ignore_ascii_case("utc") || id.eq_ignore_ascii_case("etc/utc") || id.eq_ignore_ascii_case("gmt") {
        return Some("UTC".into());
    }
    let zone = TimeZone::get(id).ok()?;
    zone.iana_name().map(str::to_owned)
}

/// The instant `epoch_ms` as a jiff timestamp.
pub(crate) fn timestamp(epoch_ms: f64) -> Result<Timestamp, Error> {
    if !epoch_ms.is_finite() {
        return Err(range("Invalid time value"));
    }
    let nanos = (epoch_ms * 1_000_000.0).round() as i128;
    Timestamp::from_nanosecond(nanos).map_err(|_| range("Invalid time value"))
}

/// Every zone name the database has, sorted.
pub(crate) fn names() -> Vec<String> {
    let mut names: Vec<String> = tz::db().available().map(|name| name.as_str().to_owned()).collect();
    names.sort();
    names
}

impl Guest for Provider {
    fn default_time_zone() -> String {
        default_time_zone()
    }

    fn canonicalize(id: String) -> Option<String> {
        canonical(&id)
    }

    fn offset_at(id: String, epoch_ms: f64) -> Result<i32, Error> {
        let offset = zone(&id)?.to_offset(timestamp(epoch_ms)?);
        Ok(offset.seconds() / 60)
    }
}
