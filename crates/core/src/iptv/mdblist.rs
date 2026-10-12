// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Ratings from MDBList, looked up by IMDb id.

use crate::json::number_or_string;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Enriched metadata returned by the MDBList API for a given IMDB ID.
/// All fields are optional because the API may omit or null any of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MdbListData {
    // Core metadata
    pub imdb_id: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub media_type: Option<String>, // "movie" or "show"

    // IMDb
    pub imdb_rating: Option<f64>,
    pub imdb_votes: Option<i64>,

    // Rotten Tomatoes critic
    pub tomatometer: Option<i32>,
    pub tomatometer_state: Option<String>,
    pub tomatometer_count: Option<i32>,

    // Rotten Tomatoes audience
    pub tomato_audience_score: Option<i32>,
    pub tomato_audience_count: Option<i32>,
    pub tomato_audience_state: Option<String>,

    // Metacritic
    pub metacritic_score: Option<i32>,
    pub metacritic_votes: Option<i32>,

    // TMDb
    pub tmdb_rating: Option<f64>,
    pub tmdb_votes: Option<i32>,

    // Trakt
    pub trakt_rating: Option<f64>,
    pub trakt_votes: Option<i32>,

    // Letterboxd / MDBList combined score
    pub letterboxd_rating: Option<f64>,
    pub mdblist_score: Option<i32>,
}

/// Errors from an MDBList lookup.
#[derive(Debug, Error)]
pub enum MdbListError {
    /// The request failed or the server answered with an error status.
    #[error("HTTP request failed: {0}")]
    Http(#[source] reqwest::Error),
    /// MDBList answered but reported an error, such as a bad key.
    #[error("MDBList API error: {0}")]
    Api(String),
    /// The response was not in the expected shape.
    #[error("Parse error: {0}")]
    Parse(String),
}

// Request URLs can carry API keys and logins, so they are dropped before the
// error can reach a log or the UI.
impl From<reqwest::Error> for MdbListError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e.without_url())
    }
}

/// Raw top-level MDBList API response (deserialization only).
#[derive(Debug, Deserialize)]
struct MdbListApiResponse {
    // Error shape: { "error": true, "message": "..." }
    error: Option<serde_json::Value>,
    message: Option<String>,

    imdbid: Option<String>,
    description: Option<String>,
    language: Option<String>,
    #[serde(rename = "type")]
    mediatype: Option<String>,
    imdbrating: Option<f64>,
    imdbvotes: Option<i64>,
    tomatometer: Option<i32>,
    tomatometerstate: Option<String>,
    tomatometercount: Option<i32>,
    tomatometeraudiencescore: Option<i32>,
    tomatometeraudiencecount: Option<i32>,
    tomatometeraudiencestate: Option<String>,
    score: Option<i32>,
    ratings: Option<Vec<MdbListRating>>,
}

/// One entry in the `ratings` array returned by MDBList.
#[derive(Debug, Deserialize)]
struct MdbListRating {
    source: String,
    score: Option<serde_json::Value>,
    votes: Option<serde_json::Value>,
}

/// Parse an MDBList JSON response (as `serde_json::Value`) into `MdbListData`.
/// Separated from the HTTP call so it can be unit-tested without network access.
pub fn parse_mdblist_response(json: serde_json::Value) -> Result<MdbListData, MdbListError> {
    let resp: MdbListApiResponse =
        serde_json::from_value(json).map_err(|e| MdbListError::Parse(e.to_string()))?;

    // Detect API-level errors. The error field may be a bool `true` or a string.
    let is_error = match &resp.error {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !s.is_empty() && s != "false",
        Some(_) => true,
        None => false,
    };
    if is_error {
        let msg = resp
            .message
            .unwrap_or_else(|| "Unknown MDBList error".into());
        return Err(MdbListError::Api(msg));
    }

    // Extract per-source ratings from the `ratings` array.
    let mut metacritic_score: Option<i32> = None;
    let mut metacritic_votes: Option<i32> = None;
    let mut tmdb_rating: Option<f64> = None;
    let mut tmdb_votes: Option<i32> = None;
    let mut trakt_rating: Option<f64> = None;
    let mut trakt_votes: Option<i32> = None;
    let mut letterboxd_rating: Option<f64> = None;

    if let Some(ratings) = resp.ratings {
        for r in ratings {
            match r.source.as_str() {
                "metacritic" => {
                    metacritic_score = r.score.as_ref().and_then(number_or_string::<i32>);
                    metacritic_votes = r.votes.as_ref().and_then(number_or_string::<i32>);
                }
                "tmdb" => {
                    tmdb_rating = r.score.as_ref().and_then(number_or_string::<f64>);
                    tmdb_votes = r.votes.as_ref().and_then(number_or_string::<i32>);
                }
                "trakt" => {
                    trakt_rating = r.score.as_ref().and_then(number_or_string::<f64>);
                    trakt_votes = r.votes.as_ref().and_then(number_or_string::<i32>);
                }
                "letterboxd" => {
                    letterboxd_rating = r.score.as_ref().and_then(number_or_string::<f64>);
                }
                _ => {}
            }
        }
    }

    Ok(MdbListData {
        imdb_id: resp.imdbid,
        description: resp.description,
        language: resp.language,
        media_type: resp.mediatype,
        imdb_rating: resp.imdbrating,
        imdb_votes: resp.imdbvotes,
        tomatometer: resp.tomatometer,
        tomatometer_state: resp.tomatometerstate,
        tomatometer_count: resp.tomatometercount,
        tomato_audience_score: resp.tomatometeraudiencescore,
        tomato_audience_count: resp.tomatometeraudiencecount,
        tomato_audience_state: resp.tomatometeraudiencestate,
        metacritic_score,
        metacritic_votes,
        tmdb_rating,
        tmdb_votes,
        trakt_rating,
        trakt_votes,
        letterboxd_rating,
        mdblist_score: resp.score,
    })
}

/// Fetch MDBList data for the given IMDB ID.
/// `media_type` should be `"movie"` or `"show"`.
pub async fn fetch_mdblist(
    imdb_id: &str,
    media_type: &str,
    api_key: &str,
) -> Result<MdbListData, MdbListError> {
    let response = lookup_request(imdb_id, media_type, api_key)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    parse_mdblist_response(response)
}

// Keys are pasted in, often with a trailing newline, which MDBList would reject.
fn lookup_request(imdb_id: &str, media_type: &str, api_key: &str) -> reqwest::RequestBuilder {
    crate::http::client()
        .get("https://mdblist.com/api/")
        .query(&[
            ("apikey", api_key.trim()),
            ("i", imdb_id),
            ("m", media_type),
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spaces_around_the_key_are_ignored() {
        let request = lookup_request("tt0468569", "movie", " KEY\n")
            .build()
            .unwrap();
        let key = request.url().query_pairs().find(|(k, _)| k == "apikey");
        assert_eq!(key.unwrap().1, "KEY");
    }

    fn full_response() -> serde_json::Value {
        json!({
            "imdbid": "tt0468569",
            "description": "When the menace known as the Joker wreaks havoc and chaos on the people of Gotham...",
            "language": "en",
            "type": "movie",
            "imdbrating": 9.0,
            "imdbvotes": 2844668_i64,
            "tomatometer": 94,
            "tomatometerstate": "certified-fresh",
            "tomatometercount": 364,
            "tomatometeraudiencescore": 94,
            "tomatometeraudiencecount": 1000000,
            "tomatometeraudiencestate": "upright",
            "score": 85,
            "ratings": [
                { "source": "metacritic", "score": 84, "votes": 47 },
                { "source": "tmdb",       "score": 90, "votes": 31000 },
                { "source": "trakt",      "score": 91, "votes": 50000 },
                { "source": "letterboxd", "score": 88, "votes": 0 }
            ]
        })
    }

    #[test]
    fn test_parse_full_response() {
        let data = parse_mdblist_response(full_response()).unwrap();

        assert_eq!(data.imdb_id.as_deref(), Some("tt0468569"));
        assert!(data.description.is_some());
        assert_eq!(data.language.as_deref(), Some("en"));
        assert_eq!(data.media_type.as_deref(), Some("movie"));

        assert_eq!(data.imdb_rating, Some(9.0));
        assert_eq!(data.imdb_votes, Some(2_844_668));

        assert_eq!(data.tomatometer, Some(94));
        assert_eq!(data.tomatometer_state.as_deref(), Some("certified-fresh"));
        assert_eq!(data.tomatometer_count, Some(364));

        assert_eq!(data.tomato_audience_score, Some(94));
        assert_eq!(data.tomato_audience_count, Some(1_000_000));
        assert_eq!(data.tomato_audience_state.as_deref(), Some("upright"));

        assert_eq!(data.mdblist_score, Some(85));
    }

    #[test]
    fn test_parse_missing_optional_fields() {
        let response = json!({});
        let data = parse_mdblist_response(response).unwrap();

        assert!(data.imdb_id.is_none());
        assert!(data.description.is_none());
        assert!(data.language.is_none());
        assert!(data.media_type.is_none());
        assert!(data.imdb_rating.is_none());
        assert!(data.imdb_votes.is_none());
        assert!(data.tomatometer.is_none());
        assert!(data.tomatometer_state.is_none());
        assert!(data.tomatometer_count.is_none());
        assert!(data.tomato_audience_score.is_none());
        assert!(data.tomato_audience_count.is_none());
        assert!(data.tomato_audience_state.is_none());
        assert!(data.metacritic_score.is_none());
        assert!(data.metacritic_votes.is_none());
        assert!(data.tmdb_rating.is_none());
        assert!(data.tmdb_votes.is_none());
        assert!(data.trakt_rating.is_none());
        assert!(data.trakt_votes.is_none());
        assert!(data.letterboxd_rating.is_none());
        assert!(data.mdblist_score.is_none());
    }

    #[test]
    fn test_parse_ratings_array() {
        let data = parse_mdblist_response(full_response()).unwrap();

        assert_eq!(data.metacritic_score, Some(84));
        assert_eq!(data.metacritic_votes, Some(47));

        assert_eq!(data.tmdb_rating, Some(90.0));
        assert_eq!(data.tmdb_votes, Some(31_000));

        assert_eq!(data.trakt_rating, Some(91.0));
        assert_eq!(data.trakt_votes, Some(50_000));

        assert_eq!(data.letterboxd_rating, Some(88.0));
    }

    #[test]
    fn test_api_error_response() {
        let response = json!({
            "error": true,
            "message": "Invalid API key"
        });
        let err = parse_mdblist_response(response).unwrap_err();
        assert!(matches!(err, MdbListError::Api(_)));
        assert!(err.to_string().contains("Invalid API key"));
    }

    #[test]
    fn test_api_error_without_message() {
        let response = json!({ "error": true });
        let err = parse_mdblist_response(response).unwrap_err();
        assert!(matches!(err, MdbListError::Api(_)));
    }

    #[test]
    fn test_mdblist_data_serializes_to_camel_case() {
        let data = MdbListData {
            imdb_id: Some("tt0468569".into()),
            description: None,
            language: None,
            media_type: None,
            imdb_rating: Some(9.0),
            imdb_votes: Some(2_844_668),
            tomatometer: None,
            tomatometer_state: None,
            tomatometer_count: None,
            tomato_audience_score: None,
            tomato_audience_count: None,
            tomato_audience_state: None,
            metacritic_score: None,
            metacritic_votes: None,
            tmdb_rating: None,
            tmdb_votes: None,
            trakt_rating: None,
            trakt_votes: None,
            letterboxd_rating: None,
            mdblist_score: None,
        };
        let json_str = serde_json::to_string(&data).unwrap();
        assert!(json_str.contains("\"imdbId\""));
        assert!(json_str.contains("\"imdbRating\""));
        assert!(json_str.contains("\"imdbVotes\""));
        assert!(json_str.contains("\"mdblistScore\""));
    }

    #[test]
    fn test_unknown_rating_sources_ignored() {
        let response = json!({
            "ratings": [
                { "source": "some_unknown_source", "score": 77, "votes": 100 }
            ]
        });
        let data = parse_mdblist_response(response).unwrap();
        assert!(data.metacritic_score.is_none());
        assert!(data.tmdb_rating.is_none());
        assert!(data.trakt_rating.is_none());
        assert!(data.letterboxd_rating.is_none());
    }

    #[test]
    fn http_errors_leave_out_the_request_url() {
        let err = MdbListError::from(crate::http::error_with_url("unix:/api/?apikey=SECRET"));
        assert!(!err.to_string().contains("SECRET"), "{err}");
        assert!(!format!("{err:?}").contains("SECRET"), "{err:?}");
    }
}
