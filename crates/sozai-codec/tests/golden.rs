//! Golden vector parity with the TypeScript packages.
//!
//! Each vector file is the one the TS golden tests check (`packages/*/test/golden/*.json`). Every
//! case is checked on its own, and a failing run lists the failing cases by name.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::value::RawValue;
use serde_json::{Number, Value, json};
use sozai_codec::hlc::{self, Hlc, Timestamp};
use sozai_codec::{base32, base64, base64url, canonical, patch, varint};

const CANONICAL_JSON: &str =
    include_str!("../../../packages/codec/test/golden/canonical-json.json");
const CODECS: &str = include_str!("../../../packages/codec/test/golden/codecs.json");
const HLC: &str = include_str!("../../../packages/hlc/test/golden/hlc.json");
const PATCH: &str = include_str!("../../../packages/patch/test/golden/patch.json");

/// One golden case. `input` stays raw JSON text, because some canonical JSON inputs hold lone
/// surrogate escapes that no Rust string can represent.
struct Case {
    name: String,
    input: Box<RawValue>,
    expected: Value,
}

type Fields = HashMap<String, Box<RawValue>>;

fn load(text: &str) -> Vec<Case> {
    let file: Fields = serde_json::from_str(text).expect("golden file is JSON");
    let version: u64 = serde_json::from_str(file["version"].get()).expect("version");
    assert_eq!(version, 1, "golden format version");
    let cases: Vec<Fields> = serde_json::from_str(file["cases"].get()).expect("cases");
    let loaded: Vec<Case> = cases
        .into_iter()
        .map(|mut fields| Case {
            name: serde_json::from_str(fields["name"].get()).expect("name"),
            expected: serde_json::from_str(fields["expected"].get()).expect("expected"),
            input: fields.remove("input").expect("input"),
        })
        .collect();
    let names: HashSet<&str> = loaded.iter().map(|case| case.name.as_str()).collect();
    assert_eq!(names.len(), loaded.len(), "duplicate case names");
    loaded
}

fn input_value(case: &Case) -> Value {
    serde_json::from_str(case.input.get()).expect("input is JSON")
}

/// Run every case, collect the failures by name, and fail once with all of them.
fn check(text: &str, count: usize, run: impl Fn(&Case) -> Result<(), String>) {
    let cases = load(text);
    assert_eq!(cases.len(), count, "case count");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| run(case).err().map(|why| format!("{}: {why}", case.name)))
        .collect();
    assert!(
        failures.is_empty(),
        "failing cases:\n{}",
        failures.join("\n")
    );
}

fn same<T: PartialEq + std::fmt::Debug>(actual: T, expected: T, what: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("{what}: got {actual:?}, expected {expected:?}"))
    }
}

/// The TS harness records a thrown `TypeError` as `{"error":"TypeError"}`. Every
/// [`canonical::CanonicalError`] other than invalid JSON text is that category.
fn canonical_outcome(result: Result<String, canonical::CanonicalError>) -> Value {
    match result {
        Ok(text) => Value::String(text),
        Err(canonical::CanonicalError::InvalidJSON(message)) => json!({ "parse": message }),
        Err(_) => json!({ "error": "TypeError" }),
    }
}

#[test]
fn golden_canonical_json() {
    check(CANONICAL_JSON, 40, |case| {
        let input: Fields = serde_json::from_str(case.input.get()).map_err(|e| e.to_string())?;
        if let Some(hex) = input.get("float64") {
            let hex: String = serde_json::from_str(hex.get()).map_err(|e| e.to_string())?;
            let bits = u64::from_str_radix(&hex, 16).map_err(|e| e.to_string())?;
            let number = f64::from_bits(bits);
            let formatted = canonical_outcome(canonical::format_number(number));
            same(&formatted, &case.expected, "format_number")?;
            if let Some(finite) = Number::from_f64(number) {
                let stringified = canonical_outcome(canonical::stringify(&Value::Number(finite)));
                same(&stringified, &case.expected, "stringify")?;
            }
            return Ok(());
        }
        let raw = input.get("value").ok_or("input has no value")?.get();
        let from_text = canonical_outcome(canonical::stringify_text(raw));
        same(&from_text, &case.expected, "stringify_text")?;
        if case.expected.is_string() {
            let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            same(
                &canonical_outcome(canonical::stringify(&value)),
                &case.expected,
                "stringify",
            )?;
        }
        Ok(())
    });
}

fn expected_str<'a>(case: &'a Case, key: &str) -> Result<&'a str, String> {
    case.expected[key]
        .as_str()
        .ok_or_else(|| format!("expected.{key} is not a string"))
}

#[test]
fn golden_codecs() {
    check(CODECS, 11, |case| {
        let input = input_value(case);
        if let Some(hex) = input["hex"].as_str() {
            let bytes = hex::decode(hex).map_err(|e| e.to_string())?;
            let b64 = expected_str(case, "b64")?;
            let b64u = expected_str(case, "b64u")?;
            let b32 = expected_str(case, "b32")?;
            same(base64::encode(&bytes).as_str(), b64, "base64::encode")?;
            same(
                base64url::encode(&bytes).as_str(),
                b64u,
                "base64url::encode",
            )?;
            same(base32::encode(&bytes).as_str(), b32, "base32::encode")?;
            let decoded = |result: Result<Vec<u8>, _>| result.map(hex::encode);
            same(
                decoded(base64::decode(b64)),
                Ok(expected_str(case, "fromB64")?.to_owned()),
                "base64::decode",
            )?;
            same(
                decoded(base64url::decode(b64u)),
                Ok(expected_str(case, "fromB64U")?.to_owned()),
                "base64url::decode",
            )?;
            same(
                decoded(base32::decode(b32)),
                Ok(expected_str(case, "fromB32")?.to_owned()),
                "base32::decode",
            )?;
            return Ok(());
        }
        let value = input["value"]
            .as_u64()
            .ok_or("input.value is not an integer")?;
        let encoded = varint::encode(value).map_err(|e| format!("encode: {e:?}"))?;
        same(
            hex::encode(&encoded).as_str(),
            expected_str(case, "hex")?,
            "varint::encode",
        )?;
        let decoded = varint::decode(&encoded, 0).map_err(|e| format!("decode: {e:?}"))?;
        let decoded = json!({ "value": decoded.value, "length": decoded.length });
        same(&decoded, &case.expected["decoded"], "varint::decode")
    });
}

fn timestamp(value: &Value) -> Result<Timestamp, String> {
    Ok(Timestamp {
        wall_time: value["wallTime"].as_i64().ok_or("wallTime")?,
        counter: value["counter"]
            .as_u64()
            .and_then(|c| u32::try_from(c).ok())
            .ok_or("counter")?,
        node_id: value["nodeID"].as_str().ok_or("nodeID")?.to_owned(),
    })
}

fn timestamp_json(ts: &Timestamp) -> Value {
    json!({ "wallTime": ts.wall_time, "counter": ts.counter, "nodeID": ts.node_id })
}

fn sign(ordering: Ordering) -> i64 {
    match ordering {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

fn format_and_parse(ts: &Timestamp, expected: &Value) -> Result<String, String> {
    let encoded = hlc::format(ts).map_err(|e| format!("format: {e:?}"))?;
    same(
        Some(encoded.as_str()),
        expected["encoded"].as_str(),
        "format",
    )?;
    if !expected["parsed"].is_null() {
        let parsed = hlc::parse(&encoded).map_err(|e| format!("parse: {e:?}"))?;
        same(&timestamp_json(&parsed), &expected["parsed"], "parse")?;
    }
    Ok(encoded)
}

#[test]
fn golden_hlc() {
    check(HLC, 40, |case| {
        let input = input_value(case);
        let expected = &case.expected;
        if case.name.starts_with("timestamp-") {
            format_and_parse(&timestamp(&input)?, expected)?;
        } else if case.name.starts_with("compare-") {
            let a = timestamp(&input["a"])?;
            let b = timestamp(&input["b"])?;
            let numeric = sign(hlc::compare(&a, &b));
            same(Some(numeric), expected["numeric"].as_i64(), "compare")?;
            let encoded_a = hlc::format(&a).map_err(|e| format!("{e:?}"))?;
            let encoded_b = hlc::format(&b).map_err(|e| format!("{e:?}"))?;
            let lexical = sign(encoded_a.encode_utf16().cmp(encoded_b.encode_utf16()));
            same(Some(lexical), expected["lexical"].as_i64(), "lexical")?;
        } else if case.name.starts_with("parse-") {
            let encoded = input["encoded"].as_str().ok_or("encoded")?;
            let parsed = hlc::parse(encoded)
                .map(|ts| timestamp_json(&ts))
                .unwrap_or(Value::Null);
            same(&parsed, &expected["parsed"], "parse")?;
        } else if case.name == "counter-ceiling" {
            let physical = input["physicalTime"].as_i64().ok_or("physicalTime")?;
            let node_id = input["nodeID"].as_str().ok_or("nodeID")?;
            let mut clock = Hlc::new(node_id);
            let result = clock.receive(&timestamp(&input["remote"])?, physical);
            same(&timestamp_json(&result), &expected["timestamp"], "receive")?;
            format_and_parse(&result, expected)?;
        } else if case.name == "after-ceiling" {
            let physical = input["physicalTime"].as_i64().ok_or("physicalTime")?;
            let mut clock = Hlc::resume(timestamp(&input["previous"])?);
            let next = clock.now(physical);
            same(&timestamp_json(&next), &expected["timestamp"], "now")?;
            format_and_parse(&next, expected)?;
        } else {
            return Err("unknown case kind".into());
        }
        Ok(())
    });
}

#[test]
fn golden_patch() {
    check(PATCH, 64, |case| {
        let input = input_value(case);
        let document = &input["document"];
        // Omitted means strict, the `applyPatches` default.
        let strict = input["strict"].as_bool().unwrap_or(true);
        let operations = input["patches"]
            .as_array()
            .ok_or("patches is not an array")?
            .iter()
            .map(patch::Operation::from_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("operation: {e}"))?;
        let outcome = match patch::apply_with(document, &operations, strict) {
            Ok(result) => json!({ "document": result }),
            // The TS harness records a plain `TypeError` as `{"error":"TypeError"}`.
            Err(error) if error.kind == patch::PatchErrorCode::InvalidTarget => {
                json!({ "error": "TypeError", "document": document })
            }
            Err(error) => {
                json!({ "error": "PatchError", "code": error.code(), "document": document })
            }
        };
        same(&outcome, &case.expected, "apply")
    });
}
