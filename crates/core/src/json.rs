// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Xtream panels and rating APIs send some fields as a number in one response
//! and as a string in the next, so those fields are read through here.

use serde::Deserialize;
use serde_json::{Number, Value};
use std::str::FromStr;

/// A type that can be read from a JSON number or from a string holding one.
pub(crate) trait FromJsonNumber: FromStr {
    /// Converts a JSON number, or returns None when it doesn't fit the type.
    fn from_number(n: &Number) -> Option<Self>;
}

impl FromJsonNumber for i32 {
    /// Vote counts and scores sometimes arrive as floats such as `7.0`, so the
    /// fraction is dropped rather than the value rejected.
    fn from_number(n: &Number) -> Option<Self> {
        n.as_f64().map(|f| f as i32)
    }
}

impl FromJsonNumber for u64 {
    fn from_number(n: &Number) -> Option<Self> {
        n.as_u64()
    }
}

impl FromJsonNumber for f64 {
    fn from_number(n: &Number) -> Option<Self> {
        n.as_f64()
    }
}

impl FromJsonNumber for String {
    fn from_number(n: &Number) -> Option<Self> {
        Some(n.to_string())
    }
}

/// Reads a value that may be a number or a string holding one. Anything else,
/// or a string that doesn't parse, gives None.
pub(crate) fn number_or_string<T: FromJsonNumber>(v: &Value) -> Option<T> {
    match v {
        Value::Number(n) => T::from_number(n),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// A serde `deserialize_with` function for optional fields read with
/// [`number_or_string`].
pub(crate) fn deserialize_number_or_string<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: FromJsonNumber,
{
    let v = Option::<Value>::deserialize(deserializer)?;
    Ok(v.as_ref().and_then(number_or_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn i32_drops_the_fraction() {
        assert_eq!(number_or_string::<i32>(&json!(85)), Some(85));
        assert_eq!(number_or_string::<i32>(&json!(7.9)), Some(7));
        assert_eq!(number_or_string::<i32>(&json!("42")), Some(42));
        assert_eq!(number_or_string::<i32>(&json!("7.5")), None);
    }

    #[test]
    fn u64_rejects_negative_and_fractional_values() {
        assert_eq!(number_or_string::<u64>(&json!(42)), Some(42));
        assert_eq!(number_or_string::<u64>(&json!("123")), Some(123));
        assert_eq!(number_or_string::<u64>(&json!(-1)), None);
        assert_eq!(number_or_string::<u64>(&json!(1.5)), None);
        assert_eq!(number_or_string::<u64>(&json!("3.14")), None);
        assert_eq!(number_or_string::<u64>(&json!("abc")), None);
    }

    #[test]
    fn f64_reads_numbers_and_strings() {
        assert_eq!(number_or_string::<f64>(&json!(7.5)), Some(7.5));
        assert_eq!(number_or_string::<f64>(&json!(8)), Some(8.0));
        assert_eq!(number_or_string::<f64>(&json!("6.25")), Some(6.25));
        assert_eq!(number_or_string::<f64>(&json!("n/a")), None);
    }

    #[test]
    fn string_keeps_text_and_prints_numbers() {
        assert_eq!(
            number_or_string::<String>(&json!("tt0111161")),
            Some("tt0111161".to_string())
        );
        assert_eq!(
            number_or_string::<String>(&json!(278)),
            Some("278".to_string())
        );
    }

    #[test]
    fn other_json_types_give_none() {
        for v in [json!(null), json!(true), json!([1]), json!({ "a": 1 })] {
            assert_eq!(number_or_string::<i32>(&v), None, "{v}");
            assert_eq!(number_or_string::<String>(&v), None, "{v}");
        }
    }

    #[test]
    fn deserializes_optional_fields() {
        #[derive(Deserialize)]
        struct Row {
            #[serde(default, deserialize_with = "deserialize_number_or_string")]
            id: Option<String>,
        }
        let read = |v: Value| serde_json::from_value::<Row>(v).unwrap().id;
        assert_eq!(read(json!({ "id": 7 })), Some("7".to_string()));
        assert_eq!(read(json!({ "id": "x" })), Some("x".to_string()));
        assert_eq!(read(json!({ "id": null })), None);
        assert_eq!(read(json!({})), None);
    }
}
