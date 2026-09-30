//! formatToParts: an ICU4X formatter writes into [`Collect`], which keeps each run of
//! text with the part it belongs to. ICU4X names its parts as ECMA-402 does (`year`,
//! `dayPeriod`, `integer`, `group`, `element`); text outside any part is a `literal`.

use core::fmt;

use writeable::{Part as WritePart, PartsWrite, Writeable};

use crate::exports::meshx::intl::types::Part;

/// Text written so far, each run with the parts it is inside (outermost first).
#[derive(Default)]
pub(crate) struct Collect {
    runs: Vec<(Option<WritePart>, Option<WritePart>, String)>,
    stack: Vec<WritePart>,
}

impl fmt::Write for Collect {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        // an empty write (a sign with nothing to show) is no part
        if text.is_empty() {
            return Ok(());
        }
        let outer = self.stack.first().copied();
        let inner = self.stack.last().copied().filter(|_| self.stack.len() > 1);
        match self.runs.last_mut() {
            Some((o, i, run)) if *o == outer && *i == inner => run.push_str(text),
            _ => self.runs.push((outer, inner, text.to_owned())),
        }
        Ok(())
    }
}

impl PartsWrite for Collect {
    type SubPartsWrite = Self;

    fn with_part(
        &mut self,
        part: WritePart,
        mut f: impl FnMut(&mut Self::SubPartsWrite) -> fmt::Result,
    ) -> fmt::Result {
        self.stack.push(part);
        let result = f(self);
        self.stack.pop();
        result
    }
}

/// The ECMA-402 part type for a run: its outermost part, except that fractional seconds
/// (a decimal inside `second`) split into the separator and `fractionalSecond`, and a
/// group separator inside an integer is a `group`.
fn kind(outer: Option<WritePart>, inner: Option<WritePart>) -> String {
    match (outer, inner) {
        (None, _) => "literal".into(),
        (Some(outer), Some(inner)) if outer.value == "second" && inner.value == "decimal" => {
            "literal".into()
        }
        (Some(outer), Some(inner)) if outer.value == "second" && inner.value == "fraction" => {
            "fractionalSecond".into()
        }
        // a group separator is written inside the integer it separates
        (Some(outer), Some(inner)) if outer.value == "integer" && inner.value == "group" => "group".into(),
        (Some(outer), _) => outer.value.into(),
    }
}

/// `formatted`'s text, split into its parts.
pub(crate) fn parts(formatted: &impl Writeable) -> Vec<Part> {
    let mut collect = Collect::default();
    // writing to a String-backed sink cannot fail
    let _ = formatted.write_to_parts(&mut collect);
    collect
        .runs
        .into_iter()
        .map(|(outer, inner, value)| Part { kind: kind(outer, inner), value, source: None })
        .collect()
}

/// `parts`, each marked as coming from `source` (a range's startRange, endRange or shared).
pub(crate) fn with_source(parts: Vec<Part>, source: &str) -> Vec<Part> {
    parts
        .into_iter()
        .map(|mut part| {
            part.source = Some(source.into());
            part
        })
        .collect()
}
