// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Optional playlist sorting with Google Gemini. The model's answers are
//! checked against the real group names, because it sometimes invents them.

use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const MODEL: &str = "gemini-3-flash-preview";

/// Google accepts the key as a query parameter too, but a URL ends up in logs
/// and error messages where a header does not.
const API_KEY_HEADER: &str = "x-goog-api-key";

/// Sorting a large playlist makes a long prompt, and the model can take minutes
/// to answer it.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(300);

/// A channel group and the parent category Gemini put it under.
#[derive(Debug, Clone)]
pub struct CategorizedGroup {
    pub group_name: String,
    pub super_category: Option<String>,
    pub sort_order: i64,
}

/// Gemini's grouping of a playlist, limited to groups the playlist really has.
#[derive(Debug, Clone)]
pub struct CategorizationResult {
    pub hierarchy: Vec<CategorizedGroup>,
    pub ungrouped: Vec<String>,
}

/// A leftover group that Gemini placed in one of the existing categories.
#[derive(Debug, Clone)]
pub struct GroupAssignment {
    pub group_name: String,
    pub category: String,
}

/// Errors from calling Gemini or reading what it sent back.
#[derive(Debug, thiserror::Error)]
pub enum GeminiError {
    /// The response was not the JSON that was asked for.
    #[error("Parse error: {0}")]
    Parse(String),
    /// The request failed or Gemini answered with an error status.
    #[error("API error: {0}")]
    Api(String),
    /// The JSON was valid but not in the expected shape.
    #[error("Invalid response: {0}")]
    InvalidResponse(String),
}

#[derive(Deserialize)]
struct HierarchicalResponse {
    categories: Vec<CategoryEntry>,
    #[serde(default)]
    ungrouped: Vec<String>,
}

#[derive(Deserialize)]
struct CategoryEntry {
    name: String,
    groups: Vec<String>,
}

#[derive(Deserialize)]
struct FlatResponse {
    groups: Vec<String>,
    #[serde(default)]
    ungrouped: Vec<String>,
}

#[derive(Deserialize)]
struct TypeField {
    #[serde(rename = "type")]
    response_type: String,
}

#[derive(Deserialize)]
struct AssignmentEntry {
    group: String,
    category: String,
}

#[derive(Deserialize)]
struct AssignmentResponse {
    assignments: Vec<AssignmentEntry>,
}

/// Reads Gemini's grouping of a playlist.
///
/// The model sometimes invents group names or lists a group twice, so only
/// names in `known_groups` are kept, each once. Groups it left out are added to
/// `ungrouped` so none of the user's channels disappear.
pub fn parse_categorization_response(
    json: &serde_json::Value,
    known_groups: &[&str],
) -> Result<CategorizationResult, GeminiError> {
    let type_field: TypeField = serde_json::from_value(json.clone())
        .map_err(|e| GeminiError::InvalidResponse(format!("missing 'type' field: {}", e)))?;

    let known_set: HashSet<&str> = known_groups.iter().copied().collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut hierarchy = Vec::new();
    let mut ungrouped = Vec::new();

    match type_field.response_type.as_str() {
        "hierarchical" => {
            let resp: HierarchicalResponse = serde_json::from_value(json.clone())
                .map_err(|e| GeminiError::InvalidResponse(e.to_string()))?;

            let mut order = 0i64;
            for cat in &resp.categories {
                for group_name in &cat.groups {
                    if known_set.contains(group_name.as_str()) && seen.insert(group_name.clone()) {
                        hierarchy.push(CategorizedGroup {
                            group_name: group_name.clone(),
                            super_category: Some(cat.name.clone()),
                            sort_order: order,
                        });
                        order += 100;
                    }
                }
            }
            for name in &resp.ungrouped {
                if known_set.contains(name.as_str()) && seen.insert(name.clone()) {
                    ungrouped.push(name.clone());
                }
            }
        }
        "flat" => {
            let resp: FlatResponse = serde_json::from_value(json.clone())
                .map_err(|e| GeminiError::InvalidResponse(e.to_string()))?;

            let mut order = 0i64;
            for group_name in &resp.groups {
                if known_set.contains(group_name.as_str()) && seen.insert(group_name.clone()) {
                    hierarchy.push(CategorizedGroup {
                        group_name: group_name.clone(),
                        super_category: None,
                        sort_order: order,
                    });
                    order += 100;
                }
            }
            for name in &resp.ungrouped {
                if known_set.contains(name.as_str()) && seen.insert(name.clone()) {
                    ungrouped.push(name.clone());
                }
            }
        }
        other => {
            return Err(GeminiError::InvalidResponse(format!(
                "unknown type: {}",
                other
            )))
        }
    }

    // Add any known groups not mentioned in the response to ungrouped
    for name in known_groups {
        if !seen.contains(*name) {
            ungrouped.push(name.to_string());
        }
    }

    tracing::info!(
        categorized = hierarchy.len(),
        uncategorized = ungrouped.len(),
        "parsed categorization response"
    );

    Ok(CategorizationResult {
        hierarchy,
        ungrouped,
    })
}

/// Reads Gemini's placement of leftover groups into existing categories.
///
/// Assignments that name an unknown group or a category that doesn't exist are
/// dropped, because the model sometimes rewords names it was given.
pub fn parse_assignment_response(
    json: &serde_json::Value,
    known_groups: &[&str],
    existing_categories: &[&str],
) -> Result<Vec<GroupAssignment>, GeminiError> {
    let resp: AssignmentResponse = serde_json::from_value(json.clone())
        .map_err(|e| GeminiError::InvalidResponse(format!("invalid assignment response: {}", e)))?;

    let known_set: HashSet<&str> = known_groups.iter().copied().collect();
    let cat_set: HashSet<&str> = existing_categories.iter().copied().collect();

    tracing::info!(
        raw_assignments = resp.assignments.len(),
        known_groups = ?known_groups,
        existing_categories = ?existing_categories,
        "filtering assignment response"
    );

    let assignments: Vec<GroupAssignment> = resp
        .assignments
        .into_iter()
        .filter(|a| {
            let group_ok = known_set.contains(a.group.as_str());
            let cat_ok = cat_set.contains(a.category.as_str());
            if !group_ok || !cat_ok {
                tracing::warn!(
                    group = %a.group,
                    category = %a.category,
                    group_known = group_ok,
                    category_known = cat_ok,
                    "dropping assignment: name mismatch"
                );
            }
            group_ok && cat_ok
        })
        .map(|a| GroupAssignment {
            group_name: a.group,
            category: a.category,
        })
        .collect();

    tracing::info!(
        assigned = assignments.len(),
        total = known_groups.len(),
        "parsed assignment response"
    );

    Ok(assignments)
}

/// Builds the prompt that asks Gemini to sort a playlist's groups into
/// categories. A few channel names per group tell the model what each group
/// holds when its name alone doesn't.
pub fn build_categorization_prompt(
    content_type: &str,
    groups_with_samples: &[(&str, Vec<&str>)],
) -> String {
    let mut prompt = format!(
        "Organize these IPTV channel groups into a navigable hierarchy.\n\
         Content type: {}\n\n\
         Groups (with sample channels):\n",
        content_type
    );
    for (group_name, samples) in groups_with_samples {
        let sample_str = samples.join(", ");
        prompt.push_str(&format!("- \"{}\" → {}\n", group_name, sample_str));
    }
    prompt.push_str(
        "\nRules:\n\
         - You MUST assign EVERY group to a category. The \"ungrouped\" array should be EMPTY.\n\
         - Use geographic regions (e.g. \"Western Europe\", \"Nordic\", \"Latin America\", \"USA\") \
           for country-based groups.\n\
         - A standalone country name like \"Belgium\" or \"Norway\" MUST go into the appropriate \
           regional category (e.g. Belgium → Western Europe, Norway → Nordic).\n\
         - Groups with a country prefix (e.g. \"BR: Brazil Sports\", \"MX: Mexico News\") belong \
           in that country's or region's category.\n\
         - Groups mentioning a sport league or network (e.g. \"USA NBC Sports\", \"USA MILB\") \
           belong in either a sports category or a country category — pick the one that makes more \
           sense given the other groups.\n\
         - Create parent categories ONLY when they meaningfully reduce navigation complexity\n\
         - If groups are already well-organized, return them flat without parents\n\
         - Use clear, short category names\n\
         - Every group must appear exactly once\n\
         - Return JSON matching one of these two schemas:\n\n\
         Hierarchical (when parent categories are useful):\n\
         {\"type\": \"hierarchical\", \"categories\": [{\"name\": \"...\", \"groups\": [\"...\"]}], \"ungrouped\": []}\n\n\
         Flat (when groups stand on their own):\n\
         {\"type\": \"flat\", \"groups\": [\"...\"], \"ungrouped\": []}\n"
    );
    prompt
}

/// Builds the prompt for a playlist with no groups, which asks Gemini to make
/// groups from a sample of titles instead.
pub fn build_categorization_prompt_no_groups(content_type: &str, sample_titles: &[&str]) -> String {
    let mut prompt = format!(
        "Organize these IPTV content titles into navigable groups.\n\
         Content type: {}\n\n\
         Content titles (sample):\n",
        content_type
    );
    for title in sample_titles {
        prompt.push_str(&format!("- {}\n", title));
    }
    prompt.push_str(
        "\nRules:\n\
         - Create logical genre/theme groups from the titles\n\
         - Optionally create parent categories if the number of groups warrants it\n\
         - Use clear, short names\n\
         - Return JSON matching one of these two schemas:\n\n\
         Hierarchical (when parent categories are useful):\n\
         {\"type\": \"hierarchical\", \"categories\": [{\"name\": \"...\", \"groups\": [\"...\"]}], \"ungrouped\": []}\n\n\
         Flat (when groups stand on their own):\n\
         {\"type\": \"flat\", \"groups\": [\"...\"], \"ungrouped\": []}\n"
    );
    prompt
}

/// Builds the prompt for a second pass over groups the first pass left out.
/// Gemini may only use the categories it already made, so the layout the user
/// sees doesn't change.
pub fn build_fix_uncategorized_prompt(
    uncategorized_groups: &[(&str, Vec<&str>)],
    existing_categories: &[&str],
) -> String {
    let mut prompt = String::from(
        "You are assigning uncategorized IPTV channel groups to existing categories.\n\n\
         Existing categories:\n",
    );
    for cat in existing_categories {
        prompt.push_str(&format!("- \"{}\"\n", cat));
    }
    prompt.push_str("\nUncategorized groups (with sample channels):\n");
    for (group_name, samples) in uncategorized_groups {
        let sample_str = samples.join(", ");
        prompt.push_str(&format!("- \"{}\" → {}\n", group_name, sample_str));
    }
    prompt.push_str(
        "\nRules:\n\
         - Only assign a group if it CLEARLY belongs to one of the existing categories.\n\
         - Use geographic logic: country names go to their regional category.\n\
         - Use content logic: sports groups go to sports categories, news to news, etc.\n\
         - If a group does NOT clearly fit any category, OMIT it from the assignments.\n\
         - Do NOT force groups into categories just to avoid leaving them unassigned.\n\
         - Do NOT create new categories — only use the existing ones listed above.\n\
         - Return JSON: {\"assignments\": [{\"group\": \"exact group name\", \"category\": \"exact category name\"}, ...]}\n\
         - The assignments array may be empty if no groups fit, or contain fewer items than the input.\n"
    );
    prompt
}

/// Sends a prompt to Gemini and returns the JSON it answered with.
///
/// The request asks for a JSON reply, so text that doesn't parse is an error.
pub async fn call_gemini(api_key: &str, prompt: &str) -> Result<serde_json::Value, GeminiError> {
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    });

    tracing::info!(prompt_len = prompt.len(), "sending Gemini API request");
    // Prompts list every group name in the playlist, so they're logged only at
    // the debug level. The desktop app turns that level on for mvp-core.
    tracing::debug!(prompt = %prompt, "Gemini prompt");

    let response = generate_request(api_key, &body).send().await.map_err(|e| {
        let err = request_error(e);
        tracing::error!(error = %err, "Gemini API request failed");
        err
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::error!(status = %status, body = %text, "Gemini API returned error");
        return Err(GeminiError::Api(format!("HTTP {}: {}", status, text)));
    }

    let resp_json: serde_json::Value = response.json().await.map_err(|e| {
        let e = e.without_url();
        tracing::error!(error = %e, "failed to parse Gemini response as JSON");
        GeminiError::Parse(e.to_string())
    })?;

    let text = resp_json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .ok_or_else(|| {
            tracing::error!(response = %resp_json, "no text in Gemini response");
            GeminiError::Parse("no text in response".into())
        })?;

    tracing::debug!(response_text = %text, "Gemini API response text");

    let parsed: serde_json::Value = serde_json::from_str(text).map_err(|e| {
        tracing::error!(error = %e, raw_text = %text, "LLM returned invalid JSON");
        GeminiError::Parse(format!("LLM returned invalid JSON: {}", e))
    })?;

    tracing::info!("Gemini API call successful");
    Ok(parsed)
}

/// Checks a key by listing models, which is quicker and cheaper than a prompt.
/// Returns whether Google takes the key, or an error when the request fails or
/// the answer says nothing about the key.
pub async fn test_gemini_key(api_key: &str) -> Result<bool, GeminiError> {
    match list_models_request(api_key).send().await {
        Ok(response) => {
            let status = response.status();
            // Only a 400 needs its body, to tell a bad key from a bad request.
            let body = if status == reqwest::StatusCode::BAD_REQUEST {
                response.text().await.unwrap_or_default()
            } else {
                String::new()
            };
            key_accepted(status, &body)
        }
        // A key with characters a header can't carry is no real key.
        Err(e) if e.is_builder() => Ok(false),
        Err(e) => Err(request_error(e)),
    }
}

/// What a models list answer says about the key. Google turns down a key it
/// doesn't know with a 400 that gives API_KEY_INVALID as the reason, and a key
/// it won't serve with 401 or 403. A 429 or 402 means it knew the key and is
/// limiting it or wants payment. Any other answer, such as a 503 or a 400 for
/// another reason, is about the service or the request and not the key.
fn key_accepted(status: reqwest::StatusCode, body: &str) -> Result<bool, GeminiError> {
    use reqwest::StatusCode;
    match status {
        StatusCode::TOO_MANY_REQUESTS | StatusCode::PAYMENT_REQUIRED => Ok(true),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Ok(false),
        StatusCode::BAD_REQUEST if names_invalid_key(body) => Ok(false),
        _ if status.is_success() => Ok(true),
        _ => Err(GeminiError::Api(format!("Gemini answered {status}"))),
    }
}

/// Whether a Google error body gives API_KEY_INVALID as one of its reasons.
fn names_invalid_key(body: &str) -> bool {
    let Ok(body) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    body["error"]["details"]
        .as_array()
        .is_some_and(|details| details.iter().any(|d| d["reason"] == "API_KEY_INVALID"))
}

// Keys are pasted in, often with a trailing newline, and a header can't carry one.
fn generate_request(api_key: &str, body: &serde_json::Value) -> reqwest::RequestBuilder {
    crate::http::client()
        .post(format!("{API_BASE}/models/{MODEL}:generateContent"))
        .header(API_KEY_HEADER, api_key.trim())
        .json(body)
        .timeout(GENERATE_TIMEOUT)
}

fn list_models_request(api_key: &str) -> reqwest::RequestBuilder {
    crate::http::client()
        .get(format!("{API_BASE}/models"))
        .header(API_KEY_HEADER, api_key.trim())
}

// Request URLs can carry the API key, so they are dropped before the error can
// reach a log or the UI.
fn request_error(e: reqwest::Error) -> GeminiError {
    GeminiError::Api(e.without_url().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hierarchical_response() {
        let json = serde_json::json!({
            "type": "hierarchical",
            "categories": [
                { "name": "United States", "groups": ["US: Sports", "US: News"] },
                { "name": "United Kingdom", "groups": ["UK: Drama"] }
            ],
            "ungrouped": ["Misc"]
        });
        let result =
            parse_categorization_response(&json, &["US: Sports", "US: News", "UK: Drama", "Misc"])
                .unwrap();
        assert_eq!(result.hierarchy.len(), 3);
        assert_eq!(result.ungrouped, vec!["Misc"]);
        let sports = result
            .hierarchy
            .iter()
            .find(|h| h.group_name == "US: Sports")
            .unwrap();
        assert_eq!(sports.super_category.as_deref(), Some("United States"));
    }

    #[test]
    fn test_parse_flat_response() {
        let json = serde_json::json!({
            "type": "flat",
            "groups": ["Sports", "News", "Kids"],
            "ungrouped": []
        });
        let result = parse_categorization_response(&json, &["Sports", "News", "Kids"]).unwrap();
        assert_eq!(result.hierarchy.len(), 3);
        assert!(result.hierarchy.iter().all(|h| h.super_category.is_none()));
    }

    #[test]
    fn test_parse_drops_unknown_groups_adds_missing() {
        let json = serde_json::json!({
            "type": "flat",
            "groups": ["Sports", "FakeGroup"],
            "ungrouped": []
        });
        let known = &["Sports", "News"];
        let result = parse_categorization_response(&json, known).unwrap();
        assert!(!result.hierarchy.iter().any(|h| h.group_name == "FakeGroup"));
        assert!(result.ungrouped.contains(&"News".to_string()));
    }

    #[test]
    fn test_build_categorization_prompt_with_groups() {
        let groups_with_samples = vec![
            ("US: Sports", vec!["ESPN HD", "Fox Sports 1"]),
            ("UK: Drama", vec!["BBC One", "ITV"]),
        ];
        let prompt = build_categorization_prompt("live", &groups_with_samples);
        assert!(prompt.contains("Content type: live"));
        assert!(prompt.contains("US: Sports"));
        assert!(prompt.contains("ESPN HD"));
        assert!(prompt.contains(r#""type": "hierarchical""#));
        assert!(prompt.contains("You MUST assign EVERY group to a category"));
    }

    #[test]
    fn test_parse_assignment_response() {
        let json = serde_json::json!({
            "assignments": [
                { "group": "Belgium", "category": "Western Europe" },
                { "group": "Norway", "category": "Nordic" },
                { "group": "FakeGroup", "category": "Western Europe" }
            ]
        });
        let result =
            parse_assignment_response(&json, &["Belgium", "Norway"], &["Western Europe", "Nordic"])
                .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].group_name, "Belgium");
        assert_eq!(result[0].category, "Western Europe");
        assert_eq!(result[1].group_name, "Norway");
        assert_eq!(result[1].category, "Nordic");
    }

    #[test]
    fn test_build_fix_uncategorized_prompt() {
        let groups = vec![
            ("Belgium", vec!["VTM", "Canvas"]),
            ("Norway", vec!["NRK1", "TV2"]),
        ];
        let cats = vec!["Western Europe", "Nordic"];
        let prompt = build_fix_uncategorized_prompt(&groups, &cats);
        assert!(prompt.contains("Belgium"));
        assert!(prompt.contains("Western Europe"));
        assert!(prompt.contains("Only assign a group if it CLEARLY belongs"));
        assert!(prompt.contains("Do NOT create new categories"));
    }

    #[test]
    fn a_pasted_key_loses_its_surrounding_whitespace() {
        let list = list_models_request("  SECRET\n").build().unwrap();
        assert_eq!(list.headers()[API_KEY_HEADER], "SECRET");
    }

    /// Google's answer to a key it doesn't know, trimmed to what matters.
    const INVALID_KEY_BODY: &str = r#"{"error": {"code": 400,
        "message": "API key not valid. Please pass a valid API key.",
        "status": "INVALID_ARGUMENT",
        "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo",
            "reason": "API_KEY_INVALID", "domain": "googleapis.com"}]}}"#;

    #[test]
    fn the_models_list_status_says_whether_the_key_works() {
        use reqwest::StatusCode;
        for (code, accepted) in [
            (200, true),
            (402, true),
            (429, true),
            (401, false),
            (403, false),
        ] {
            let status = StatusCode::from_u16(code).unwrap();
            assert_eq!(key_accepted(status, "").unwrap(), accepted, "{code}");
        }
        for code in [404, 500, 503] {
            let status = StatusCode::from_u16(code).unwrap();
            let err = key_accepted(status, "").unwrap_err();
            assert!(err.to_string().contains(&code.to_string()), "{err}");
        }
    }

    #[test]
    fn a_400_turns_the_key_down_only_when_google_says_the_key_is_invalid() {
        use reqwest::StatusCode;
        assert!(!key_accepted(StatusCode::BAD_REQUEST, INVALID_KEY_BODY).unwrap());

        let other_reason = INVALID_KEY_BODY.replace("API_KEY_INVALID", "BAD_REQUEST_BODY");
        for body in ["", "not json", "{}", other_reason.as_str()] {
            let err = key_accepted(StatusCode::BAD_REQUEST, body).unwrap_err();
            assert!(err.to_string().contains("400"), "{body}: {err}");
        }
    }

    #[tokio::test]
    async fn a_key_no_header_can_carry_is_invalid() {
        // The bad character stops the request before it reaches the network.
        assert!(!test_gemini_key("SEC\nRET").await.unwrap());
    }

    #[test]
    fn request_errors_leave_out_the_request_url() {
        let err = request_error(crate::http::error_with_url(
            "unix:/v1beta/models?key=SECRET",
        ));
        assert!(!err.to_string().contains("SECRET"), "{err}");
        assert!(!format!("{err:?}").contains("SECRET"), "{err:?}");
    }

    #[test]
    fn the_api_key_goes_in_a_header() {
        let generate = generate_request("SECRET", &serde_json::json!({}))
            .build()
            .unwrap();
        assert_eq!(
            generate.url().as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
        );
        assert_eq!(generate.headers()[API_KEY_HEADER], "SECRET");
        assert_eq!(generate.timeout(), Some(&GENERATE_TIMEOUT));

        let list = list_models_request("SECRET").build().unwrap();
        assert_eq!(
            list.url().as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert_eq!(list.headers()[API_KEY_HEADER], "SECRET");
    }

    #[test]
    fn errors_keep_their_messages() {
        assert_eq!(GeminiError::Parse("x".into()).to_string(), "Parse error: x");
        assert_eq!(GeminiError::Api("x".into()).to_string(), "API error: x");
        assert_eq!(
            GeminiError::InvalidResponse("x".into()).to_string(),
            "Invalid response: x"
        );
    }
}
