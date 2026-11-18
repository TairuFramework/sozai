//! Hybrid logical clocks, as the `HLC` class in `@sozai/hlc`.
//!
//! A stamp serializes as `<ISO 8601 wall time>:<8-digit counter>:<node ID>`, for example
//! `2025-02-14T13:30:00.000Z:00000000:did:key:aaa`. The fixed-width counter keeps string order
//! equal to [`compare`] order. The clock is pure: callers pass the physical time in
//! milliseconds since the epoch instead of it reading `Date.now()`.

use std::cmp::Ordering;
use std::fmt;
use std::fmt::Write as _;

/// The counter ceiling: a candidate counter reaching it advances the wall time by 1 ms instead,
/// so the serialized counter never grows a 9th digit.
pub const COUNTER_CEILING: u32 = 100_000_000;

const COUNTER_PAD: usize = 8;

/// The largest absolute wall time JavaScript `Date` represents: 8.64e15 ms.
pub const MAX_WALL_TIME: i64 = 8_640_000_000_000_000;

/// A hybrid logical clock timestamp.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timestamp {
    /// Milliseconds since the Unix epoch.
    pub wall_time: i64,
    /// Logical counter within one wall time.
    pub counter: u32,
    /// The node that minted the stamp.
    pub node_id: String,
}

/// A stamp that cannot be serialized or parsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HlcError {
    /// The wall time is outside the JavaScript `Date` range, where `toISOString` throws a
    /// `RangeError`.
    WallTimeOutOfRange,
    /// The text is not `<ISO time>Z:<counter>:<node ID>`, the date is invalid, or the node ID
    /// is empty. TS `tryParse` answers `null` for the cases it detects.
    Malformed,
    /// The counter does not fit in a `u32`.
    CounterOverflow,
}

impl fmt::Display for HlcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::WallTimeOutOfRange => "Invalid time value",
            Self::Malformed => "Malformed HLC timestamp",
            Self::CounterOverflow => "HLC counter overflow",
        })
    }
}

impl std::error::Error for HlcError {}

/// A hybrid logical clock for one node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hlc {
    node_id: String,
    last_wall_time: i64,
    last_counter: u32,
}

impl Hlc {
    /// A fresh clock for `node_id`, as `new HLC({ nodeID })`.
    pub fn new(node_id: impl Into<String>) -> Self {
        Self {
            node_id: node_id.into(),
            last_wall_time: 0,
            last_counter: 0,
        }
    }

    /// A clock that continues after `last`, the newest stamp it minted. The next stamp is
    /// strictly greater than `last`.
    pub fn resume(last: Timestamp) -> Self {
        Self {
            node_id: last.node_id,
            last_wall_time: last.wall_time,
            last_counter: last.counter,
        }
    }

    /// The node this clock mints for.
    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    fn stamp(&self) -> Timestamp {
        Timestamp {
            wall_time: self.last_wall_time,
            counter: self.last_counter,
            node_id: self.node_id.clone(),
        }
    }

    fn apply_counter(&mut self, candidate: u64) {
        if candidate >= u64::from(COUNTER_CEILING) {
            self.last_wall_time = self.last_wall_time.saturating_add(1);
            self.last_counter = 0;
        } else {
            // Below the ceiling, so it fits.
            self.last_counter = candidate as u32;
        }
    }

    /// Mint a local stamp at `physical_time` (ms since the epoch), as `HLC#now`.
    pub fn now(&mut self, physical_time: i64) -> Timestamp {
        if physical_time > self.last_wall_time {
            self.last_wall_time = physical_time;
            self.last_counter = 0;
        } else {
            self.apply_counter(u64::from(self.last_counter) + 1);
        }
        self.stamp()
    }

    /// Advance past a remote stamp at `physical_time`, as `HLC#receive`.
    pub fn receive(&mut self, remote: &Timestamp, physical_time: i64) -> Timestamp {
        if physical_time > self.last_wall_time && physical_time > remote.wall_time {
            self.last_wall_time = physical_time;
            self.last_counter = 0;
        } else if remote.wall_time > self.last_wall_time {
            self.last_wall_time = remote.wall_time;
            self.apply_counter(u64::from(remote.counter) + 1);
        } else if self.last_wall_time > remote.wall_time {
            self.apply_counter(u64::from(self.last_counter) + 1);
        } else {
            self.apply_counter(u64::from(self.last_counter.max(remote.counter)) + 1);
        }
        self.stamp()
    }
}

/// Order stamps by wall time, then counter, then node ID by UTF-16 code unit, as `HLC.compare`.
pub fn compare(a: &Timestamp, b: &Timestamp) -> Ordering {
    a.wall_time
        .cmp(&b.wall_time)
        .then(a.counter.cmp(&b.counter))
        .then_with(|| crate::compare_utf16(&a.node_id, &b.node_id))
}

/// Serialize a stamp, as `HLC.serialize`. Fails only for a wall time outside the `Date` range.
pub fn format(ts: &Timestamp) -> Result<String, HlcError> {
    let mut out = format_iso(ts.wall_time)?;
    let _ = write!(
        out,
        ":{:0width$}:{}",
        ts.counter,
        ts.node_id,
        width = COUNTER_PAD
    );
    Ok(out)
}

/// Parse a stamp from a peer, as `HLC.tryParse`, but strictly.
///
/// Accepts exactly what [`format`] emits: a `Date#toISOString` time (`YYYY-MM-DDTHH:mm:ss.sssZ`,
/// or a `±YYYYYY` year), `:`, at least 8 ASCII digits, `:`, and a non-empty node ID (which may
/// itself hold `:`). TS parses the time with `new Date()` and the counter with `parseInt`, both
/// of which accept other spellings; those fail here with [`HlcError::Malformed`].
pub fn parse(text: &str) -> Result<Timestamp, HlcError> {
    let z_index = text.find('Z').ok_or(HlcError::Malformed)?;
    let wall_time = parse_iso(&text[..z_index])?;
    let rest = text[z_index + 1..]
        .strip_prefix(':')
        .ok_or(HlcError::Malformed)?;
    let (counter, node_id) = rest.split_once(':').ok_or(HlcError::Malformed)?;
    if counter.len() < COUNTER_PAD || !counter.bytes().all(|b| b.is_ascii_digit()) {
        return Err(HlcError::Malformed);
    }
    let counter: u32 = counter.parse().map_err(|_| HlcError::CounterOverflow)?;
    if node_id.is_empty() {
        return Err(HlcError::Malformed);
    }
    Ok(Timestamp {
        wall_time,
        counter,
        node_id: node_id.to_owned(),
    })
}

const MS_PER_DAY: i64 = 86_400_000;

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian date for days since 1970-01-01 (Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `Date#toISOString`, trailing `Z` included.
fn format_iso(wall_time: i64) -> Result<String, HlcError> {
    if !(-MAX_WALL_TIME..=MAX_WALL_TIME).contains(&wall_time) {
        return Err(HlcError::WallTimeOutOfRange);
    }
    let days = wall_time.div_euclid(MS_PER_DAY);
    let mut ms = wall_time.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let millis = ms % 1000;
    ms /= 1000;
    let seconds = ms % 60;
    ms /= 60;
    let minutes = ms % 60;
    let hours = ms / 60;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Ok(format!(
        "{year}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    ))
}

fn digits(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Parse the part of a `toISOString` result before its `Z`.
fn parse_iso(text: &str) -> Result<i64, HlcError> {
    let malformed = HlcError::Malformed;
    let (year, rest) = match text.as_bytes().first() {
        Some(b'+' | b'-') => {
            let (sign_year, rest) = text.split_at_checked(7).ok_or(malformed)?;
            let magnitude = digits(&sign_year[1..]).ok_or(malformed)?;
            // ECMAScript forbids `-000000`.
            if sign_year.starts_with('-') && magnitude == 0 {
                return Err(malformed);
            }
            let year = if sign_year.starts_with('-') {
                -magnitude
            } else {
                magnitude
            };
            (year, rest)
        }
        _ => {
            let (year, rest) = text.split_at_checked(4).ok_or(malformed)?;
            (digits(year).ok_or(malformed)?, rest)
        }
    };
    // `-MM-DDTHH:mm:ss.sss`
    let rest = rest.as_bytes();
    if rest.len() != 19
        || rest[0] != b'-'
        || rest[3] != b'-'
        || rest[6] != b'T'
        || rest[9] != b':'
        || rest[12] != b':'
        || rest[15] != b'.'
    {
        return Err(malformed);
    }
    let field = |start: usize, len: usize| {
        std::str::from_utf8(&rest[start..start + len])
            .ok()
            .and_then(digits)
            .ok_or(malformed)
    };
    let month = field(1, 2)?;
    let day = field(4, 2)?;
    let hours = field(7, 2)?;
    let minutes = field(10, 2)?;
    let seconds = field(13, 2)?;
    let millis = field(16, 3)?;
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hours > 23
        || minutes > 59
        || seconds > 59
    {
        return Err(malformed);
    }
    let wall_time = days_from_civil(year, month, day) * MS_PER_DAY
        + ((hours * 60 + minutes) * 60 + seconds) * 1000
        + millis;
    if !(-MAX_WALL_TIME..=MAX_WALL_TIME).contains(&wall_time) {
        return Err(malformed);
    }
    Ok(wall_time)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(wall_time: i64, counter: u32, node_id: &str) -> Timestamp {
        Timestamp {
            wall_time,
            counter,
            node_id: node_id.to_owned(),
        }
    }

    #[test]
    fn iso_round_trips_across_the_date_range() {
        let cases = [
            (0, "1970-01-01T00:00:00.000Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
            (-62_198_755_200_000, "-000001-01-01T00:00:00.000Z"),
            (253_402_300_800_000, "+010000-01-01T00:00:00.000Z"),
            (MAX_WALL_TIME, "+275760-09-13T00:00:00.000Z"),
            (-MAX_WALL_TIME, "-271821-04-20T00:00:00.000Z"),
        ];
        for (wall_time, iso) in cases {
            let stamp = ts(wall_time, 7, "n");
            let encoded = format(&stamp).expect("in range");
            assert_eq!(encoded, format!("{iso}:00000007:n"));
            assert_eq!(parse(&encoded), Ok(stamp));
        }
        assert_eq!(
            format(&ts(MAX_WALL_TIME + 1, 0, "n")),
            Err(HlcError::WallTimeOutOfRange)
        );
    }

    #[test]
    fn parse_rejects_malformed_stamps() {
        for bad in [
            "",
            "2025-02-14T13:30:00.000Z",
            "2025-02-14T13:30:00.000Z:00000000",
            "2025-02-14T13:30:00.000Z:00000000:",
            "2025-02-14T13:30:00.000Z-00000000:n",
            "2025-02-14T13:30:00.000Z:0000000:n",
            "2025-02-14T13:30:00.000Z:+0000001:n",
            "2025-02-14T13:30:00.000Z: 0000001:n",
            "2025-02-14T13:30:00Z:00000000:n",
            "2025-02-30T13:30:00.000Z:00000000:n",
            "2025-02-14T24:00:00.000Z:00000000:n",
            "-000000-01-01T00:00:00.000Z:00000000:n",
            "+275760-09-13T00:00:00.001Z:00000000:n",
            "2025-02-14 13:30:00.000Z:00000000:n",
        ] {
            assert_eq!(parse(bad), Err(HlcError::Malformed), "{bad:?}");
        }
        assert_eq!(
            parse("2025-02-14T13:30:00.000Z:99999999999:n"),
            Err(HlcError::CounterOverflow)
        );
        assert_eq!(
            parse("2025-02-14T13:30:00.000Z:000000001:a:b"),
            Ok(ts(1_739_539_800_000, 1, "a:b"))
        );
    }

    #[test]
    fn compare_orders_node_ids_by_utf16() {
        let a = ts(1, 0, "\u{1F602}");
        let b = ts(1, 0, "\u{FB33}");
        assert_eq!(compare(&a, &b), Ordering::Less);
        assert_eq!(compare(&ts(1, 2, "a"), &ts(1, 10, "a")), Ordering::Less);
        assert_eq!(compare(&ts(2, 0, "a"), &ts(1, 10, "b")), Ordering::Greater);
    }

    #[test]
    fn clock_paths() {
        let mut clock = Hlc::new("local");
        assert_eq!(clock.now(100), ts(100, 0, "local"));
        assert_eq!(clock.now(100), ts(100, 1, "local"));
        assert_eq!(clock.now(50), ts(100, 2, "local"));
        assert_eq!(clock.receive(&ts(100, 9, "r"), 100), ts(100, 10, "local"));
        assert_eq!(clock.receive(&ts(90, 99, "r"), 100), ts(100, 11, "local"));
        assert_eq!(clock.receive(&ts(200, 4, "r"), 150), ts(200, 5, "local"));
        assert_eq!(clock.receive(&ts(200, 4, "r"), 300), ts(300, 0, "local"));
        let mut full = Hlc::resume(ts(300, COUNTER_CEILING - 1, "local"));
        assert_eq!(full.now(300), ts(301, 0, "local"));
        let mut far = Hlc::new("local");
        assert_eq!(far.receive(&ts(5, u32::MAX, "r"), 0), ts(6, 0, "local"));
    }
}
