// ---- Temporal.Now and the namespace ----

// SystemUTCEpochNanoseconds
const systemEpochNs = () => BigInt(Date.now()) * 1000000n;

// the time zone asked for, or the host's
const nowTimeZone = timeZoneLike => timeZoneLike === undefined ? normalizeTimeZoneIdentifier(hostTimeZone()) : toTimeZoneIdentifier(timeZoneLike);

const Now = {
  instant() {
    return createInstant(systemEpochNs());
  },
  timeZoneId() {
    return normalizeTimeZoneIdentifier(hostTimeZone());
  },
  zonedDateTimeISO(temporalTimeZoneLike = undefined) {
    return createZonedDateTime(systemEpochNs(), nowTimeZone(temporalTimeZoneLike), 'iso8601');
  },
  plainDateTimeISO(temporalTimeZoneLike = undefined) {
    const dt = isoDateTimeFor(nowTimeZone(temporalTimeZoneLike), systemEpochNs());
    return createPlainDateTime(dt.date, dt.time, 'iso8601');
  },
  plainDateISO(temporalTimeZoneLike = undefined) {
    return createPlainDate(isoDateTimeFor(nowTimeZone(temporalTimeZoneLike), systemEpochNs()).date, 'iso8601');
  },
  plainTimeISO(temporalTimeZoneLike = undefined) {
    return createPlainTime(isoDateTimeFor(nowTimeZone(temporalTimeZoneLike), systemEpochNs()).time);
  }
};

return { Instant, PlainDateTime, PlainDate, PlainTime, PlainYearMonth, PlainMonthDay, Duration, ZonedDateTime, Now };
})();
